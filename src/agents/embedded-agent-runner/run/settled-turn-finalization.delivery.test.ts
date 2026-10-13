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

describe("terminal preparation delivery custody", () => {
  it.each(
    (["response", "failed-response", "failure-only"] as const).flatMap((output) =>
      (["pending", "observation-failed", "missing"] as const).map((observation) => ({
        output,
        observation,
      })),
    ),
  )(
    "retains observed $observation custody for heartbeat $output",
    async ({ output, observation }) => {
      const assistant = buildEmbeddedRunnerAssistant({ content: [] });
      const attempt: EmbeddedRunAttemptWithReceiptEvidence = makeEmbeddedRunnerAttempt({
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        currentAttemptCompletedAssistant: assistant,
        sourceReplyDeliveryState: "missing",
        ...(output !== "failure-only"
          ? {
              heartbeatToolResponse: {
                outcome: "done",
                notify: true,
                summary: "Current heartbeat report.",
              },
              messagingToolSourceReplyPayloads: [
                { text: "Earlier committed reply.", sourceReplyFinal: true },
              ],
            }
          : {}),
        ...(output !== "response"
          ? { lastToolError: { toolName: "write", error: "write failed", mutatingAction: true } }
          : {}),
      });
      if (output !== "failure-only") {
        attempt.answerSegments = [
          {
            textEnd: 0,
            messageEnd: 1,
            finalMessageStart: 1,
            lastAssistant: buildEmbeddedRunnerAssistant({}),
            sourceReplyDeliveryState: "delivered",
          },
        ];
      }
      const input = createSettledFinalizationTestInput(
        attempt,
        createTestAdmittedRunContext("run-heartbeat-custody"),
      );
      input.terminalBase.runParams.trigger = "heartbeat";
      input.terminalBase.runParams.sourceReplyDeliveryMode = "automatic";
      input.terminalBase.runParams.resolveReplyDelivery = async () => {
        if (observation === "observation-failed") {
          throw new Error("heartbeat delivery observation unavailable");
        }
        return observation;
      };
      const settled = await prepareTerminalWithSettledTurnFinalization(input);
      const resolved = await resolveEmbeddedRunTerminal(
        makeTerminalInput({
          runParams: input.terminalBase.runParams,
          attempt,
          prepared: settled.prepared,
          terminalState: settled.terminalState,
          settledTurnFinalizationOutcome: settled.finalizationOutcome,
        }),
      );
      expect(resolved.action).toBe("complete");
      if (resolved.action !== "complete") {
        throw new Error("expected heartbeat terminal completion");
      }
      const payloads = resolved.result.payloads ?? [];
      if (observation === "missing") {
        expect(
          payloads.some((payload) =>
            output === "failure-only"
              ? payload.isError
              : payload.text === "Current heartbeat report.",
          ),
        ).toBe(true);
      } else {
        expect(payloads).toEqual(
          output === "failure-only"
            ? []
            : [expect.objectContaining({ text: "Earlier committed reply." })],
        );
        expect(resolved.result.sourceReplyDeliveryState).toBe("pending");
      }
    },
  );

  it.each(
    (["text", "error", "media", "timeout"] as const).flatMap((output) =>
      (["pending", "observation-failed", "missing"] as const).map((observation) => ({
        output,
        observation,
      })),
    ),
  )(
    "carries $observation custody through $output preparation and terminal resolution",
    async ({ output, observation }) => {
      const text = "Current input answer.";
      const assistant = buildEmbeddedRunnerAssistant({
        stopReason: output === "error" ? "error" : "stop",
        content: output === "media" || output === "error" ? [] : [{ type: "text", text }],
        ...(output === "error" ? { errorMessage: "503 upstream connection refused" } : {}),
      });
      const attempt: EmbeddedRunAttemptWithReceiptEvidence = makeEmbeddedRunnerAttempt({
        terminal:
          output === "timeout"
            ? { kind: "timeout", phase: "prompt", source: "runtime" }
            : { kind: "ok" },
        assistantTexts: output === "text" || output === "timeout" ? [text] : [],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        currentAttemptCompletedAssistant: assistant,
        sourceReplyDeliveryState: "missing",
        messagingToolSourceReplyPayloads: [
          { text: "Earlier committed reply.", sourceReplyFinal: true },
        ],
      });
      attempt.answerSegments = [
        {
          textEnd: 0,
          messageEnd: 1,
          finalMessageStart: 1,
          lastAssistant: buildEmbeddedRunnerAssistant({}),
          sourceReplyDeliveryState: "delivered",
        },
      ];
      const input = createSettledFinalizationTestInput(
        attempt,
        createTestAdmittedRunContext("run-observed-delivery"),
      );
      input.terminalBase.runParams.trigger = "user";
      input.terminalBase.runParams.sourceReplyDeliveryMode = "automatic";
      input.terminalBase.runParams.resolveReplyDelivery = vi.fn(async () => {
        if (observation === "observation-failed") {
          throw new Error("delivery observation unavailable");
        }
        return observation;
      });
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
      expect(settled.finalizationOutcome).toBe("not-attempted");
      expect(settled.prepared.replyDeliveryState).toBe(
        observation === "missing" ? "missing" : "pending",
      );
      const resolved = await resolveEmbeddedRunTerminal(
        makeTerminalInput({
          runParams: input.terminalBase.runParams,
          attempt,
          prepared: settled.prepared,
          terminalState: settled.terminalState,
          settledTurnFinalizationOutcome: settled.finalizationOutcome,
        }),
      );
      expect(resolved.action).toBe("complete");
      if (resolved.action !== "complete") {
        throw new Error("expected terminal completion");
      }
      const payloads = resolved.result.payloads ?? [];
      expect(payloads[0]?.text).toBe("Earlier committed reply.");
      expect(getReplyPayloadMetadata(payloads[0]!)).toHaveProperty("sourceReplyTranscriptMirror");
      if (observation !== "missing") {
        expect(settled.prepared.recoveredFinalAssistantPayloadsAfterPromptTimeout).toBeUndefined();
        expect(payloads).toEqual([expect.objectContaining({ text: "Earlier committed reply." })]);
        expect(payloads[0]?.mediaUrls).toBeUndefined();
        expect(resolved.result.sourceReplyDeliveryState).toBe("pending");
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
    { attemptDelivery: "delivered", observedDelivery: "missing" },
    { attemptDelivery: "pending", observedDelivery: "delivered" },
    { attemptDelivery: "missing", observedDelivery: "delivered" },
  ] as const)(
    "reconciles confirmed custody ($attemptDelivery attempt, $observedDelivery observation)",
    async ({ attemptDelivery, observedDelivery }) => {
      const assistant = buildEmbeddedRunnerAssistant({
        content: [{ type: "text", text: "Do not repeat." }],
      });
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: ["Do not repeat."],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        currentAttemptCompletedAssistant: assistant,
        sourceReplyDeliveryState: attemptDelivery,
        messagingToolSourceReplyPayloads: [{ text: "Committed reply.", sourceReplyFinal: true }],
      });
      const input = createSettledFinalizationTestInput(
        attempt,
        createTestAdmittedRunContext("run-confirmed-delivery"),
      );
      input.terminalBase.runParams.sourceReplyDeliveryMode = "automatic";
      input.terminalBase.runParams.resolveReplyDelivery = async () => observedDelivery;
      const settled = await prepareTerminalWithSettledTurnFinalization(input);
      expect(settled.prepared.replyDeliveryState).toBe("delivered");
      expect(settled.prepared.payloadsWithToolMedia).toEqual([
        expect.objectContaining({ text: "Committed reply." }),
      ]);
      expect(settled.prepared.agentMeta.terminalReceipt?.sourceReplyDelivered).toBe(true);
    },
  );

  it("preserves a tool-authored source projection and its owned media while custody is pending", async () => {
    const assistant = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "reply-tool", name: "report", arguments: {} }],
    });
    const attempt: EmbeddedRunAttemptWithReceiptEvidence = makeEmbeddedRunnerAttempt({
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptCompletedAssistant: assistant,
      sourceReplyDeliveryState: "missing",
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
    const input = createSettledFinalizationTestInput(
      attempt,
      createTestAdmittedRunContext("run-tool-projection"),
    );
    input.terminalBase.runParams.resolveReplyDelivery = async () => "pending";
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
      const earlier = buildEmbeddedRunnerAssistant({
        content: [{ type: "text", text: "Earlier answer." }],
      });
      const current = buildEmbeddedRunnerAssistant({
        content: [{ type: "text", text: "Current answer." }],
      });
      const attempt: EmbeddedRunAttemptWithReceiptEvidence = makeEmbeddedRunnerAttempt({
        assistantTexts: ["Earlier answer.", "Current answer."],
        lastAssistant: current,
        currentAttemptAssistant: current,
        currentAttemptCompletedAssistant: current,
        sourceReplyDeliveryState: "missing",
        ...(heartbeat
          ? {
              heartbeatToolResponse: {
                outcome: "done" as const,
                notify: true,
                summary: "Current heartbeat report.",
              },
            }
          : {}),
      });
      attempt.answerSegments = [
        {
          textEnd: 1,
          messageEnd: 1,
          finalMessageStart: 1,
          lastAssistant: earlier,
          sourceReplyDeliveryState: "missing",
        },
      ];
      const input = createSettledFinalizationTestInput(
        attempt,
        createTestAdmittedRunContext("run-preceding-answer"),
      );
      input.terminalBase.runParams.sourceReplyDeliveryMode = "automatic";
      input.terminalBase.runParams.resolveReplyDelivery = async () => "pending";
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
