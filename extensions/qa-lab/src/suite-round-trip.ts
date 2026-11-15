import { randomUUID } from "node:crypto";
import type { QaBusInboundMessageInput } from "openclaw/plugin-sdk/qa-channel-protocol";
import {
  summarizeLiveTransportRttSamples,
  type LiveTransportRttSample,
} from "./live-transports/shared/live-transport-rtt.js";
import type { QaTransportAdapter } from "./qa-transport.js";

type RoundTripInput = Omit<QaBusInboundMessageInput, "replyToId" | "text">;

export type QaSuiteRoundTripProbe = {
  scenarioId: string;
  count: number;
  maxFailures: number;
  timeoutMs: number;
  markerPrefix: string;
  input: RoundTripInput | { fromScenario: true; senderId: string; senderName?: string };
  textPrefix: string;
  chainReplies?: boolean;
};

export async function runQaSuiteRoundTripProbe(params: {
  probe: QaSuiteRoundTripProbe;
  transport: Pick<QaTransportAdapter, "accountId" | "state" | "sendInbound" | "waitForOutbound">;
  scenarioStartCursor?: number;
}) {
  const snapshot = params.transport.state.getSnapshot();
  const { messages } = snapshot;
  const requestedInput = params.probe.input;
  const fromScenario = "fromScenario" in requestedInput;
  let input: RoundTripInput;
  if (fromScenario) {
    const startCursor = params.scenarioStartCursor;
    if (startCursor === undefined) {
      throw new Error("QA round-trip scenario requires its attempt start cursor");
    }
    // Delivery-only scenarios retain outbound observations, not an inbound message.
    const observed = snapshot.events
      .filter((event) => event.kind === "inbound-message" || event.kind === "outbound-message")
      .findLast(
        (event) =>
          event.cursor > startCursor &&
          event.accountId === params.transport.accountId &&
          messages.some(
            (message) =>
              !message.deleted &&
              message.id === event.message.id &&
              message.accountId === event.accountId &&
              message.conversation.id === event.message.conversation.id &&
              message.conversation.kind === event.message.conversation.kind,
          ),
      )?.message;
    if (!observed) {
      throw new Error(
        `QA round-trip scenario has no observed conversation: ${params.probe.scenarioId}`,
      );
    }
    input = {
      accountId: observed.accountId,
      conversation: observed.conversation,
      threadId: observed.threadId,
      senderId: requestedInput.senderId,
      senderName: requestedInput.senderName,
    };
  } else {
    input = requestedInput;
  }
  const samples: LiveTransportRttSample[] = [];
  let failures = 0;
  let passed = 0;
  // A scenario can use another participant; only chain this probe's own native replies.
  let latestReplyId = fromScenario
    ? undefined
    : messages.findLast(
        (message) =>
          message.direction === "outbound" &&
          !message.deleted &&
          (!input.accountId || message.accountId === input.accountId) &&
          message.conversation.id === input.conversation.id &&
          message.conversation.kind === input.conversation.kind &&
          message.threadId === input.threadId,
      )?.id;

  for (let index = 1; passed < params.probe.count; index += 1) {
    const marker = `${params.probe.markerPrefix}-${index}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const outboundStartIndex = params.transport.state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound").length;
    const startedAt = Date.now();
    try {
      await params.transport.sendInbound({
        ...input,
        text: `${params.probe.textPrefix}${marker}`,
        ...(params.probe.chainReplies && latestReplyId ? { replyToId: latestReplyId } : {}),
      });
      const reply = await params.transport.waitForOutbound({
        conversation: input.conversation,
        threadId: input.threadId,
        sinceIndex: outboundStartIndex,
        textIncludes: marker,
        timeoutMs: params.probe.timeoutMs,
      });
      if (reply.threadId !== input.threadId) {
        throw new Error("QA round-trip reply arrived in a different thread");
      }
      latestReplyId = reply.id;
      samples.push({ status: "pass", rttMs: Math.max(1, Date.now() - startedAt) });
      passed += 1;
    } catch {
      samples.push({ status: "fail" });
      failures += 1;
    }
    if (failures >= params.probe.maxFailures) {
      break;
    }
  }

  const summary = summarizeLiveTransportRttSamples(samples);
  return {
    ...summary,
    details: `${summary.passed}/${samples.length} RTT checks passed`,
  };
}
