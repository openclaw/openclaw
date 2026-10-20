import { expect, it, onTestFinished, vi } from "vitest";
import type { sendMessage } from "../../../infra/outbound/message.js";
import { captureSessionTarget } from "../../../sessions/session-controller.target.js";
import { deliverSubagentAnnouncement, testing } from "./subagent-announce-delivery.test-support.js";

const payloads = (text = "parent answer") => [{ text }];
const visibleResult = { payloads: payloads(), deliveryStatus: { status: "sent", resultCount: 1 } };
const silentResult = { payloads: [], meta: { terminalReply: { disposition: "silent" } } };
const missingReply = { delivered: false, reason: "visible_reply_missing" };
const visibleReply = { delivered: true, requesterVisibleFinalDelivered: true };
const intentionalNonDelivery = {
  delivered: false,
  disposition: "intentional_non_delivery",
  terminal: true,
};
const ok = (result: unknown) => ({ status: "ok", result });
const policySuppression = {
  payloads: payloads(),
  deliveryStatus: { status: "suppressed", reason: "message_tool_only", resultCount: 0 },
};
const settleCase = (
  name: string,
  response: unknown,
  expected: Record<string, unknown> = missingReply,
  options: { public?: boolean; group?: boolean; replaced?: boolean } = {},
) => ({ name, response, expected, ...options });

it.each([
  settleCase("delivered final", ok(visibleResult), visibleReply),
  settleCase(
    "required public reply in a group that allows silence",
    ok(visibleResult),
    visibleReply,
    { public: true, group: true },
  ),
  settleCase("intentional silence", ok(silentResult), { delivered: true }),
  ...["ok", "timeout"].map((status) => ({
    name: `normalized silent result: ${status}`,
    response: {
      status,
      result: {
        ...silentResult,
        deliveryStatus: {
          status: "suppressed",
          succeeded: true,
          reason: "no_visible_payload",
          resultCount: 0,
        },
      },
    },
    expected: status === "ok" ? { delivered: true } : missingReply,
  })),
  settleCase("runtime timeout", { status: "timeout", summary: "aborted", stopReason: "timeout" }),
  settleCase("failed turn", { status: "error" }),
  settleCase("empty successful turn", ok({ payloads: [] })),
  settleCase(
    "failed silence",
    ok({ ...silentResult, meta: { ...silentResult.meta, aborted: true } }),
  ),
  settleCase("undelivered text", ok({ payloads: payloads("unsent answer") })),
  settleCase(
    "message-tool room: final sent with the message tool",
    ok({
      payloads: [],
      didSendViaMessagingTool: true,
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "discord",
          accountId: "acct-1",
          to: "dm:U123",
          text: "parent answer",
          sourceReplyFinal: true,
        },
      ],
    }),
    visibleReply,
  ),
  ...[false, true].map((publicReply) =>
    settleCase(
      `${publicReply ? "public" : "private"} room: plain final suppressed by policy`,
      ok(policySuppression),
      intentionalNonDelivery,
      publicReply ? { public: true } : {},
    ),
  ),
  ...[
    { error: { kind: "incomplete_turn" } },
    { aborted: true },
    { yielded: true },
    { continuationPending: true },
  ].map((meta) =>
    settleCase(
      "policy suppression cannot settle " + Object.keys(meta)[0],
      ok({ ...policySuppression, payloads: payloads("partial answer"), meta }),
    ),
  ),
  settleCase(
    "transferred next wave",
    ok({ payloads: [], meta: { yielded: true }, requesterContinuationSettled: true }),
    { delivered: true },
  ),
  settleCase(
    "replaced requester",
    { status: "ok" },
    { delivered: false, reason: "completion_handoff_unavailable", terminal: true },
    { replaced: true },
  ),
])("requires real completion evidence: $name", async (testCase) => {
  const to = "group" in testCase && testCase.group ? "channel:room-1" : "dm:U123";
  const sessionKey = `agent:main:discord:${to}`;
  const origin = { channel: "discord", to, accountId: "acct-1" };
  const current = "replaced" in testCase ? "replacement-parent" : "requester-session-dm";
  const dispatch = vi.fn(async function <T>(
    _method: string,
    _params: Record<string, unknown>,
    _options?: unknown,
  ) {
    return testCase.response as T;
  });
  const send = vi.fn<typeof sendMessage>();
  onTestFinished(() => testing.setDepsForTest());
  testing.setDepsForTest({
    dispatchGatewayMethodInProcess: dispatch,
    getRequesterSessionActivity: () => ({
      sessionId: current,
      isActive: false,
      target: captureSessionTarget({
        storeScope: "/synthetic/yielded-settle/sessions.json",
        sessionKey,
        incarnation: current,
      }),
    }),
    getRuntimeConfig: () => ({ surfaces: { discord: { silentReply: { group: "allow" } } } }),
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
    requesterSessionOrigin: origin,
    directOrigin: origin,
    sourceTool: "subagent_settle",
    requesterIsSubagent: false,
    expectsCompletionMessage: false,
    ...("public" in testCase
      ? { requireVisibleReply: true }
      : { completionRequesterSessionId: "requester-session-dm" }),
    directIdempotencyKey: "announce:requester-settle:private",
  });
  expect(result).toMatchObject(testCase.expected);
  if ("replaced" in testCase) {
    expect(dispatch).not.toHaveBeenCalled();
  } else {
    expect(dispatch.mock.calls[0]?.slice(1)).toMatchObject([
      {
        deliver: true,
        channel: "discord",
        to,
        ...("public" in testCase ? {} : { expectedExistingSessionId: "requester-session-dm" }),
      },
      { replyExpectation: "public" in testCase ? "required" : "optional" },
    ]);
    // The conversation's configured reply policy decides, not this handoff.
    expect(dispatch.mock.calls[0]?.[1]).not.toHaveProperty("sourceReplyDeliveryMode");
  }
  expect(send).not.toHaveBeenCalled();
});
