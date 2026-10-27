import { build } from "esbuild";
import { chromium } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resolvePlaywrightChromiumExecutablePath } from "../../ui/src/test-helpers/control-ui-e2e.ts";

let browser: Awaited<ReturnType<typeof chromium.launch>>;
beforeAll(async () => {
  browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    headless: true,
  });
});
afterAll(async () => browser?.close());

function probe(name: string, contents: string, value: unknown, alive = [false, false, false]) {
  it.each(["production", "development", "observe"])(`%s ${name}`, async (mode) => {
    const output = await build({
      stdin: {
        contents: `let references = [];
        ${contents}
        window.retentionProbe = { retire, alive: () => references.map(ref => !!ref.deref()) };`,
        resolveDir: new URL("../../ui", import.meta.url).pathname,
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      conditions: ["browser", ...(mode === "production" ? [] : [mode])],
      minify: mode === "production",
    });
    // Fresh runtime per probe: warming the first-select hook hides its leak.
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    try {
      await page.addScriptTag({ content: output.outputFiles[0]!.text });
      const result: unknown = await page.evaluate("retentionProbe.retire()");
      await cdp.send("HeapProfiler.collectGarbage");
      await cdp.send("HeapProfiler.collectGarbage");
      const collected: unknown = await page.evaluate("retentionProbe.alive()");
      expect({ value: result, alive: collected }).toEqual({ value, alive });
    } finally {
      await cdp.detach();
      await page.close();
    }
  });
}

probe(
  "releases the first value-bound select and its form",
  `
      import { render, setProperty, insert } from "@solidjs/web";
      async function retire() {
        const host = document.createElement("div");
        document.body.append(host);
        const form = document.createElement("form");
        const select = document.createElement("select");
        form.append(select);
        const dispose = render(() => {
          setProperty(select, "value", "second");
          insert(select, [new Option("First", "first"), new Option("Second", "second")]);
          return form;
        }, host);
        await Promise.resolve();
        const selected = select.value;
        references = [new WeakRef(select), new WeakRef(form), new WeakRef({ control: true })];
        dispose();
        host.remove();
        return selected;
      }
    `,
  "second",
);

function idleProbe(name: string, rejectSource: boolean) {
  probe(
    name,
    `
      import { createMemo, createRoot, flush, getOwner } from "solid-js";
      const source = ${rejectSource} && createRoot(() => {
        let reject;
        const read = createMemo(() => new Promise((_, fail) => { reject = fail; }), { loadingValue: "ready" });
        return { read, reject };
      });
      async function retire() {
        const payload = { pending: true };
        let started = false;
        const dispose = createRoot(dispose => {
          references = [new WeakRef(payload), new WeakRef(getOwner()), new WeakRef({ control: true })];
          createMemo(source ? () => {
            started = true;
            source.read();
            return payload;
          } : async () => {
            started = true;
            await new Promise(() => {});
            return payload;
          });
          return dispose;
        });
        if (source) {
          flush();
          source.reject(new Error("idle rejection"));
          await Promise.resolve();
        }
        dispose();
        return started;
      }
    `,
    true,
  );
}
idleProbe("releases an unobserved pending computation after root disposal while idle", false);
idleProbe("releases a reader queued by an idle rejection in another root", true);

probe(
  "cleans up the committed frame when its async replacement rejects",
  `
      import { createMemo, createRoot, createSignal, flush, onCleanup, resolve } from "solid-js";
      const retire = () => createRoot(async dispose => {
          let cleanups = 0;
          const [revision, setRevision] = createSignal(0);
          const read = createMemo(() => {
            if (revision()) return Promise.reject(new Error("replacement rejected"));
            onCleanup(() => { cleanups++; });
            return Promise.resolve("ready");
          });
          try {
            await resolve(read);
            setRevision(1);
            flush();
            await resolve(read).catch(() => {});
            return cleanups;
          } finally {
            dispose();
          }
      });
    `,
  1,
  [],
);
