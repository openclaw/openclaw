/**
 * Delivery-boundary coverage for the private requester incarnation.
 *
 * A parent-only announcement is bound to the requester *incarnation* recorded
 * at spawn: `sendSubagentAnnounceDirectly` admits the wake only when the
 * forwarded `completionRequesterSessionId` matches the live requester's session
 * id AND the forwarded `completionRequesterLifecycleRevision` matches that
 * session's stored `lifecycleRevision`. Either half missing or stale makes the
 * wake `intentional_non_delivery`, which every announce caller treats as
 * settled — so a producer that forwards an incomplete binding loses the
 * notification permanently rather than retrying it.
 *
 * The existing private cases in `subagent-announce-delivery.test.ts` cover the
 * session-id half ("does not deliver private completion to a missing or
 * replaced parent") but leave the requester entry absent, so
 * `requesterEntry?.lifecycleRevision` and the forwarded revision were both
 * `undefined` and compared equal. That is why the whole suite passed while a
 * producer omitted the revision. These cases seed a requester entry that
 * carries a real revision, which is what makes the comparison load-bearing.
 *
 * Separate file rather than new cases in `subagent-announce-delivery.test.ts`:
 * that file is grandfathered in `config/max-lines-baseline.txt` and
 * `check:line-cap-ratchet` rejects any growth in it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";
import { taskCompletionEvents } from "../../subagent-test-fixtures.test-helpers.js";
import { deliverSubagentAnnouncement, testing } from "./subagent-announce-delivery.test-support.js";
import type { SubagentAnnounceDeliveryTestDeps } from "./subagent-announce-overrides.test-support.js";

type SendMessage = SubagentAnnounceDeliveryTestDeps["sendMessage"];

const REQUESTER_KEY = "agent:main:discord:dm:U123";
const REQUESTER_SESSION_ID = "requester-session-private";
const RECORDED_REVISION = "rev-private-parent";
const CHILD_SESSION_KEY = "agent:main:subagent:private-binding-child";
const origin = { channel: "discord", to: "dm:U123", accountId: "acct-1" } as const;

/**
 * Drives the real direct-delivery owner for a parent-only wake. The requester
 * entry is the live incarnation; `forwardedRevision` is what the producer
 * claims, so a case can present a correct, missing or stale binding.
 */
async function deliverPrivateWake(params: {
  forwardedRevision: string | undefined;
  storedRevision?: string;
}) {
  const requesterEntry: SessionEntry = {
    sessionId: REQUESTER_SESSION_ID,
    lifecycleRevision: params.storedRevision ?? RECORDED_REVISION,
    updatedAt: 1,
  };
  const callGateway = vi.fn(async () => ({ result: { payloads: [] } }));
  const sendMessage = vi.fn<SendMessage>(async () => ({
    channel: "discord",
    to: "dm:U123",
    via: "direct" as const,
    mediaUrl: null,
    result: { messageId: "unexpected-private-fallback" },
  }));
  testing.setDepsForTest({
    callGateway,
    sendMessage,
    getRuntimeConfig: () => ({}),
    loadRequesterSessionEntry: (canonicalKey: string) => ({
      cfg: {},
      canonicalKey,
      agentId: "main",
      storePath: "/synthetic/private-binding/sessions.json",
      entry: requesterEntry,
    }),
    getRequesterSessionActivity: () => ({
      sessionId: REQUESTER_SESSION_ID,
      isActive: true,
    }),
  });
  const result = await deliverSubagentAnnouncement({
    requesterSessionKey: REQUESTER_KEY,
    targetRequesterSessionKey: REQUESTER_KEY,
    triggerMessage: "child may still be working",
    requesterSessionOrigin: origin,
    completionDirectOrigin: origin,
    directOrigin: origin,
    requesterIsSubagent: false,
    expectsCompletionMessage: true,
    bestEffortDeliver: true,
    directIdempotencyKey: "announce-private-binding",
    completionTarget: "parent",
    completionRequesterSessionId: REQUESTER_SESSION_ID,
    ...(params.forwardedRevision === undefined
      ? {}
      : { completionRequesterLifecycleRevision: params.forwardedRevision }),
    internalEvents: taskCompletionEvents({
      childSessionKey: CHILD_SESSION_KEY,
      childSessionId: "private-binding-child-session",
      result: "still running",
    }),
    sourceRunId: "run-private-binding",
    sourceSessionKey: CHILD_SESSION_KEY,
    sourceTool: "subagent_announce",
  });
  return { result, callGateway, sendMessage };
}

afterEach(() => {
  setActivePluginRegistry(createTestRegistry());
  testing.setDepsForTest();
});

describe("private announcement requester-incarnation binding", () => {
  it("admits a wake that forwards the recorded requester incarnation", async () => {
    const { result, callGateway } = await deliverPrivateWake({
      forwardedRevision: RECORDED_REVISION,
    });

    // Admission is the discriminating observable: the owner only reaches the
    // requester dispatch after the binding comparison passes.
    expect(callGateway).toHaveBeenCalled();
    expect(result.reason).not.toBe("completion_handoff_unavailable");
    expect(result.disposition).not.toBe("intentional_non_delivery");
  });

  it.each([
    { name: "omitted", forwardedRevision: undefined },
    { name: "replaced", forwardedRevision: "rev-private-parent-replaced" },
  ])(
    "refuses a wake whose forwarded requester revision is $name",
    async ({ forwardedRevision }) => {
      const { result, callGateway, sendMessage } = await deliverPrivateWake({
        forwardedRevision,
      });

      expect(result).toMatchObject({
        delivered: false,
        path: "none",
        reason: "completion_handoff_unavailable",
        terminal: true,
        disposition: "intentional_non_delivery",
      });
      // Terminal before admission, so nothing reaches the requester and no
      // external fallback runs either.
      expect(callGateway).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );
});
