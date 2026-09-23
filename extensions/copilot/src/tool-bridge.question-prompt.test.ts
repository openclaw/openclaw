import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import {
  createCopilotToolBridge,
  type CopilotCodingToolsOptions,
} from "./tool-bridge.test-support.js";

describe("createCopilotToolBridge question prompts", () => {
  it("prefers an initiator-owned question prompt over the tool-result sink", async () => {
    await withTempDir("openclaw-copilot-question-prompt-owned-", async (workspaceDir) => {
      const send = vi.fn();
      let capturedQuestionPrompt: CopilotCodingToolsOptions["questionPrompt"];
      const createOpenClawCodingTools = vi.fn((options?: CopilotCodingToolsOptions) => {
        capturedQuestionPrompt = options?.questionPrompt;
        return [];
      });

      await createCopilotToolBridge({
        attemptParams: {
          messageChannel: "telegram",
          onToolResult: vi.fn(),
          questionPrompt: { send, messageChannel: "telegram" },
          runId: "question-prompt-owned-run",
          sessionKey: "agent:agent-1:question-prompt-owned",
          workspaceDir,
        },
        createOpenClawCodingTools,
        sessionId: "question-prompt-owned-session",
        sessionKey: "agent:agent-1:question-prompt-owned",
        workspaceDir,
      });

      expect(capturedQuestionPrompt?.send).toBe(send);
      expect(capturedQuestionPrompt?.messageChannel).toBe("telegram");
    });
  });
});
