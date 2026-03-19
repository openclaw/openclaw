import { beforeEach, describe, expect, it, vi } from "vitest";
import * as processRuntime from "../../../src/plugin-sdk/process-runtime.js";
import * as setupRuntime from "../../../src/plugin-sdk/setup.js";
import * as clientModule from "./client.js";
import { probeIMessage } from "./probe.js";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(setupRuntime, "detectBinary").mockResolvedValue(true);
  vi.spyOn(processRuntime, "runCommandWithTimeout").mockResolvedValue({
    stdout: "",
    stderr: 'unknown command "rpc" for "imsg"',
    code: 1,
    signal: null,
    killed: false,
    termination: "exit",
  });
});

describe("probeIMessage", () => {
  it("marks unknown rpc subcommand as fatal", async () => {
    const createIMessageRpcClientMock = vi
      .spyOn(clientModule, "createIMessageRpcClient")
      .mockResolvedValue({
        request: vi.fn(),
        stop: vi.fn(),
      } as unknown as Awaited<ReturnType<typeof clientModule.createIMessageRpcClient>>);
    const result = await probeIMessage(1000, { cliPath: "imsg-test-rpc" });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.error).toMatch(/rpc/i);
    expect(createIMessageRpcClientMock).not.toHaveBeenCalled();
  });
});
