import "./btw.mocks.test-support.js";
import { describe, expect, it } from "vitest";
import type { PreparedAgentRunAdmission } from "./admitted-run-context.js";
import {
  DEFAULT_SESSION_KEY,
  createCliRuntimeConfig,
  executePreparedCliRunMock,
  getApiKeyForModelMock,
  mockArg,
  mockCliOutput,
  prepareCliRunContextMock,
  registerProviderStreamForModelMock,
  runSideQuestion,
  setupBtwTestHooks,
  streamSimpleMock,
} from "./btw.test-support.js";

describe("runBtwSideQuestion CLI lifecycle", () => {
  setupBtwTestHooks();

  it("runs CLI-runtime alias BTW as an ephemeral CLI side question", async () => {
    const { cleanup, prepared } = mockCliOutput({ text: "CLI side answer." });

    const result = await runSideQuestion({
      cfg: createCliRuntimeConfig(),
      model: "claude-opus-4-7",
      sessionKey: DEFAULT_SESSION_KEY,
      authorityRunId: "btw-cli-authority",
      opts: { runId: "parent-correlation" },
    });

    expect(result).toEqual({ text: "CLI side answer." });
    expect(prepareCliRunContextMock).toHaveBeenCalledTimes(1);
    const prepareParams = mockArg(prepareCliRunContextMock, 0, 0) as {
      executionMode?: string;
      provider?: string;
      model?: string;
      disableTools?: boolean;
      cliSessionId?: string;
      extraSystemPrompt?: string;
      prompt?: string;
    };
    expect(prepareParams.executionMode).toBe("side-question");
    expect(prepareParams.provider).toBe("claude-cli");
    expect(prepareParams.model).toBe("claude-opus-4-7");
    expect(prepareParams.disableTools).toBe(true);
    expect(prepareParams).toMatchObject({ runId: "btw-cli-authority" });
    expect(prepareParams.cliSessionId).toBeUndefined();
    expect(prepareParams.extraSystemPrompt).toContain("Answer only the side question");
    expect(prepareParams.prompt).toContain("<conversation_history>");
    expect(prepareParams.prompt).toContain("<btw_side_question>");
    expect(executePreparedCliRunMock).toHaveBeenCalledWith(prepared);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(getApiKeyForModelMock).not.toHaveBeenCalled();
    expect(streamSimpleMock).not.toHaveBeenCalled();
    expect(registerProviderStreamForModelMock).not.toHaveBeenCalled();
  });

  it("closes CLI side-question admission when backend cleanup rejects", async () => {
    const { cleanup } = mockCliOutput({ text: "CLI side answer." });
    const cleanupError = new Error("CLI cleanup failed");
    cleanup.mockRejectedValueOnce(cleanupError);

    await expect(
      runSideQuestion({
        cfg: createCliRuntimeConfig(),
        model: "claude-opus-4-7",
        sessionKey: DEFAULT_SESSION_KEY,
      }),
    ).rejects.toBe(cleanupError);

    const { preparedRunAdmission } = mockArg(prepareCliRunContextMock, 0, 0) as {
      preparedRunAdmission: PreparedAgentRunAdmission;
    };
    try {
      await expect(preparedRunAdmission.admit("embedded")).rejects.toThrow(
        "prepared execution context is already closed",
      );
    } finally {
      preparedRunAdmission.close();
    }
  });
});
