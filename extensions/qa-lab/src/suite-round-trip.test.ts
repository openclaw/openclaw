import { buildQaTarget } from "openclaw/plugin-sdk/qa-channel-protocol";
import type { QaBusInboundMessageInput } from "openclaw/plugin-sdk/qa-channel-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { runQaSuiteRoundTripProbe, type QaSuiteRoundTripProbe } from "./suite-round-trip.js";

function makeProbe(overrides: Partial<QaSuiteRoundTripProbe> = {}): QaSuiteRoundTripProbe {
  return {
    scenarioId: "channel-canary",
    count: 2,
    maxFailures: 2,
    timeoutMs: 1_000,
    markerPrefix: "QA-RTT",
    input: { conversation: { id: "room", kind: "group" }, senderId: "driver" },
    textPrefix: "Reply exactly: ",
    ...overrides,
  };
}

describe("QA suite round-trip probe", () => {
  let state: ReturnType<typeof createQaBusState>;
  beforeEach(() => {
    state = createQaBusState();
  });
  afterEach(() => state.reset(true));
  const observed = {
    scenarioId: "selected-scenario",
    maxFailures: 1,
    input: { fromScenario: true, senderId: "primary" },
  } as const;
  const addOutbound = (to: string, text: string, accountId = "sut") =>
    state.addOutboundMessage({ accountId, to, text });

  function echoTransport() {
    const replies: ReturnType<typeof state.addOutboundMessage>[] = [];
    const sendInbound = vi.fn(async (input: QaBusInboundMessageInput) => {
      const message = state.addInboundMessage(input);
      replies.push(
        state.addOutboundMessage({
          accountId: "sut",
          to: buildQaTarget({
            chatType: input.conversation.kind,
            conversationId: input.conversation.id,
            threadId: input.threadId,
          }),
          text: input.text,
          replyToId: message.id,
        }),
      );
      return message;
    });
    const waitForOutbound = vi.fn(async () => {
      const reply = replies.at(-1);
      if (!reply) {
        throw new Error("fixture did not record the probe reply");
      }
      return reply;
    });
    return { accountId: "sut", state, sendInbound, waitForOutbound, replies };
  }

  it.each([
    { id: "telegram-reply-chain-dm", kind: "direct", outboundOnly: false },
    { id: "telegram-command-room", kind: "channel", outboundOnly: false },
    { id: "delivery-dm", kind: "direct", outboundOnly: true },
    { id: "participant-forum", kind: "group", threadId: "42", outboundOnly: false },
  ] as const)(
    "continues the observed $id route without adopting another participant's reply",
    async (route) => {
      const conversation = { id: route.id, kind: route.kind };
      const threadId = "threadId" in route ? route.threadId : undefined;
      const target = buildQaTarget({ chatType: route.kind, conversationId: route.id, threadId });
      addOutbound("group:prior-scenario", "old");
      const scenarioStartCursor = state.getSnapshot().cursor;
      if (!route.outboundOnly) {
        state.addInboundMessage({
          accountId: "sut",
          conversation,
          threadId,
          senderId: "other-participant",
          text: "/status",
          nativeCommand: { name: "status" },
        });
      }
      const priorReply = addOutbound(target, "prior reply");
      const deleted = addOutbound("group:deleted", "deleted");
      state.deleteMessage({ accountId: "sut", messageId: deleted.id });
      addOutbound("group:foreign", "foreign", "foreign");
      const transport = echoTransport();
      const { replies, sendInbound, waitForOutbound } = transport;
      const result = await runQaSuiteRoundTripProbe({
        probe: makeProbe({ ...observed, chainReplies: true }),
        transport,
        scenarioStartCursor,
      });
      expect(result).toMatchObject({ passed: 2, failed: 0 });
      const expectedInput = { accountId: "sut", conversation, threadId, senderId: "primary" };
      expect(sendInbound.mock.calls.map(([input]) => input)).toMatchObject([
        expectedInput,
        { ...expectedInput, replyToId: replies[0]!.id },
      ]);
      const first = sendInbound.mock.calls[0]?.[0];
      expect(first).not.toHaveProperty("replyToId");
      expect(first).not.toHaveProperty("nativeCommand");
      expect(sendInbound.mock.calls.map(([input]) => input.replyToId)).not.toContain(priorReply.id);
      expect(waitForOutbound).toHaveBeenCalledWith(
        expect.objectContaining({ conversation, threadId }),
      );
    },
  );

  it("refuses to reuse a previous scenario route when this attempt has no surviving messages", async () => {
    addOutbound("group:prior", "prior");
    const scenarioStartCursor = state.getSnapshot().cursor;
    const deleted = addOutbound("group:selected", "removed");
    state.deleteMessage({ accountId: "sut", messageId: deleted.id });
    addOutbound("group:foreign", "foreign", "foreign");
    const sendInbound = vi.fn();
    await expect(
      runQaSuiteRoundTripProbe({
        probe: makeProbe({ ...observed, count: 1 }),
        transport: { accountId: "sut", state, sendInbound, waitForOutbound: vi.fn() },
        scenarioStartCursor,
      }),
    ).rejects.toThrow("no observed conversation: selected-scenario");
    expect(sendInbound).not.toHaveBeenCalled();
  });

  it("collects requested samples and chains native replies", async () => {
    const transport = echoTransport();
    const result = await runQaSuiteRoundTripProbe({
      probe: makeProbe({ chainReplies: true }),
      transport,
    });

    expect(result).toMatchObject({ passed: 2, failed: 0, timing: { samples: 2 } });
    expect(transport.sendInbound.mock.calls[1]?.[0]).toMatchObject({
      replyToId: transport.replies[0]!.id,
    });
  });

  it.each(["timeout", "off-thread reply"])(
    "stops at the failure budget after a %s",
    async (failure) => {
      const result = await runQaSuiteRoundTripProbe({
        probe: makeProbe({ count: 3, maxFailures: 1, timeoutMs: 10 }),
        transport: {
          state: { getSnapshot: () => ({ messages: [] }) },
          sendInbound: vi.fn(),
          waitForOutbound:
            failure === "timeout"
              ? vi.fn().mockRejectedValue(new Error("timeout"))
              : vi.fn().mockResolvedValue({ id: "wrong-thread", threadId: "42" }),
        } as never,
      });

      expect(result).toMatchObject({ passed: 0, failed: 1 });
    },
  );
});
