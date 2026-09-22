import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  managementRequestSchema,
  parseWindowsJson,
  parseWindowsManagementResponse,
  WINDOWS_OFFICIAL_ORIGIN,
} from "./extension-windows-contract.js";
import {
  runWindowsManagement,
  WindowsManagementTransportError,
} from "./extension-windows-management.js";
import { windowsFixture } from "./extension-windows.test-support.js";
const missing = {
  v: 1,
  ok: true,
  code: "ok",
  registration: "missing",
  mode: null,
  store: "missing",
  installation: null,
};
describe("accepted Windows management ABI", () => {
  it.each([
    '{"v":1,"v":1}',
    '{"v":1,"\\u0076":1}',
    '{"v":1,"context":{"x":1,"x":1}}',
    '{"v":1.0}',
    '{"v":1e0}',
    '{"v":1,"x":"\\ud800"}',
  ])("rejects ambiguous JSON %s", (json) => {
    expect(() => parseWindowsJson(Buffer.from(json))).toThrow();
  });
  it("enforces exact byte bounds, UTF-8 and LF-inclusive response framing", () => {
    const request = windowsFixture().request;
    const json = JSON.stringify(request);
    expect(
      parseWindowsJson(Buffer.from(json + " ".repeat(32768 - Buffer.byteLength(json)))),
    ).toEqual(request);
    expect(() =>
      parseWindowsJson(Buffer.from(json + " ".repeat(32769 - Buffer.byteLength(json)))),
    ).toThrow();
    for (const bytes of [Buffer.from([239, 187, 191, 123, 125]), Buffer.from([192, 175])]) {
      expect(() => parseWindowsJson(bytes)).toThrow();
    }
    expect(
      parseWindowsManagementResponse(Buffer.from(JSON.stringify(missing) + "\n"), 0, request),
    ).toEqual(missing);
    for (const suffix of ["", "\r\n", "\n\n", "\n{}"]) {
      expect(() =>
        parseWindowsManagementResponse(Buffer.from(JSON.stringify(missing) + suffix), 0, request),
      ).toThrow();
    }
    expect(() =>
      parseWindowsManagementResponse(Buffer.from(JSON.stringify(missing) + "\n"), 1, request),
    ).toThrow();
  });
  it("enforces action/Store and discriminated context rules", () => {
    const { request } = windowsFixture();
    for (const [action, store] of [
      ["inspect", "request"],
      ["inspect", "remove"],
      ["install", "remove"],
      ["uninstall", "request"],
    ]) {
      expect(managementRequestSchema.safeParse({ ...request, action, store }).success).toBe(false);
    }
    expect(
      managementRequestSchema.safeParse({
        ...request,
        mode: "companion-managed-wsl",
        context: null,
      }).success,
    ).toBe(true);
    expect(
      managementRequestSchema.safeParse({ ...request, mode: "companion-managed-wsl" }).success,
    ).toBe(false);
    expect(
      managementRequestSchema.safeParse({
        ...request,
        expectedOrigins: [WINDOWS_OFFICIAL_ORIGIN, WINDOWS_OFFICIAL_ORIGIN],
      }).success,
    ).toBe(false);
  });
  it("accepts truthful partial failures and rejects disabled/unknown invented inventory", () => {
    const f = windowsFixture();
    const request = managementRequestSchema.parse({
      ...f.request,
      action: "install",
      store: "request",
    });
    const partial = { ...f.response, ok: false, code: "browser_control_disabled" };
    expect(
      parseWindowsManagementResponse(Buffer.from(JSON.stringify(partial) + "\n"), 1, request),
    ).toEqual(partial);
    for (const store of ["disabled", "unknown"]) {
      expect(() =>
        parseWindowsManagementResponse(
          Buffer.from(JSON.stringify({ ...partial, store }) + "\n"),
          1,
          request,
        ),
      ).toThrow();
    }
    expect(() =>
      parseWindowsManagementResponse(
        Buffer.from(JSON.stringify({ ...f.response, code: "context_conflict", ok: false }) + "\n"),
        1,
        request,
      ),
    ).toThrow();
  });
});
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
describe("real child-process management transport (not Windows PE proof)", () => {
  async function child(body: string) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manage-"));
    directories.push(directory);
    const script = path.join(directory, "helper.mjs");
    await fs.writeFile(script, body);
    const runner: typeof runCommandBuffered = (argv, options) => {
      expect(argv.slice(1)).toEqual(["--manage"]);
      return runCommandBuffered([process.execPath, script, ...argv.slice(1)], options);
    };
    return runner;
  }
  it("sends exactly --manage, closes stdin at EOF and accepts a bounded typed failure on exit1", async () => {
    const response = { ...missing, ok: false, code: "busy", registration: null, store: null };
    const run = await child(
      'let input=""; for await (const chunk of process.stdin) input+=chunk; JSON.parse(input); if(process.argv[2]!=="--manage")process.exit(2); process.stdout.write(' +
        JSON.stringify(JSON.stringify(response) + "\n") +
        "); process.exitCode=1;",
    );
    expect(await runWindowsManagement("fixture.exe", windowsFixture().request, { run })).toEqual(
      response,
    );
  });
  it.each(["stderr", "overflow", "exit-mismatch", "legacy"])(
    "rejects %s without any retry",
    async (kind) => {
      const body =
        kind === "stderr"
          ? 'process.stderr.write("private error"); process.stdout.write(' +
            JSON.stringify(JSON.stringify(missing) + "\n") +
            ");"
          : kind === "overflow"
            ? 'process.stdout.write("x".repeat(32769));'
            : kind === "legacy"
              ? "process.stdout.write(Buffer.from([4,0,0,0,123,125]));"
              : "process.stdout.write(" +
                JSON.stringify(JSON.stringify(missing) + "\n") +
                "); process.exitCode=1;";
      const run = vi.fn(await child(body));
      await expect(
        runWindowsManagement("fixture.exe", windowsFixture().request, { run }),
      ).rejects.toThrow(WindowsManagementTransportError);
      expect(run).toHaveBeenCalledTimes(1);
    },
  );
  it("joins cancellation after the real child has consumed management EOF", async () => {
    const controller = new AbortController();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manage-ready-"));
    directories.push(directory);
    const ready = path.join(directory, "ready");
    const run = await child(
      'import fs from "node:fs"; for await (const chunk of process.stdin) {} fs.writeFileSync(' +
        JSON.stringify(ready) +
        ', "ready"); setInterval(()=>{},1000);',
    );
    const result = runWindowsManagement("fixture.exe", windowsFixture().request, {
      run,
      signal: controller.signal,
    });
    const rejected = expect(result).rejects.toThrow("outcome is unknown");
    try {
      await vi.waitFor(async () => expect(await fs.readFile(ready, "utf8")).toBe("ready"));
    } finally {
      controller.abort();
    }
    await rejected;
  });
});
