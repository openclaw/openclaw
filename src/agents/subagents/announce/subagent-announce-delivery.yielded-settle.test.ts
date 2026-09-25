// Yielded private settle finals require completion evidence and the original requester.
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { sendMessage } from "../../../infra/outbound/message.js";
import { deliverSubagentAnnouncement, testing } from "./subagent-announce-delivery.test-support.js";

const sentDeliveryStatus = { status: "sent", resultCount: 1 } as const;

describe("yielded private settle outcomes", () => {
  it.each([
    {
      name: "delivered final",
      response: {
        status: "ok",
        result: { payloads: [{ text: "parent answer" }], deliveryStatus: sentDeliveryStatus },
      },
      expected: { delivered: true, requesterVisibleFinalDelivered: true },
    },
    {
      name: "intentional silence",
      response: { status: "ok", result: { payloads: [{ text: "NO_REPLY" }] } },
      expected: { delivered: true },
    },
    ...["ok", "timeout"].map((status) => ({
      name: `normalized silent result: ${status}`,
      response: {
        status,
        result: {
          payloads: [],
          meta: { terminalReply: { disposition: "silent" } },
          deliveryStatus: {
            status: "suppressed",
            succeeded: true,
            reason: "no_visible_payload",
            resultCount: 0,
          },
        },
      },
      expected:
        status === "ok"
          ? { delivered: true }
          : { delivered: false, reason: "visible_reply_missing" },
    })),
    {
      name: "runtime timeout",
      response: { status: "timeout", summary: "aborted", stopReason: "timeout" },
      expected: { delivered: false, reason: "visible_reply_missing" },
    },
    {
      name: "failed turn",
      response: { status: "error" },
      expected: { delivered: false, reason: "visible_reply_missing" },
    },
    {
      name: "empty successful turn",
      response: { status: "ok", result: { payloads: [] } },
      expected: { delivered: false, reason: "visible_reply_missing" },
    },
    {
      name: "failed silence",
      response: {
        status: "ok",
        result: { payloads: [{ text: "NO_REPLY" }], meta: { aborted: true } },
      },
      expected: { delivered: false, reason: "visible_reply_missing" },
    },
    {
      name: "undelivered text",
      response: { status: "ok", result: { payloads: [{ text: "unsent answer" }] } },
      expected: { delivered: false, reason: "visible_reply_missing" },
    },
    {
      name: "transferred next wave",
      response: {
        status: "ok",
        result: { payloads: [], meta: { yielded: true }, requesterContinuationSettled: true },
      },
      expected: { delivered: true },
    },
    {
      name: "replaced requester",
      replaced: true,
      response: { status: "ok" },
      expected: { delivered: false, reason: "completion_handoff_unavailable", terminal: true },
    },
  ])("requires real completion evidence: $name", async (testCase) => {
    const sessionKey = "agent:main:discord:dm:U123";
    const origin = { channel: "discord", to: "dm:U123", accountId: "acct-1" };
    const current = "replaced" in testCase ? "replacement-parent" : "requester-session-dm";
    const dispatch = vi.fn(async function <T>(_method: string, _params: Record<string, unknown>) {
      return testCase.response as T;
    });
    const send = vi.fn<typeof sendMessage>();
    onTestFinished(() => testing.setDepsForTest());
    testing.setDepsForTest({
      dispatchGatewayMethodInProcess: dispatch,
      getRequesterSessionActivity: () => ({ sessionId: current, isActive: false }),
      getRuntimeConfig: () => ({}),
      loadRequesterSessionEntry: (key) => ({
        cfg: {},
        canonicalKey: key,
        entry: { sessionId: current, updatedAt: 1 },
      }),
      sendMessage: send,
    });
    const result = await deliverSubagentAnnouncement({
      requesterSessionKey: sessionKey,
      targetRequesterSessionKey: sessionKey,
      triggerMessage: "settled private findings",
      steerMessage: "settled private findings",
      requesterSessionOrigin: origin,
      directOrigin: origin,
      sourceTool: "subagent_settle",
      requesterIsSubagent: false,
      expectsCompletionMessage: false,
      requireDirectDelivery: true,
      completionRequesterSessionId: "requester-session-dm",
      directIdempotencyKey: "announce:requester-settle:private",
    });
    expect(result).toMatchObject(testCase.expected);
    if ("replaced" in testCase) {
      expect(dispatch).not.toHaveBeenCalled();
    } else {
      expect(dispatch.mock.calls[0]?.[1]).toMatchObject({
        deliver: true,
        channel: "discord",
        to: "dm:U123",
        sourceReplyDeliveryMode: "automatic",
        expectedExistingSessionId: "requester-session-dm",
      });
    }
    expect(send).not.toHaveBeenCalled();
  });
});
