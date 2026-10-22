import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
  withinTest,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return { ...actual, runCommandBuffered: vi.fn(actual.runCommandBuffered) };
});
const { runCommandBuffered: runProcess } = await vi.importActual<
  typeof import("openclaw/plugin-sdk/process-runtime")
>("openclaw/plugin-sdk/process-runtime");
const { request, response: owned } = windowsFixture();
const missing = { ...owned, registration: "missing", mode: null, installation: null };
const framed = (value: unknown, suffix = "\n") => Buffer.from(JSON.stringify(value) + suffix);
const responseScript = (value: unknown, exitCode = 0) =>
  `process.stdout.write(${JSON.stringify(framed(value).toString())}); process.exitCode=${exitCode};`;
const runManagement = (signal?: AbortSignal) =>
  runWindowsManagement("fixture.exe", request, { signal });
describe("accepted Windows management ABI", () => {
  const invalidJson = ['{"v":1,"\\u0076":1}', '{"v":1.0}', '{"v":1,"x":"\\ud800"}'];
  it.each(invalidJson)("rejects ambiguous JSON %s", (json) => {
    expect(() => parseWindowsJson(Buffer.from(json))).toThrow();
  });
  it("enforces exact byte bounds, UTF-8 and LF-inclusive response framing", () => {
    const json = JSON.stringify(request);
    const padded = (size: number) => Buffer.from(json + " ".repeat(size - Buffer.byteLength(json)));
    expect(parseWindowsJson(padded(32768))).toEqual(request);
    expect(() => parseWindowsJson(padded(32769))).toThrow();
    for (const bytes of [Buffer.from([239, 187, 191, 123, 125]), Buffer.from([192, 175])]) {
      expect(() => parseWindowsJson(bytes)).toThrow();
    }
    const parse = (suffix = "\n", code = 0) =>
      parseWindowsManagementResponse(framed(missing, suffix), code, request);
    expect(parse()).toEqual(missing);
    for (const suffix of ["", "\r\n", "\n\n", "\n{}"]) {
      expect(() => parse(suffix)).toThrow();
    }
    expect(() => parse("\n", 1)).toThrow();
  });
  it.each([
    [{ action: "inspect", store: "request" }, false],
    [{ action: "inspect", store: "remove" }, false],
    [{ action: "install", store: "remove" }, false],
    [{ action: "install", store: "request" }, true],
    [{ action: "uninstall", store: "request" }, false],
    [{ mode: "companion-managed-wsl", context: null }, true],
    [{ mode: "companion-managed-wsl" }, false],
    [{ expectedOrigins: [WINDOWS_OFFICIAL_ORIGIN, WINDOWS_OFFICIAL_ORIGIN] }, false],
  ] as const)("validates management request %j as %s", (overrides, success) => {
    expect(managementRequestSchema.safeParse({ ...request, ...overrides }).success).toBe(success);
  });
  it("accepts truthful partial failures and rejects disabled/unknown invented inventory", () => {
    const install: typeof request = { ...request, action: "install", store: "request" };
    const partial = { ...owned, ok: false, code: "browser_control_disabled" };
    const parse = (response: unknown) =>
      parseWindowsManagementResponse(framed(response), 1, install);
    expect(parse(partial)).toEqual(partial);
    for (const store of ["disabled", "unknown"]) {
      expect(() => parse({ ...partial, store })).toThrow();
    }
    expect(() => parse({ ...owned, code: "context_conflict", ok: false })).toThrow();
  });
});
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(() => receipts.close());
const directories: string[] = [];
async function makeDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manage-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  vi.mocked(runCommandBuffered).mockReset();
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
describe("real child-process management transport (not Windows PE proof)", () => {
  async function child(body: string) {
    const script = path.join(await makeDirectory(), "helper.mjs");
    await fs.writeFile(script, body);
    const runner: typeof runCommandBuffered = (argv, options) => {
      expect(argv.slice(1)).toEqual(["--manage"]);
      return runProcess([process.execPath, script, ...argv.slice(1)], options);
    };
    return vi.mocked(runCommandBuffered).mockImplementation(runner);
  }
  it("sends exactly --manage, closes stdin at EOF and accepts a bounded typed failure on exit1", async () => {
    const response = { ...missing, ok: false, code: "busy", registration: null, store: null };
    await child(
      'let input=""; for await (const chunk of process.stdin) input+=chunk; JSON.parse(input); if(process.argv[2]!=="--manage")process.exit(2);' +
        responseScript(response, 1),
    );
    expect(await runManagement()).toEqual(response);
  });
  it.each([
    ["stderr", 'process.stderr.write("private error");' + responseScript(missing)],
    ["overflow", 'process.stdout.write("x".repeat(32769));'],
    ["exit-mismatch", responseScript(missing, 1)],
  ])("rejects %s without any retry", async (_kind, body) => {
    const run = await child(body);
    await expect(runManagement()).rejects.toThrow(WindowsManagementTransportError);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("joins cancellation after the real child has consumed management EOF", async ({ signal }) => {
    const controller = new AbortController();
    const ready = path.join(await makeDirectory(), "ready");
    const encodedReady = JSON.stringify(ready);
    await child(
      fixtureReceiptClientSource(receipts.endpoint) +
        `\nimport fs from "node:fs"; for await (const chunk of process.stdin) {} fs.writeFileSync(${encodedReady}, "ready"); sendReceipt(${encodedReady}, "ready"); setInterval(()=>{},1000);`,
    );
    const result = runManagement(controller.signal);
    const rejected = expect(result).rejects.toThrow("outcome is unknown");
    try {
      // The durable marker precedes the receipt; process settlement may overtake socket delivery.
      const confirmReady = async () => expect(await fs.readFile(ready, "utf8")).toBe("ready");
      await withinTest(
        Promise.race([receipts.waitFor(ready, "ready"), result.then(confirmReady, confirmReady)]),
        signal,
      );
      await confirmReady();
    } finally {
      controller.abort();
      await rejected;
    }
  });
});
