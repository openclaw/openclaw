import { buildQaTarget } from "openclaw/plugin-sdk/qa-channel-protocol";
import type { QaBusInboundMessageInput } from "openclaw/plugin-sdk/qa-channel-protocol";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { runQaSuiteRoundTripProbe } from "./suite-round-trip.js";

describe("QA suite round-trip probe", () => {
  it.each([
    { id: "telegram-reply-chain-dm", kind: "direct", outboundOnly: false },
    { id: "telegram-command-room", kind: "channel", outboundOnly: false },
    { id: "delivery-dm", kind: "direct", outboundOnly: true },
    { id: "participant-forum", kind: "group", threadId: "42", outboundOnly: false },
  ] as const)(
    "continues the observed $id route without adopting another participant's reply",
    async (route) => {
      const state = createQaBusState();
      const conversation = { id: route.id, kind: route.kind };
      const threadId = "threadId" in route ? route.threadId : undefined;
      const target = buildQaTarget({ chatType: route.kind, conversationId: route.id, threadId });
      state.addOutboundMessage({ accountId: "sut", to: "group:prior-scenario", text: "old" });
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
      const priorReply = state.addOutboundMessage({
        accountId: "sut",
        to: target,
        text: "prior reply",
      });
      const deleted = state.addOutboundMessage({
        accountId: "sut",
        to: "group:deleted",
        text: "deleted",
      });
      state.deleteMessage({ accountId: "sut", messageId: deleted.id });
      state.addOutboundMessage({ accountId: "foreign", to: "group:foreign", text: "foreign" });
      const replies: string[] = [];
      const sendInbound = vi.fn(async (input: QaBusInboundMessageInput) => {
        const message = state.addInboundMessage(input);
        const reply = state.addOutboundMessage({
          accountId: "sut",
          to: buildQaTarget({
            chatType: input.conversation.kind,
            conversationId: input.conversation.id,
            threadId: input.threadId,
          }),
          text: input.text,
          replyToId: message.id,
        });
        replies.push(reply.id);
        return message;
      });
      const waitForOutbound = vi.fn(async () => {
        const reply = state
          .getSnapshot()
          .messages.findLast((message) => message.direction === "outbound" && !message.deleted);
        if (!reply) {
          throw new Error("fixture did not record the probe reply");
        }
        return reply;
      });
      try {
        const result = await runQaSuiteRoundTripProbe({
          probe: {
            scenarioId: "selected-scenario",
            count: 2,
            maxFailures: 1,
            timeoutMs: 1_000,
            markerPrefix: "QA-RTT",
            input: { fromScenario: true, senderId: "primary" },
            textPrefix: "Reply exactly: ",
            chainReplies: true,
          },
          transport: { accountId: "sut", state, sendInbound, waitForOutbound },
          scenarioStartCursor,
        });
        expect(result).toMatchObject({ passed: 2, failed: 0 });
        expect(sendInbound.mock.calls.map(([input]) => input)).toEqual([
          expect.objectContaining({
            accountId: "sut",
            conversation,
            threadId,
            senderId: "primary",
          }),
          expect.objectContaining({
            accountId: "sut",
            conversation,
            threadId,
            senderId: "primary",
            replyToId: replies[0],
          }),
        ]);
        const first = sendInbound.mock.calls[0]?.[0];
        expect(first).not.toHaveProperty("replyToId");
        expect(first).not.toHaveProperty("nativeCommand");
        expect(sendInbound.mock.calls.map(([input]) => input.replyToId)).not.toContain(
          priorReply.id,
        );
        expect(waitForOutbound).toHaveBeenCalledWith(
          expect.objectContaining({ conversation, threadId }),
        );
      } finally {
        state.reset(true);
      }
    },
  );

  it("refuses to reuse a previous scenario route when this attempt has no surviving messages", async () => {
    const state = createQaBusState();
    state.addOutboundMessage({ accountId: "sut", to: "group:prior", text: "prior" });
    const scenarioStartCursor = state.getSnapshot().cursor;
    const deleted = state.addOutboundMessage({
      accountId: "sut",
      to: "group:selected",
      text: "removed",
    });
    state.deleteMessage({ accountId: "sut", messageId: deleted.id });
    state.addOutboundMessage({ accountId: "foreign", to: "group:foreign", text: "foreign" });
    const sendInbound = vi.fn();
    try {
      await expect(
        runQaSuiteRoundTripProbe({
          probe: {
            scenarioId: "selected-scenario",
            count: 1,
            maxFailures: 1,
            timeoutMs: 1_000,
            markerPrefix: "QA-RTT",
            input: { fromScenario: true, senderId: "primary" },
            textPrefix: "Reply exactly: ",
          },
          transport: { accountId: "sut", state, sendInbound, waitForOutbound: vi.fn() },
          scenarioStartCursor,
        }),
      ).rejects.toThrow("no observed conversation: selected-scenario");
      expect(sendInbound).not.toHaveBeenCalled();
    } finally {
      state.reset(true);
    }
  });

  it("collects requested samples and chains native replies", async () => {
    const messages: Array<{ direction: "outbound"; id: string }> = [];
    const sendInbound = vi.fn().mockResolvedValue({ id: "inbound" });
    const waitForOutbound = vi.fn().mockImplementation(async () => {
      const reply = { id: `out-${messages.length + 1}` };
      messages.push({ direction: "outbound", id: reply.id });
      return reply;
    });

    const result = await runQaSuiteRoundTripProbe({
      probe: {
        scenarioId: "channel-canary",
        count: 2,
        maxFailures: 2,
        timeoutMs: 1_000,
        markerPrefix: "QA-RTT",
        input: {
          conversation: { id: "room", kind: "group" },
          senderId: "driver",
        },
        textPrefix: "Reply exactly: ",
        chainReplies: true,
      },
      transport: {
        state: {
          getSnapshot: () => ({ messages }),
        },
        sendInbound,
        waitForOutbound,
      } as never,
    });

    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.timing.samples).toBe(2);
    expect(sendInbound.mock.calls[1]?.[0]).toMatchObject({ replyToId: "out-1" });
  });

  it.each(["timeout", "off-thread reply"])(
    "stops at the failure budget after a %s",
    async (failure) => {
      const result = await runQaSuiteRoundTripProbe({
        probe: {
          scenarioId: "channel-canary",
          count: 3,
          maxFailures: 1,
          timeoutMs: 10,
          markerPrefix: "QA-RTT",
          input: {
            conversation: { id: "room", kind: "group" },
            senderId: "driver",
          },
          textPrefix: "Reply exactly: ",
        },
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
