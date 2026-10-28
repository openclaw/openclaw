import { beforeEach, describe, expect, it } from "vitest";
import {
  createBrowserProgram,
  mockBrowserGateway,
  mockBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} from "./browser-cli.test-support.js";

const gatewayMock = mockBrowserGateway();
gatewayMock.mockResolvedValue({ response: { body: "ok" } });
mockBrowserCliRuntime();

const { registerBrowserActionObserveCommands } = await import("./browser-cli-actions-observe.js");

function run(...args: string[]) {
  const { program, browser, parentOpts } = createBrowserProgram();
  browser.option("--timeout <ms>", "Timeout in ms", "30000");
  registerBrowserActionObserveCommands(browser, parentOpts);
  return program.parseAsync(["browser", ...args], { from: "user" });
}

describe("browser action observe commands", () => {
  beforeEach(() => {
    gatewayMock.mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });

  it.each([
    { command: "console", path: "/console", timeout: "30000" },
    { command: "console", path: "/console", timeout: "60000" },
    { command: "pdf", path: "/pdf", timeout: "30000" },
    { command: "pdf", path: "/pdf", timeout: "60000" },
  ])("inherits parent $timeout ms timeout for $command", async ({ command, path, timeout }) => {
    const parentArgs = timeout === "30000" ? ["--json"] : ["--json", "--timeout", timeout];
    await run(...parentArgs, command);

    expect(gatewayMock).toHaveBeenLastCalledWith(
      "browser.request",
      expect.objectContaining({ timeout: String(Number(timeout) + 130_000) }),
      expect.objectContaining({ path, timeoutMs: Number(timeout) }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
  });

  it("rejects non-decimal responsebody numeric flags before dispatch", async () => {
    await expect(run("responsebody", "**/api", "--timeout-ms", "1e3")).rejects.toThrow(
      "--timeout-ms must be a positive integer.",
    );
    await expect(run("responsebody", "**/api", "--max-chars", "-1")).rejects.toThrow(
      "--max-chars must be a positive integer.",
    );
    expect(gatewayMock).not.toHaveBeenCalled();
  });

  it("rejects unknown console levels before dispatch", async () => {
    await expect(run("console", "--level", "bogus")).rejects.toThrow(/error.*warn.*info/u);
    expect(gatewayMock).not.toHaveBeenCalled();
  });

  it.each([
    ["ABC", true, false],
    ["", true, false],
    ["ABC", undefined, false],
    ["ABC", false, false],
    ["", undefined, false],
    ["ABC", true, true],
  ] as const)("prints body=%j truncated=%s json=%s", async (body, truncated, json) => {
    const result = { response: { body, ...(truncated === undefined ? {} : { truncated }) } };
    gatewayMock.mockResolvedValueOnce(result);
    await run(...(json ? ["--json"] : []), "responsebody", "**/api", "--max-chars", "3");
    const { runtimeLogs, runtimeErrors } = getBrowserCliRuntimeCapture();
    if (json) {
      expect(runtimeLogs).toHaveLength(1);
      expect(JSON.parse(runtimeLogs[0]!)).toEqual(result);
    } else {
      expect(runtimeLogs).toEqual([body]);
    }
    expect(runtimeErrors).toEqual(truncated && !json ? [expect.stringMatching(/truncat/i)] : []);
  });

  it.each([
    ["default", undefined, undefined, 25000],
    ["minimum explicit", "1", 1, 5001],
    ["signed explicit", "+030000", 30000, 35000],
  ] as const)(
    "keeps the %s responsebody request open past its operation deadline",
    async (_label, timeout, operationTimeoutMs, requestTimeoutMs) => {
      const timeoutArgs = timeout === undefined ? [] : ["--timeout-ms", timeout];
      await run("responsebody", "**/api", "--max-chars", "0100", ...timeoutArgs);
      const request = gatewayMock.mock.calls.at(-1)?.[2];
      expect(request).toMatchObject({
        body: { timeoutMs: operationTimeoutMs, maxChars: 100 },
        timeoutMs: requestTimeoutMs,
      });
    },
  );
});
