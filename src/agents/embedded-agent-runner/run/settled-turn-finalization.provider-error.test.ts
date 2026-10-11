import { describe, expect, it } from "vitest";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import {
  createSettledFinalizationTestInput,
  createSettledProviderFailureAttempt,
  projectSettledProviderFailureAttempt,
} from "./settled-turn-finalization.test-support.js";
import { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";
import { resolveSettledTurnFinalizationRequest } from "./terminal-resolution.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

function prepareRequest(
  attempt = createSettledProviderFailureAttempt(),
  trigger: "user" | "cron" = "user",
): Parameters<typeof resolveSettledTurnFinalizationRequest>[0] {
  const { initial, terminalBase, finalization } = createSettledFinalizationTestInput(
    attempt,
    createTestAdmittedRunContext("run-settled"),
  );
  terminalBase.runParams.trigger = trigger;
  const prepared = prepareEmbeddedRunTerminal({ ...terminalBase, ...initial });
  return {
    runParams: terminalBase.runParams,
    attempt,
    activeErrorContext: terminalBase.activeErrorContext,
    modelApi: finalization.modelApi,
    executionContract: finalization.executionContract,
    payloadsWithToolMedia: prepared.payloadsWithToolMedia,
    recoveredFinalAssistantPayloadsAfterPromptTimeout:
      prepared.recoveredFinalAssistantPayloadsAfterPromptTimeout,
    terminalState: initial.terminalState,
    hasTerminalToolPresentation: false,
    settledTurnFinalizationAvailable: true,
  };
}

describe("prepared provider errors after settled tools", () => {
  it.each([
    { name: "no prior text", assistantTexts: [] },
    { name: "prior NO_REPLY", assistantTexts: ["NO_REPLY"] },
  ])(
    "does not mistake the generated provider error for a required answer after $name",
    ({ assistantTexts }) => {
      const request = prepareRequest(createSettledProviderFailureAttempt({ assistantTexts }));
      expect(request.payloadsWithToolMedia).toEqual([
        expect.objectContaining({
          isError: true,
          text: expect.stringContaining("Couldn't connect to the AI service."),
        }),
      ]);
      expect(resolveSettledTurnFinalizationRequest(request)).toContain(
        "Do not repeat completed tool calls",
      );
    },
  );

  it("does not attribute a current commentary substring to final output", () => {
    const base = createSettledProviderFailureAttempt({
      assistantTexts: ["The note is already saved."],
    });
    const earlierAssistant = {
      ...base.lastAssistant!,
      stopReason: "stop" as const,
      content: [
        {
          type: "text" as const,
          text: "The note is already saved. I will verify it.",
        },
      ],
    };
    base.messagesSnapshot.splice(1, 0, earlierAssistant);
    base.terminal = {
      kind: "failed",
      source: "prompt",
      error: new Error("Stream ended without finish_reason"),
    };
    const attempt = projectSettledProviderFailureAttempt(base);
    expect(attempt.settledTurnFinalizationContext).toBeUndefined();
    expect(resolveSettledTurnFinalizationRequest(prepareRequest(attempt))).toBeNull();
  });

  it.each([
    {
      name: "delivered source reply",
      change: {
        sourceReplyDelivered: true,
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Note saved."],
      },
    },
    { name: "delivered media", change: { hasToolMediaBlockReply: true } },
    { name: "pending media", change: { toolMediaUrls: ["/tmp/note.png"] } },
    { name: "cancellation", change: { terminal: { kind: "aborted", source: "external" } } },
  ] satisfies Array<{ name: string; change: Partial<EmbeddedRunAttemptResult> }>)(
    "preserves $name instead of finalizing",
    ({ change }) => {
      const request = prepareRequest(createSettledProviderFailureAttempt(change));
      expect(resolveSettledTurnFinalizationRequest(request)).toBeNull();
    },
  );

  it("does not let a send to another conversation settle the required source reply", () => {
    const request = prepareRequest(
      createSettledProviderFailureAttempt({
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Sent elsewhere."],
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "other-chat", text: "Sent elsewhere." },
        ],
      }),
    );
    expect(resolveSettledTurnFinalizationRequest(request)).toContain(
      "Do not repeat completed tool calls",
    );
  });

  it.each(["provider refusal", "permanent WebSocket close"])(
    "preserves %s even with stale transient context",
    (failure) => {
      const attempt = createSettledProviderFailureAttempt();
      const assistant = attempt.currentAttemptCompletedAssistant;
      if (!assistant) {
        throw new Error("Missing failed assistant");
      }
      if (failure === "provider refusal") {
        assistant.diagnostics = [
          { type: "provider_refusal", timestamp: 0, details: { provider: "openai" } },
        ];
      } else {
        assistant.errorCode = "ERR_WEBSOCKET_NON_RETRYABLE_CLOSE";
      }
      const request = prepareRequest(attempt);
      expect(resolveSettledTurnFinalizationRequest(request)).toBeNull();
      expect(request.payloadsWithToolMedia).toEqual([
        expect.objectContaining({
          isError: true,
          text: expect.stringContaining(
            failure === "provider refusal"
              ? "refused this request"
              : "Couldn't connect to the AI service.",
          ),
        }),
      ]);
    },
  );

  it("preserves a cron tool-authored silent outcome after discounting the error", () => {
    const attempt = createSettledProviderFailureAttempt();
    const result = attempt.messagesSnapshot.find((message) => message.role === "toolResult");
    if (!result || result.role !== "toolResult") {
      throw new Error("Missing settled tool result");
    }
    result.content = [{ type: "text", text: "NO_REPLY" }];
    expect(resolveSettledTurnFinalizationRequest(prepareRequest(attempt, "cron"))).toBeNull();
  });

  it("preserves an unmarked error alongside the generated provider error", () => {
    const request = prepareRequest();
    request.payloadsWithToolMedia?.push({ text: "Explicit error", isError: true });
    expect(resolveSettledTurnFinalizationRequest(request)).toBeNull();
  });
});
