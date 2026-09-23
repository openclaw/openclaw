import { describe, expect, it, vi } from "vitest";
import {
  createOpenClawCodingToolsMock,
  runSideQuestionWithManagedWebSearchCall,
  sideParams,
  toolExecuteMock,
  useSideQuestionTestSetup,
} from "./side-question.test-support.js";

describe("runCodexAppServerSideQuestion question prompts", () => {
  useSideQuestionTestSetup();

  it.each<[string, string | undefined, string | undefined, string | undefined, boolean]>([
    ["provider-only Telegram", undefined, "telegram", "telegram", true],
    ["explicit Telegram", "telegram", undefined, "telegram", true],
    ["explicit Telegram before another provider", "telegram", "discord", "telegram", true],
    ["explicit webchat before Telegram provider", "webchat", "telegram", "webchat", true],
    ["both channels absent", undefined, undefined, undefined, true],
    ["callback absent", undefined, "telegram", "telegram", false],
  ])(
    "hands a side thread's question tools this run's own way to show a prompt: %s",
    async (_name, messageChannel, messageProvider, expectedChannel, hasCallback) => {
      // A side thread dispatches tools through the same direct bridge as a normal Codex
      // turn, so no tool-start handler reserves a blocking question's prompt for them.
      // Without a sender the question is registered, waited on, and never shown.
      const onToolResult = vi.fn();
      type ToolOptions = NonNullable<
        Parameters<
          (typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingTools"]
        >[0]
      >;
      let capturedQuestionPrompt: ToolOptions["questionPrompt"];
      createOpenClawCodingToolsMock.mockImplementation((options: ToolOptions) => {
        capturedQuestionPrompt = options.questionPrompt;
        return [
          {
            name: "ask_user",
            description: "Ask the person a question",
            parameters: { type: "object", properties: {}, additionalProperties: true },
            execute: toolExecuteMock,
          },
        ];
      });

      await runSideQuestionWithManagedWebSearchCall(
        sideParams({
          messageChannel,
          messageProvider,
          opts: hasCallback ? { onToolResult } : {},
        }),
        { preserveToolFactory: true, toolName: "ask_user", toolArguments: { header: "Choice" } },
      );

      expect(toolExecuteMock).toHaveBeenCalledTimes(1);
      if (!hasCallback) {
        expect(capturedQuestionPrompt).toBeUndefined();
        expect(onToolResult).not.toHaveBeenCalled();
        return;
      }
      expect(capturedQuestionPrompt).toBeDefined();
      expect(capturedQuestionPrompt?.messageChannel).toBe(expectedChannel);
      await capturedQuestionPrompt?.send({ text: "Question for you:" });
      expect(onToolResult).toHaveBeenCalledExactlyOnceWith({ text: "Question for you:" });
    },
  );
});
