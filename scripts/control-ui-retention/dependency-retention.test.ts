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

async function collectProbe(mode: string, contents: string) {
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
    const value: unknown = await page.evaluate("retentionProbe.retire()");
    await cdp.send("HeapProfiler.collectGarbage");
    await cdp.send("HeapProfiler.collectGarbage");
    const alive: unknown = await page.evaluate("retentionProbe.alive()");
    return { value, alive };
  } finally {
    await cdp.detach();
    await page.close();
  }
}

it.each(["production", "development", "observe"])(
  "%s releases the first value-bound select and its form",
  async (mode) => {
    const result = await collectProbe(
      mode,
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
    );
    expect(result.value, "late option selection").toBe("second");
    expect(result.alive, "select, form, GC control").toEqual([false, false, false]);
  },
);

it.each(["production", "development", "observe"])(
  "%s releases an unobserved pending computation after root disposal while idle",
  async (mode) => {
    const result = await collectProbe(
      mode,
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
    );
    expect(result.value, "pending computation started").toBe(true);
    expect(result.alive, "payload, root, GC control").toEqual([false, false, false]);
  },
);

it.each(["production", "development", "observe"])(
  "%s releases a reader queued by an idle rejection in another root",
  async (mode) => {
    const result = await collectProbe(
      mode,
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
    );
    expect(result.value, "reader disposed after source rejection").toBe(true);
    expect(result.alive, "payload, reader root, GC control").toEqual([false, false, false]);
  },
);

it.each(["production", "development", "observe"])(
  "%s cleans up the committed frame when its async replacement rejects",
  async (mode) => {
    const result = await collectProbe(
      mode,
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
    );
    expect(result.value, "previous committed run cleaned up at rejection").toBe(1);
  },
);
