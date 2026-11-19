import { beforeEach, expect, it, vi } from "vitest";
import * as shared from "../browser-cli-shared.js";
import {
  createBrowserProgram,
  mockBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} from "../browser-cli.test-support.js";

const request = vi.spyOn(shared, "callBrowserRequest").mockResolvedValue({ result: true });
mockBrowserCliRuntime();

const { registerBrowserActionInputCommands } = await import("./register.js");

function run(...args: string[]) {
  const { program, browser, parentOpts } = createBrowserProgram();
  registerBrowserActionInputCommands(browser, parentOpts);
  return program.parseAsync(["browser", ...args], { from: "user" });
}

const lastCall = () => request.mock.calls.at(-1);
const capture = getBrowserCliRuntimeCapture();
beforeEach(() => {
  vi.clearAllMocks();
  capture.resetRuntimeCapture();
});

it.each([
  [["click", "   "], "ref is required"],
  [["type", "   ", "synthetic"], "ref is required"],
  [["scrollintoview", "   "], "ref is required"],
  [["click-coords", "0x10", "20"], "Invalid x: must be a finite number"],
  [["click-coords", "10", "NaN"], "Invalid y: must be a finite number"],
  [["dialog", "--accept", "--dismiss"], "Specify only one of --accept or --dismiss"],
  [["dialog"], "Specify --accept or --dismiss"],
  [["evaluate"], "Missing --fn"],
  [
    ["batch", "--actions", "[]", "--actions-file", "never-read.json"],
    "Specify only one of --actions or --actions-file",
  ],
  [["batch"], "Provide --actions, --actions-file, or --actions-file -"],
] satisfies [string[], string][])("rejects %j in JSON mode", async (args, message) => {
  await expect(run("--json", ...args)).rejects.toThrow(message);
  expect(capture.runtimeErrors).toEqual([]);
  expect(capture.defaultRuntime.writeJson).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it("sends normalized fill fields and target id to the act route", async () => {
  await run(
    "fill",
    '--fields=[{"ref":"name","value":"Ada"},{"ref":"enabled","value":true},{"ref":"omitted"},{"ref":"null","value":null},{"ref":"empty","value":""}]',
    "--target-id=tab-1",
  );

  expect(lastCall()?.[1].body).toMatchObject({
    kind: "fill",
    fields: [
      { ref: "name", type: "text", value: "Ada" },
      { ref: "enabled", type: "text", value: true },
      { ref: "omitted", type: "text" },
      { ref: "null", type: "text" },
      { ref: "empty", type: "text", value: "" },
    ],
    targetId: "tab-1",
  });
  expect(lastCall()?.[2]).toEqual({ timeoutMs: 126_250 });
});

it.each([
  [["fill", "--fields", "NOT JSON {{{"], "fields must be valid JSON."],
  [
    ["fill", "--fields", '[{"ref":"name"},{"ref":"enabled","text":"unsupported"}]'],
    'fields[1] unsupported field key "text"',
  ],
  [
    ["fill", "--fields=[]", "--fields-file=/tmp/browser-fields.json"],
    "Specify only one of --fields or --fields-file",
  ],
  [["wait", "--load=complete"], "Invalid --load value: complete"],
] satisfies [string[], string][])("rejects %j before dispatch", async (args, message) => {
  await expect(run(...args)).rejects.toThrow("__exit__:1");
  expect(capture.runtimeErrors.join("\n")).toContain(message);
  expect(request).not.toHaveBeenCalled();
});

it("keeps the outer request open longer than a time-based wait", async () => {
  await run("wait", "--time", "+025000");
  expect(lastCall()?.[2]?.timeoutMs).toBeGreaterThan(25000);
});

it("budgets every supplied wait condition before adding transport slack", async () => {
  await run(
    "wait",
    "#result",
    "--time=1000",
    "--text=Ready",
    "--text-gone=Loading",
    "--url=**/done",
    "--load=networkidle",
    "--fn=() => true",
    "--timeout-ms=2000",
  );
  expect(lastCall()?.[2]?.timeoutMs).toBe(18_000);
});

it("rejects non-decimal wait numeric options before sending the wait request", async () => {
  await expect(run("wait", "--time=1e3")).rejects.toThrow("--time must be a non-negative integer.");
  await expect(run("wait", "--timeout-ms=0x1000")).rejects.toThrow(
    "--timeout-ms must be a positive integer.",
  );
  expect(request).not.toHaveBeenCalled();
});

it("preserves the evaluate timeout and canonical outer deadline", async () => {
  await run("evaluate", "--fn", "() => true", "--timeout-ms", "1");
  expect(lastCall()?.[1].body).toMatchObject({ timeoutMs: 1 });
  expect(lastCall()?.[2]?.timeoutMs).toBe(6_252);
});

it("prints null for an undefined successful value", async () => {
  request.mockResolvedValueOnce({ ok: true, result: undefined });
  await run("evaluate", "--fn", "() => 0");
  expect(capture.defaultRuntime.writeJson).toHaveBeenCalledWith(null);
});

it.each([
  ["press", "Enter"],
  ["batch", "--actions", '[{"kind":"press","key":"Enter"}]'],
])("reports a pending dialog for %s", async (...args) => {
  const pending = [{ id: "d1", type: "confirm", message: "Page content stays in JSON output" }];
  const result = {
    ok: true,
    blockedByDialog: true,
    browserState: { dialogs: { pending, recent: [] } },
  };
  request.mockResolvedValueOnce(result);
  await run(...args);
  const text = capture.runtimeLogs.join("\n");
  expect(text).toContain("blocked by a modal dialog");
  expect(text).toContain('"d1"');
  expect(text).toContain("--dialog-id");
  expect(text).not.toContain("Page content stays in JSON output");
  expect(capture.defaultRuntime.writeJson).not.toHaveBeenCalled();
  expect(capture.defaultRuntime.exit).not.toHaveBeenCalled();

  capture.resetRuntimeCapture();
  vi.clearAllMocks();
  request.mockResolvedValueOnce(result);
  await run("--json", ...args);
  expect(capture.defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(result);
  expect(capture.runtimeLogs).toEqual([JSON.stringify(result, null, 2)]);
});
