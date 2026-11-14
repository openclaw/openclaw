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
const normalizedSilence = {
  ...silentResult,
  deliveryStatus: {
    status: "suppressed",
    succeeded: true,
    reason: "no_visible_payload",
    resultCount: 0,
  },
};
const publicGroup = { public: true, group: true };
const failedSilence = { ...silentResult, meta: { ...silentResult.meta, aborted: true } };
const requiredSilence = {
  ...silentResult,
  meta: { ...silentResult.meta, terminalReplyExpectation: "result-required" },
};
const partial = (meta: Record<string, unknown>) =>
  ok({ ...policySuppression, payloads: payloads("partial answer"), meta });
type SettleCase = {
  response: unknown;
  expected: Record<string, unknown>;
  options?: { public?: boolean; group?: boolean; replaced?: boolean };
};

it.each`
  name                                                      | response                                                            | expected                                                                          | options
  ${"delivered final"}                                      | ${ok(visibleResult)}                                                | ${visibleReply}                                                                   | ${undefined}
  ${"required public reply"}                                | ${ok(visibleResult)}                                                | ${visibleReply}                                                                   | ${publicGroup}
  ${"required public silence"}                              | ${ok(silentResult)}                                                 | ${{ delivered: true }}                                                            | ${publicGroup}
  ${"normalized silent result: ok"}                         | ${ok(normalizedSilence)}                                            | ${{ delivered: true }}                                                            | ${undefined}
  ${"normalized silent result: timeout"}                    | ${{ status: "timeout", result: normalizedSilence }}                 | ${missingReply}                                                                   | ${undefined}
  ${"runtime timeout"}                                      | ${{ status: "timeout", summary: "aborted", stopReason: "timeout" }} | ${missingReply}                                                                   | ${undefined}
  ${"failed turn"}                                          | ${{ status: "error" }}                                              | ${missingReply}                                                                   | ${undefined}
  ${"empty successful optional turn"}                       | ${ok({ payloads: [] })}                                             | ${{ delivered: true }}                                                            | ${undefined}
  ${"optional silence promoted to a required human reply"}  | ${ok(requiredSilence)}                                              | ${{ delivered: true }}                                                            | ${undefined}
  ${"failed silence"}                                       | ${ok(failedSilence)}                                                | ${missingReply}                                                                   | ${undefined}
  ${"undelivered text"}                                     | ${ok({ payloads: payloads("unsent answer") })}                      | ${missingReply}                                                                   | ${undefined}
  ${"private room: plain final suppressed by policy"}       | ${ok(policySuppression)}                                            | ${intentionalNonDelivery}                                                         | ${undefined}
  ${"public room: plain final suppressed by policy"}        | ${ok(policySuppression)}                                            | ${intentionalNonDelivery}                                                         | ${{ public: true }}
  ${"policy suppression cannot settle error"}               | ${partial({ error: { kind: "incomplete_turn" } })}                  | ${missingReply}                                                                   | ${undefined}
  ${"policy suppression cannot settle aborted"}             | ${partial({ aborted: true })}                                       | ${missingReply}                                                                   | ${undefined}
  ${"policy suppression cannot settle yielded"}             | ${partial({ yielded: true })}                                       | ${missingReply}                                                                   | ${undefined}
  ${"policy suppression cannot settle continuationPending"} | ${partial({ continuationPending: true })}                           | ${missingReply}                                                                   | ${undefined}
  ${"replaced requester"}                                   | ${{ status: "ok" }}                                                 | ${{ delivered: false, reason: "completion_handoff_unavailable", terminal: true }} | ${{ replaced: true }}
`(
  "requires real completion evidence: $name",
  async ({ response, expected, options = {} }: SettleCase) => {
    const to = options.group ? "channel:room-1" : "dm:U123";
    const sessionKey = `agent:main:discord:${to}`;
    const origin = { channel: "discord", to, accountId: "acct-1" };
    const current = options.replaced ? "replacement-parent" : "requester-session-dm";
    const dispatch = vi.fn<
      typeof import("./subagent-announce.runtime.js").dispatchGatewayMethodInProcess
    >(async <T>() => response as T);
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
      ...(options.public
        ? { requireVisibleReply: true }
        : { completionRequesterSessionId: "requester-session-dm" }),
      directIdempotencyKey: "announce:requester-settle:private",
    });
    expect(result).toMatchObject(expected);
    if (options.replaced) {
      expect(dispatch).not.toHaveBeenCalled();
    } else {
      expect(dispatch.mock.calls[0]?.slice(1)).toMatchObject([
        options.public ? {} : { expectedExistingSessionId: "requester-session-dm" },
        { replyExpectation: options.public ? "required" : "optional" },
      ]);
      // The conversation's configured reply policy decides, not this handoff.
      expect(dispatch.mock.calls[0]?.[1]).not.toHaveProperty("sourceReplyDeliveryMode");
    }
    expect(send).not.toHaveBeenCalled();
  },
);
