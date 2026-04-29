import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createImportBackend } from "./import-connector.js";

const tmpDir = path.join(os.tmpdir(), "guardrails-import-test-" + process.pid);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function writeScript(name: string, code: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, code, "utf-8");
  return p;
}

describe("import-connector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
  });

  function setup() {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  it("loads a module and calls check()", async () => {
    setup();
    const script = writeScript(
      "checker.ts",
      `
      export async function check(text, context, args) {
        return { action: text === "bad" ? "block" : "pass" };
      }
      `,
    );
    const handle = await createImportBackend(script, {}, false, 300, logger);
    try {
      const r1 = await handle.backendFn("hello", {});
      expect(r1.action).toBe("pass");
      const r2 = await handle.backendFn("bad", {});
      expect(r2.action).toBe("block");
    } finally {
      handle.dispose();
    }
  });

  it("passes args as third parameter", async () => {
    setup();
    const script = writeScript(
      "checker-args.ts",
      `
      export async function check(text, context, args) {
        return { action: args.shouldBlock ? "block" : "pass" };
      }
      `,
    );
    const handle = await createImportBackend(script, { shouldBlock: true }, false, 300, logger);
    try {
      const result = await handle.backendFn("any", {});
      expect(result.action).toBe("block");
    } finally {
      handle.dispose();
    }
  });

  it("calls init(args) if exported", async () => {
    setup();
    const script = writeScript(
      "checker-init.ts",
      `
      let mode = "pass";
      export function init(args) { mode = args.mode; }
      export async function check(text, context, args) {
        return { action: mode };
      }
      `,
    );
    const handle = await createImportBackend(script, { mode: "block" }, false, 300, logger);
    try {
      const result = await handle.backendFn("any", {});
      expect(result.action).toBe("block");
    } finally {
      handle.dispose();
    }
  });

  it("supports default export with check", async () => {
    setup();
    const script = writeScript(
      "checker-default.ts",
      `
      export default {
        async check(text, context, args) {
          return { action: "block", blockMessage: "blocked by default export" };
        }
      };
      `,
    );
    const handle = await createImportBackend(script, {}, false, 300, logger);
    try {
      const result = await handle.backendFn("any", {});
      expect(result.action).toBe("block");
      expect(result.blockMessage).toBe("blocked by default export");
    } finally {
      handle.dispose();
    }
  });

  it("throws if no check function exported", async () => {
    setup();
    const script = writeScript("no-check.ts", `export const name = "hello";`);
    await expect(createImportBackend(script, {}, false, 300, logger)).rejects.toThrow(
      'must export a "check" function',
    );
  });

  it("reload: picks up new module version", async () => {
    setup();
    const script = writeScript(
      "hot-checker.ts",
      `
      export async function check(text, context, args) {
        return { action: "pass" };
      }
      `,
    );
    const handle = await createImportBackend(script, {}, false, 300, logger);
    try {
      expect((await handle.backendFn("x", {})).action).toBe("pass");

      fs.writeFileSync(
        script,
        `
        export async function check(text, context, args) {
          return { action: "block", blockMessage: "v2" };
        }
        `,
        "utf-8",
      );

      await handle.reload();

      const result = await handle.backendFn("x", {});
      expect(result.action).toBe("block");
      expect(result.blockMessage).toBe("v2");
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("hot-reloaded"));
    } finally {
      handle.dispose();
    }
  });

  it("reload: keeps old version on failure", async () => {
    setup();
    const script = writeScript(
      "hot-fail.ts",
      `
      export async function check(text, context, args) {
        return { action: "pass" };
      }
      `,
    );
    const handle = await createImportBackend(script, {}, false, 300, logger);
    try {
      expect((await handle.backendFn("x", {})).action).toBe("pass");

      fs.writeFileSync(script, `this is not valid javascript {{{`, "utf-8");

      await handle.reload();

      expect((await handle.backendFn("x", {})).action).toBe("pass");
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("hot-reload failed"));
    } finally {
      handle.dispose();
    }
  });

  it("dispose closes watcher", async () => {
    setup();
    const script = writeScript(
      "dispose-test.ts",
      `export async function check() { return { action: "pass" }; }`,
    );
    const handle = await createImportBackend(script, {}, true, 50, logger);
    handle.dispose();
    handle.dispose(); // double dispose should not throw
  });
});
