import { expect, it } from "vitest";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import {
  createSettledFinalizationTestInput as makeInput,
  createSettledProviderFailureAttempt as providerFailure,
  projectSettledProviderFailureAttempt as projectFailure,
} from "./settled-turn-finalization.test-support.js";
import { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";
import { resolveSettledTurnFinalizationRequest as resolveRequest } from "./terminal-resolution.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

function prepareRequest(
  attempt = providerFailure(),
  trigger: "user" | "cron" = "user",
): Parameters<typeof resolveRequest>[0] {
  const { initial, terminalBase, finalization } = makeInput(
    attempt,
    createTestAdmittedRunContext("run-settled"),
  );
  terminalBase.runParams.trigger = trigger;
  return {
    ...terminalBase,
    ...initial,
    ...finalization,
    ...prepareEmbeddedRunTerminal({ ...terminalBase, ...initial }),
    settledTurnFinalizationAvailable: true,
  };
}

function priorAssistant(base: EmbeddedRunAttemptResult, text: string) {
  return {
    ...base.lastAssistant!,
    stopReason: "stop" as const,
    content: [{ type: "text" as const, text }],
  };
}
const PROVIDER_ERROR = "Couldn't connect to the AI service.";

it.each(["no prior text", "prior NO_REPLY", "cross-chat send", "cron tool NO_REPLY"] as const)(
  "requires a final answer after %s",
  (kind) => {
    const base = providerFailure();
    const attempt =
      kind === "prior NO_REPLY"
        ? providerFailure({
            assistantTexts: ["NO_REPLY"],
            messagesSnapshot: [
              base.messagesSnapshot[0]!,
              priorAssistant(base, "NO_REPLY"),
              ...base.messagesSnapshot.slice(1),
            ],
          })
        : base;
    if (kind === "cross-chat send") {
      Object.assign(attempt, {
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Sent elsewhere."],
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "other-chat", text: "Sent elsewhere." },
        ],
      });
    }
    if (kind === "cron tool NO_REPLY") {
      const result = attempt.messagesSnapshot.find((message) => message.role === "toolResult");
      if (!result || result.role !== "toolResult") {
        throw new Error("Missing settled tool result");
      }
      result.content = [{ type: "text", text: "NO_REPLY" }];
    }
    const request = prepareRequest(attempt, kind === "cron tool NO_REPLY" ? "cron" : "user");
    if (kind === "no prior text" || kind === "prior NO_REPLY") {
      request.runParams.terminalReplyExpectation = "result-required";
    }
    expect(resolveRequest(request)).toContain("Do not repeat completed tool calls");
  },
);

it("does not attribute a current commentary substring to final output", () => {
  const base = providerFailure({
    assistantTexts: ["The note is already saved."],
  });
  base.messagesSnapshot.splice(
    1,
    0,
    priorAssistant(base, "The note is already saved. I will verify it."),
  );
  base.terminal = {
    kind: "failed",
    source: "prompt",
    error: new Error("Stream ended without finish_reason"),
  };
  const attempt = projectFailure(base);
  expect(attempt.settledTurnFinalizationContext).toBeUndefined();
  expect(resolveRequest(prepareRequest(attempt))).toBeNull();
});

it.each<Partial<EmbeddedRunAttemptResult>>([
  { toolMediaUrls: ["/tmp/note.png"] },
  { terminal: { kind: "aborted", source: "external" } },
])("preserves settled output %j instead of finalizing", (change) => {
  const request = prepareRequest(providerFailure(change));
  expect(resolveRequest(request)).toBeNull();
});

it.each(["provider refusal", "permanent WebSocket close"])(
  "preserves %s even with stale transient context",
  (failure) => {
    const attempt = providerFailure();
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
    expect(resolveRequest(request)).toBeNull();
    expect(request.payloadsWithToolMedia).toMatchObject([
      {
        isError: true,
        text: expect.stringContaining(
          failure === "provider refusal" ? "refused this request" : PROVIDER_ERROR,
        ),
      },
    ]);
  },
);

it("preserves an unmarked error alongside the generated provider error", () => {
  const request = prepareRequest();
  request.payloadsWithToolMedia?.push({ text: "Explicit error", isError: true });
  expect(resolveRequest(request)).toBeNull();
});
