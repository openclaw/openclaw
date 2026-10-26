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

function probe(name: string, contents: string, value: unknown, collected?: string) {
  it.each(["production", "development", "observe"])(`%s ${name}`, async (mode) => {
    const output = await build({
      stdin: {
        contents: `
        let references;
        ${contents}
        window.retentionProbe = { retire, alive: () => references.map(ref => !!ref.deref()) };
      `,
        resolveDir: new URL("../../ui", import.meta.url).pathname,
        sourcefile: "dependency-retention-probe.js",
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
      const alive: unknown = await page.evaluate("retentionProbe.alive()");
      expect(result).toBe(value);
      if (collected) {
        expect(alive, collected).toEqual([false, false, false]);
      }
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
  "select, form, GC control",
);

probe(
  "releases an unobserved pending computation after root disposal while idle",
  `
      import { createMemo, createRoot, getOwner } from "solid-js";
      function retire() {
        const payload = { pending: true };
        let started = false;
        const dispose = createRoot(dispose => {
          references = [new WeakRef(payload), new WeakRef(getOwner()), new WeakRef({ control: true })];
          createMemo(async () => {
            started = true;
            await new Promise(() => {});
            return payload;
          });
          return dispose;
        });
        dispose();
        return started;
      }
    `,
  true,
  "payload, root, GC control",
);

probe(
  "releases a reader queued by an idle rejection in another root",
  `
      import { createMemo, createRoot, flush, getOwner } from "solid-js";
      const source = createRoot(dispose => {
        let reject;
        const read = createMemo(() => new Promise((_, fail) => { reject = fail; }), {
          loadingValue: "ready"
        });
        return { read, reject, dispose };
      });
      async function retire() {
        const payload = { pending: true };
        const dispose = createRoot(dispose => {
          references = [new WeakRef(payload), new WeakRef(getOwner()), new WeakRef({ control: true })];
          createMemo(() => { source.read(); return payload; });
          return dispose;
        });
        flush();
        source.reject(new Error("idle rejection"));
        await Promise.resolve();
        dispose();
        return true;
      }
    `,
  true,
  "payload, reader root, GC control",
);

probe(
  "cleans up the committed frame when its async replacement rejects",
  `
      import { createMemo, createRoot, createSignal, flush, onCleanup, resolve } from "solid-js";
      async function retire() {
        let cleanups = 0;
        const root = createRoot(dispose => {
          const [revision, setRevision] = createSignal(0);
          const read = createMemo(() => {
            if (revision()) return Promise.reject(new Error("replacement rejected"));
            onCleanup(() => { cleanups++; });
            return Promise.resolve("ready");
          });
          return { read, setRevision, dispose };
        });
        try {
          await resolve(root.read);
          root.setRevision(1);
          flush();
          await resolve(root.read).catch(() => {});
          references = [];
          return cleanups;
        } finally {
          root.dispose();
        }
      }
    `,
  1,
);
