import { Command } from "commander";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserProgram,
  mockBrowserGateway,
  getBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} from "./browser-cli.test-support.js";

const gatewayMock = mockBrowserGateway();
gatewayMock.mockResolvedValue({ response: { body: "ok" } });
const browserCliRuntime = getBrowserCliRuntime();
vi.spyOn(defaultRuntime, "log").mockImplementation(browserCliRuntime.log);
vi.spyOn(defaultRuntime, "writeJson").mockImplementation(browserCliRuntime.writeJson);
vi.spyOn(defaultRuntime, "error").mockImplementation(browserCliRuntime.error);
vi.spyOn(defaultRuntime, "exit").mockImplementation(browserCliRuntime.exit);

const { registerBrowserActionObserveCommands } = await import("./browser-cli-actions-observe.js");

function createActionObserveProgram(): Command {
  const { program, browser, parentOpts } = createBrowserProgram();
  browser.option("--timeout <ms>", "Timeout in ms", "30000");
  registerBrowserActionObserveCommands(browser, parentOpts);
  return program;
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
    const program = createActionObserveProgram();
    const parentArgs = timeout === "30000" ? ["--json"] : ["--json", "--timeout", timeout];

    await program.parseAsync(["browser", ...parentArgs, command], { from: "user" });

    expect(gatewayMock).toHaveBeenLastCalledWith(
      "browser.request",
      expect.objectContaining({ timeout: String(Number(timeout) + 10_000) }),
      expect.objectContaining({ path, timeoutMs: Number(timeout) }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
  });

  it("rejects non-decimal responsebody numeric flags before dispatch", async () => {
    const program = createActionObserveProgram();

    await expect(
      program.parseAsync(["browser", "responsebody", "**/api", "--timeout-ms", "1e3"], {
        from: "user",
      }),
    ).rejects.toThrow("--timeout-ms must be a positive integer.");
    await expect(
      program.parseAsync(["browser", "responsebody", "**/api", "--max-chars", "-1"], {
        from: "user",
      }),
    ).rejects.toThrow("--max-chars must be a positive integer.");
    expect(gatewayMock).not.toHaveBeenCalled();
  });

  it("rejects unknown console levels before dispatch", async () => {
    const program = createActionObserveProgram();

    await expect(
      program.parseAsync(["browser", "console", "--level", "bogus"], { from: "user" }),
    ).rejects.toThrow(/error.*warn.*info/u);
    expect(gatewayMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: "truncated prefix", body: "ABC", truncated: true, json: false },
    { label: "empty truncated prefix", body: "", truncated: true, json: false },
    { label: "complete at the limit", body: "ABC", truncated: undefined, json: false },
    { label: "explicitly complete", body: "ABC", truncated: false, json: false },
    { label: "empty complete body", body: "", truncated: undefined, json: false },
    { label: "JSON truncated prefix", body: "ABC", truncated: true, json: true },
  ])("reports completeness for $label without changing body output", async (testCase) => {
    const program = createActionObserveProgram();
    const result = {
      ok: true,
      response: {
        url: "https://example.com/api",
        status: 200,
        body: testCase.body,
        ...(testCase.truncated === undefined ? {} : { truncated: testCase.truncated }),
      },
    };
    gatewayMock.mockResolvedValueOnce(result);

    await program.parseAsync(
      [
        "browser",
        ...(testCase.json ? ["--json"] : []),
        "responsebody",
        "**/api",
        "--max-chars",
        "3",
      ],
      { from: "user" },
    );

    const { runtimeLogs, runtimeErrors } = getBrowserCliRuntimeCapture();
    expect(runtimeLogs).toHaveLength(1);
    if (testCase.json) {
      expect(JSON.parse(runtimeLogs[0]!)).toEqual(result);
    } else {
      expect(runtimeLogs).toEqual([testCase.body]);
    }
    expect(runtimeErrors).toEqual(
      testCase.truncated && !testCase.json ? [expect.stringMatching(/truncat/i)] : [],
    );
  });

  it.each([
    {
      label: "default",
      timeout: undefined,
      operationTimeoutMs: undefined,
      requestTimeoutMs: 25000,
    },
    { label: "minimum explicit", timeout: "1", operationTimeoutMs: 1, requestTimeoutMs: 5001 },
    {
      label: "signed explicit",
      timeout: "+030000",
      operationTimeoutMs: 30000,
      requestTimeoutMs: 35000,
    },
  ])(
    "keeps the $label responsebody request open past its operation deadline",
    async ({ timeout, operationTimeoutMs, requestTimeoutMs }) => {
      const program = createActionObserveProgram();
      const args = ["browser", "responsebody", "**/api", "--max-chars", "0100"];
      if (timeout !== undefined) {
        args.push("--timeout-ms", timeout);
      }

      await program.parseAsync(args, { from: "user" });

      const request = gatewayMock.mock.calls.at(-1)?.[2];
      expect(request?.body?.timeoutMs).toBe(operationTimeoutMs);
      expect(request?.body?.maxChars).toBe(100);
      expect(request?.timeoutMs).toBe(requestTimeoutMs);
    },
  );
});
