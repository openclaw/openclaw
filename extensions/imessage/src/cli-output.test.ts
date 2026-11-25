import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commandResult } from "../../test-support/command-result.test-support.js";
import { runIMessageCliJsonCommand } from "./cli-output.js";

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  runCommandWithTimeout: vi.fn(),
}));

const runCommandMock = vi.mocked(runCommandWithTimeout);
const run = (timeoutMs?: number) =>
  runIMessageCliJsonCommand({ cliPath: "imsg", args: ["send"], timeoutMs });

describe("runIMessageCliJsonCommand", () => {
  beforeEach(() => {
    runCommandMock.mockReset();
    runCommandMock.mockResolvedValue(
      commandResult({ stdout: '{"success":true,"messageId":"ok"}\n' }),
    );
  });

  it("uses the canonical wrapper with bounded asymmetric output", async () => {
    await expect(
      runIMessageCliJsonCommand({
        cliPath: "/usr/local/bin/imsg",
        dbPath: " /tmp/chat.db ",
        args: ["send", "--text", "hello"],
        timeoutMs: 2_000,
      }),
    ).resolves.toMatchObject({ success: true, messageId: "ok" });

    expect(runCommandMock).toHaveBeenCalledWith(
      ["/usr/local/bin/imsg", "send", "--text", "hello", "--db", "/tmp/chat.db", "--json"],
      expect.objectContaining({
        maxOutputBytes: { stdout: 8 * 1024 * 1024, stderr: 64 * 1024 },
        outputCapture: { stdout: "head", stderr: "tail" },
        terminateOnOutputLimit: { stdout: true },
      }),
    );
  });

  it("parses the last JSON object after CLI noise", async () => {
    runCommandMock.mockResolvedValueOnce(
      commandResult({ stdout: 'warning\n{"success":true,"messageId":"last"}\n' }),
    );
    await expect(run()).resolves.toMatchObject({ messageId: "last" });
  });

  it.each([
    [{ code: 124, termination: "timeout" }, "iMessage action timed out after 25ms"],
    [
      { code: null, termination: "signal", outputLimitExceeded: true },
      "imsg stdout exceeded 8388608 bytes",
    ],
    [{ code: 2, stdout: '{"success":false,"error":"denied"}\n' }, "denied"],
    [{ code: 2, stdout: "", stderr: "boom" }, "boom"],
    [{ stdout: "not json" }, "imsg returned non-JSON output: not json"],
    [{ stdout: '{"success":false,"error":"failed"}\n' }, "failed"],
  ] as const)("rejects command result %j with %s", async (overrides, error) => {
    runCommandMock.mockResolvedValueOnce(
      commandResult({ stdout: '{"success":true,"messageId":"ok"}\n', ...overrides }),
    );
    await expect(run(25)).rejects.toThrow(error);
  });
});
