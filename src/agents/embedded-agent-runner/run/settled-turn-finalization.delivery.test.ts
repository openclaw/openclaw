import { describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { prepareTerminalWithSettledTurnFinalization } from "./settled-turn-finalization.js";
import { createSettledFinalizationTestInput } from "./settled-turn-finalization.test-support.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";
import { createPendingToolMediaCarry } from "./tool-media-payloads.js";

function deliveryAttempt(
  assistant: EmbeddedRunAttemptWithReceiptEvidence["lastAssistant"],
  overrides: Partial<EmbeddedRunAttemptWithReceiptEvidence> = {},
): EmbeddedRunAttemptWithReceiptEvidence {
  return makeEmbeddedRunnerAttempt({
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    sourceReplyDeliveryState: "missing",
    ...overrides,
  });
}

type Observation = "pending" | "observation-failed" | "missing" | "delivered";
const heartbeatResponse = {
  outcome: "done" as const,
  notify: true,
  summary: "Current heartbeat report.",
};
const committedReply = { text: "Earlier committed reply.", sourceReplyFinal: true };
const committedPayload = expect.objectContaining({ text: "Earlier committed reply." });
const textAssistant = (text: string) =>
  buildEmbeddedRunnerAssistant({ content: [{ type: "text", text }] });

function observedOutputs<T extends string>(outputs: readonly T[]) {
  return outputs.flatMap((output) =>
    (["pending", "observation-failed", "missing"] as const).map((observation) => ({
      output,
      observation,
    })),
  );
}

function deliveryInput(
  attempt: EmbeddedRunAttemptWithReceiptEvidence,
  observation: Observation,
  trigger: "user" | "cron" | "heartbeat" = "cron",
  mode: "automatic" | "message_tool_only" = "automatic",
) {
  const input = createSettledFinalizationTestInput(
    attempt,
    createTestAdmittedRunContext("run-delivery"),
  );
  const params = input.terminalBase.runParams;
  params.trigger = trigger;
  params.sourceReplyDeliveryMode = mode;
  params.resolveReplyDelivery = vi.fn(async () => {
    if (observation === "observation-failed") {
      throw new Error("delivery observation unavailable");
    }
    return observation;
  });
  return input;
}

function precedingAnswer(
  lastAssistant = buildEmbeddedRunnerAssistant({}),
  sourceReplyDeliveryState: "missing" | "delivered" = "delivered",
  textEnd = 0,
) {
  return [
    { textEnd, messageEnd: 1, finalMessageStart: 1, lastAssistant, sourceReplyDeliveryState },
  ];
}

async function resolveCompletion(
  input: ReturnType<typeof createSettledFinalizationTestInput>,
  settled: Awaited<ReturnType<typeof prepareTerminalWithSettledTurnFinalization>>,
) {
  const resolved = await resolveEmbeddedRunTerminal(
    makeTerminalInput({
      runParams: input.terminalBase.runParams,
      attempt: input.initial.attempt,
      prepared: settled.prepared,
      terminalState: settled.terminalState,
      settledTurnFinalizationOutcome: settled.finalizationOutcome,
    }),
  );
  if (resolved.action !== "complete") {
    throw new Error("expected terminal completion");
  }
  return resolved.result;
}

describe("terminal preparation delivery custody", () => {
  it.each(observedOutputs(["response", "failed-response", "failure-only"] as const))(
    "retains observed $observation custody for heartbeat $output",
    async ({ output, observation }) => {
      const attempt = deliveryAttempt(buildEmbeddedRunnerAssistant({ content: [] }));
      if (output !== "failure-only") {
        attempt.heartbeatToolResponse = { ...heartbeatResponse };
        attempt.messagingToolSourceReplyPayloads = [{ ...committedReply }];
        attempt.answerSegments = precedingAnswer();
      }
      if (output !== "response") {
        attempt.lastToolError = { toolName: "write", error: "write failed", mutatingAction: true };
      }
      const input = deliveryInput(attempt, observation, "heartbeat");
      const settled = await prepareTerminalWithSettledTurnFinalization(input);
      const result = await resolveCompletion(input, settled);
      const payloads = result.payloads ?? [];
      if (observation === "missing") {
        const expected =
          output === "failure-only" ? { isError: true } : { text: "Current heartbeat report." };
        expect(payloads).toContainEqual(expect.objectContaining(expected));
      } else {
        expect(payloads).toEqual(output === "failure-only" ? [] : [committedPayload]);
        expect(result.sourceReplyDeliveryState).toBe("pending");
      }
    },
  );

  it.each(observedOutputs(["text", "error", "media", "timeout"] as const))(
    "carries $observation custody through $output preparation and terminal resolution",
    async ({ output, observation }) => {
      const text = "Current input answer.";
      const assistant = buildEmbeddedRunnerAssistant({
        stopReason: output === "error" ? "error" : "stop",
        content: output === "media" || output === "error" ? [] : [{ type: "text", text }],
        ...(output === "error" ? { errorMessage: "503 upstream connection refused" } : {}),
      });
      const attempt = deliveryAttempt(assistant, {
        terminal:
          output === "timeout"
            ? { kind: "timeout", phase: "prompt", source: "runtime" }
            : { kind: "ok" },
        assistantTexts: output === "text" || output === "timeout" ? [text] : [],
        messagingToolSourceReplyPayloads: [{ ...committedReply }],
      });
      attempt.answerSegments = precedingAnswer();
      const input = deliveryInput(attempt, observation, "user");
      const carry = createPendingToolMediaCarry();
      if (output === "media") {
        carry.capture({ toolMediaUrls: ["/tmp/carried-current.pdf"] });
        attempt.toolMediaUrls = ["/tmp/current.pdf"];
      }
      input.terminalBase.mergeToolMedia = carry.merge;
      const finalizeSettledTurn = vi.spyOn(input.finalization.harness, "finalizeSettledTurn");
      const settled = await prepareTerminalWithSettledTurnFinalization(input);
      expect(input.terminalBase.runParams.resolveReplyDelivery).toHaveBeenCalledWith(2);
      expect(finalizeSettledTurn).not.toHaveBeenCalled();
      expect(settled).toMatchObject({
        finalizationOutcome: "not-attempted",
        prepared: { replyDeliveryState: observation === "missing" ? "missing" : "pending" },
      });
      const result = await resolveCompletion(input, settled);
      const payloads = result.payloads ?? [];
      expect(payloads[0]?.text).toBe("Earlier committed reply.");
      expect(getReplyPayloadMetadata(payloads[0]!)).toHaveProperty("sourceReplyTranscriptMirror");
      if (observation !== "missing") {
        expect(settled.prepared.recoveredFinalAssistantPayloadsAfterPromptTimeout).toBeUndefined();
        expect(payloads).toEqual([committedPayload]);
        expect(payloads[0]?.mediaUrls).toBeUndefined();
        expect(result.sourceReplyDeliveryState).toBe("pending");
        if (output === "media") {
          input.terminalBase.runParams.resolveReplyDelivery = async () => "missing";
          const released = await prepareTerminalWithSettledTurnFinalization(input);
          expect(
            released.prepared.payloadsWithToolMedia?.flatMap((payload) => payload.mediaUrls ?? []),
          ).toEqual(expect.arrayContaining(["/tmp/current.pdf", "/tmp/carried-current.pdf"]));
        }
      } else if (output === "media") {
        expect(payloads.flatMap((payload) => payload.mediaUrls ?? [])).toEqual(
          expect.arrayContaining(["/tmp/current.pdf", "/tmp/carried-current.pdf"]),
        );
      } else {
        expect(payloads).toHaveLength(2);
        expect(payloads[1]).toMatchObject(output === "error" ? { isError: true } : { text });
      }
    },
  );

  it.each([
    ["delivered", "missing"],
    ["pending", "delivered"],
    ["missing", "delivered"],
  ] as const)(
    "reconciles confirmed custody (%s attempt, %s observation)",
    async (attemptDelivery, observedDelivery) => {
      const assistant = textAssistant("Do not repeat.");
      const attempt = deliveryAttempt(assistant, {
        assistantTexts: ["Do not repeat."],
        sourceReplyDeliveryState: attemptDelivery,
        messagingToolSourceReplyPayloads: [{ text: "Committed reply.", sourceReplyFinal: true }],
      });
      const input = deliveryInput(attempt, observedDelivery);
      const settled = await prepareTerminalWithSettledTurnFinalization(input);
      expect(settled.prepared).toMatchObject({
        replyDeliveryState: "delivered",
        payloadsWithToolMedia: [expect.objectContaining({ text: "Committed reply." })],
        agentMeta: { terminalReceipt: { sourceReplyDelivered: true } },
      });
    },
  );

  it("preserves a tool-authored source projection and its owned media while custody is pending", async () => {
    const assistant = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "reply-tool", name: "report", arguments: {} }],
    });
    const attempt = deliveryAttempt(assistant, {
      toolMediaUrls: ["/tmp/unselected.pdf"],
      messagingToolSourceReplyPayloads: [
        {
          text: "Committed tool reply.",
          mediaUrls: ["/tmp/committed.pdf"],
          sourceReplyFinal: true,
          toolAuthored: true,
          toolAuthoredForToolCallId: "reply-tool",
        },
      ],
    });
    const input = deliveryInput(attempt, "pending", "cron", "message_tool_only");
    const settled = await prepareTerminalWithSettledTurnFinalization(input);
    expect(settled.prepared.payloadsWithToolMedia).toEqual([
      expect.objectContaining({ text: "Committed tool reply.", mediaUrls: ["/tmp/committed.pdf"] }),
    ]);
    expect(getReplyPayloadMetadata(settled.prepared.payloadsWithToolMedia![0]!)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
      sourceReplyTranscriptMirror: { text: "Committed tool reply." },
    });
  });

  it.each([false, true])(
    "preserves a preceding input's answer while current delivery remains pending (heartbeat=%s)",
    async (heartbeat) => {
      const earlier = textAssistant("Earlier answer.");
      const current = textAssistant("Current answer.");
      const attempt = deliveryAttempt(current, {
        assistantTexts: ["Earlier answer.", "Current answer."],
        ...(heartbeat ? { heartbeatToolResponse: heartbeatResponse } : {}),
      });
      attempt.answerSegments = precedingAnswer(earlier, "missing", 1);
      const input = deliveryInput(attempt, "pending", "cron");
      const settled = await prepareTerminalWithSettledTurnFinalization(input);
      expect(settled.prepared.payloadsWithToolMedia).toEqual([
        expect.objectContaining({ text: "Earlier answer." }),
      ]);
      expect(getReplyPayloadMetadata(settled.prepared.payloadsWithToolMedia![0]!)).toMatchObject({
        precedingInputAnswer: true,
      });
    },
  );
});
