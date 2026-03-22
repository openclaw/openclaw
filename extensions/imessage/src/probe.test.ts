import { beforeEach, describe, expect, it, vi } from "vitest";
import * as onboardHelpers from "../../../src/commands/onboard-helpers.js";
import * as execModule from "../../../src/process/exec.js";
import * as clientModule from "./client.js";
import { probeIMessage } from "./probe.js";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(onboardHelpers, "detectBinary").mockResolvedValue(true);
  vi.spyOn(execModule, "runCommandWithTimeout").mockResolvedValue({
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
    const result = await probeIMessage(1000, { cliPath: "imsg" });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.error).toMatch(/rpc/i);
    expect(createIMessageRpcClientMock).not.toHaveBeenCalled();
  });
});
