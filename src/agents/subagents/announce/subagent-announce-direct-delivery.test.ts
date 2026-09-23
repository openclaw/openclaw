import { describe, expect, it, onTestFinished, vi } from "vitest";
import * as sessionEntryWorker from "../../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { sendMessage } from "../../../infra/outbound/message.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { EmbeddedAgentQueueMessageOutcome } from "../../embedded-agent-runner/runs.js";
import { deliverSubagentAnnouncement, testing } from "./subagent-announce-delivery.test-support.js";

const sentDeliveryStatus = { status: "sent", resultCount: 1 } as const;

describe("late exact requester recovery", () => {
  const sessionKey = "agent:main:requester-settle";
  const sourceRunId = "announce-requester-settle-recovery";
  const finalReceipt: Partial<SessionEntry> = {
    restartRecoveryTerminalRunIds: [sourceRunId],
    restartRecoveryTerminalDeliveryEvidence: [
      {
        runId: sourceRunId,
        transcriptRunId: "recovery-successor",
        captured: true,
        payloads: [{ visible: true }],
        deliveryStatus: { status: "sent", resultCount: 1 },
      },
    ],
  };

  function setup() {
    const controller = new AbortController();
    let ownedDelivery: ReturnType<typeof deliverSubagentAnnouncement> | undefined;
    const dispatchEntered = createDeferredCore();
    const dispatchDone = createDeferredCore<unknown>();
    const readEntered = createDeferredCore();
    const readDone = createDeferredCore();
    const initialEntry: SessionEntry = {
      sessionId: "requester-session",
      lifecycleRevision: "requester-revision",
      updatedAt: 1,
    };
    const state = { entry: initialEntry, allowed: true };
    const storePath = "/synthetic/requester-recovery/sessions.json";
    const cfg: OpenClawConfig = { session: { store: storePath } };
    const dispatch = vi.fn(async function <T>() {
      dispatchEntered.resolve();
      return (await dispatchDone.promise) as T;
    });
    const read = vi
      .spyOn(sessionEntryWorker, "readSessionEntriesFromStoreInWorker")
      .mockImplementation(async () => {
        readEntered.resolve();
        await readDone.promise;
        return {
          kind: "session-exact-entries",
          entries: [{ sessionKey, entry: state.entry }],
          lifecycleTimestamps: {},
        };
      });
    onTestFinished(async () => {
      // Revoke permission before releasing held boundaries, then join the
      // invocation before restoring its reader spy and shared dependencies.
      controller.abort();
      dispatchDone.resolve({ status: "error", stopReason: "rpc" });
      readDone.resolve();
      try {
        if (ownedDelivery) {
          await Promise.allSettled([ownedDelivery]);
        }
      } finally {
        try {
          read.mockRestore();
        } finally {
          testing.setDepsForTest();
        }
      }
    });
    const send = vi.fn<typeof sendMessage>().mockResolvedValue({
      channel: "slack",
      to: "channel:C123",
      via: "direct",
      mediaUrl: null,
      result: { messageId: "unexpected-replay" },
    });
    const steer = vi.fn((sessionId: string): EmbeddedAgentQueueMessageOutcome => ({
      queued: false,
      sessionId,
      reason: "not_streaming",
      gatewayHealth: "live",
    }));
    testing.setDepsForTest({
      getRuntimeConfig: () => cfg,
      loadRequesterSessionEntry: (key) => ({
        cfg,
        canonicalKey: key,
        agentId: "main",
        storePath,
        entry: initialEntry,
      }),
      getRequesterSessionActivity: () => ({ sessionId: initialEntry.sessionId, isActive: false }),
      dispatchGatewayMethodInProcess: dispatch,
      sendMessage: send,
      queueEmbeddedAgentMessageWithOutcome: steer,
    });
    const params: Parameters<typeof deliverSubagentAnnouncement>[0] = {
      requesterSessionKey: sessionKey,
      requesterAgentId: "main",
      targetRequesterSessionKey: sessionKey,
      triggerMessage: "All children settled",
      steerMessage: "All children settled",
      directOrigin: { channel: "slack", to: "channel:C123", accountId: "acct-1" },
      sourceTool: "subagent_settle",
      requesterIsSubagent: false,
      expectsCompletionMessage: false,
      requireDirectDelivery: true,
      requireVisibleReply: true,
      directIdempotencyKey: sourceRunId,
      isSourceSessionEffectsAllowed: () => state.allowed,
      signal: controller.signal,
    };
    const startDelivery = () => {
      if (ownedDelivery) {
        throw new Error("Fixture delivery already started");
      }
      ownedDelivery = deliverSubagentAnnouncement(params);
      return ownedDelivery;
    };
    return {
      startDelivery,
      state,
      params,
      controller,
      dispatch,
      dispatchEntered,
      dispatchDone,
      read,
      readEntered,
      readDone,
      send,
      steer,
    };
  }

  it.each([
    { name: "empty final", response: { status: "ok", result: { payloads: [] } } },
    { name: "accepted turn", response: { status: "accepted" } },
    { name: "in-flight turn", response: { status: "in_flight" } },
    { name: "restart interruption", response: { status: "error", stopReason: "restart" } },
    { name: "old keyed-input rejection", error: new Error("old keyed input rejected") },
  ])("uses a late exact receipt after $name without replay", async (outcome) => {
    const fixture = setup();
    const delivery = fixture.startDelivery();
    await fixture.dispatchEntered.promise;
    fixture.state.entry = { ...fixture.state.entry, ...finalReceipt };
    fixture.readDone.resolve();
    if ("error" in outcome) {
      fixture.dispatchDone.reject(outcome.error);
    } else {
      fixture.dispatchDone.resolve(outcome.response);
    }
    await expect(delivery).resolves.toMatchObject({
      delivered: true,
      requesterVisibleFinalDelivered: true,
    });
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.steer).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "live claim",
      patch: {
        restartRecoveryDeliverySourceRunId: sourceRunId,
        restartRecoveryDeliveryRunId: "successor",
      },
      reason: "requester_turn_pending",
      disposition: "retryable",
    },
    {
      name: "terminal without receipt",
      patch: { restartRecoveryTerminalRunIds: [sourceRunId] },
      reason: "visible_reply_missing",
      disposition: "permanent_failure",
    },
    {
      name: "unrelated source",
      patch: { restartRecoveryTerminalRunIds: ["another-source"] },
      reason: "visible_reply_missing",
      disposition: undefined,
    },
    {
      name: "replacement session",
      patch: { ...finalReceipt, sessionId: "replacement" },
      reason: "visible_reply_missing",
      disposition: undefined,
    },
    {
      name: "replacement lifecycle",
      patch: { ...finalReceipt, lifecycleRevision: "replacement" },
      reason: "visible_reply_missing",
      disposition: undefined,
    },
    {
      name: "unsent external final",
      patch: {
        restartRecoveryTerminalDeliveryEvidence: [
          { runId: sourceRunId, captured: true, payloads: [{ visible: true }] },
        ],
      },
      reason: "visible_reply_missing",
      disposition: undefined,
    },
  ] satisfies Array<{
    name: string;
    patch: Partial<SessionEntry>;
    reason: string;
    disposition: string | undefined;
  }>)(
    "does not manufacture successful delivery from $name",
    async ({ patch, reason, disposition }) => {
      const fixture = setup();
      const delivery = fixture.startDelivery();
      await fixture.dispatchEntered.promise;
      fixture.state.entry = { ...fixture.state.entry, ...patch };
      fixture.readDone.resolve();
      fixture.dispatchDone.resolve({ status: "ok", result: { payloads: [] } });
      const result = await delivery;
      expect(result).toMatchObject({ delivered: false, reason });
      expect(result.disposition).toBe(disposition);
      expect(fixture.dispatch).toHaveBeenCalledOnce();
      expect(fixture.send).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "committed final",
      response: {
        status: "ok",
        result: { payloads: [{ text: "Sent final" }], deliveryStatus: sentDeliveryStatus },
      },
      delivered: true,
      disposition: undefined,
    },
    {
      name: "partial send",
      response: {
        status: "ok",
        result: { deliveryStatus: { status: "partial_failed", resultCount: 1 } },
      },
      delivered: false,
      disposition: "ambiguous",
    },
    {
      name: "intentional suppression",
      response: {
        status: "ok",
        result: {
          deliveryStatus: {
            status: "suppressed",
            reason: "cancelled_by_message_sending_hook",
            resultCount: 0,
          },
        },
      },
      delivered: false,
      disposition: "intentional_non_delivery",
    },
    {
      name: "explicit stop",
      response: { status: "error", stopReason: "rpc" },
      delivered: false,
      disposition: undefined,
    },
    {
      name: "permanent failure",
      error: new Error("unsupported channel: fixture"),
      delivered: false,
      disposition: "permanent_failure",
    },
    {
      name: "send ambiguity",
      error: Object.assign(new Error("send outcome unknown"), { sentBeforeError: true }),
      delivered: false,
      disposition: "ambiguous",
    },
  ])("preserves the original $name", async (outcome) => {
    const fixture = setup();
    const delivery = fixture.startDelivery();
    await fixture.dispatchEntered.promise;
    fixture.state.entry = { ...fixture.state.entry, ...finalReceipt };
    if ("error" in outcome) {
      fixture.dispatchDone.reject(outcome.error);
    } else {
      fixture.dispatchDone.resolve(outcome.response);
    }
    const result = await delivery;
    expect(result.delivered).toBe(outcome.delivered);
    expect(result.disposition).toBe(outcome.disposition);
    expect(fixture.read).not.toHaveBeenCalled();
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it.each(["private", "incognito", "ordinary announcement"] as const)(
    "does not add recovery reads to %s delivery",
    async (scope) => {
      const fixture = setup();
      if (scope === "private") {
        fixture.params.completionTarget = "parent";
        fixture.params.completionRequesterSessionId = "requester-session";
      } else if (scope === "incognito") {
        fixture.params.requesterSessionKey = "agent:main:dashboard:incognito-recovery";
        fixture.params.targetRequesterSessionKey = fixture.params.requesterSessionKey;
      } else {
        fixture.params.sourceTool = "subagent_announce";
      }
      const delivery = fixture.startDelivery();
      await fixture.dispatchEntered.promise;
      fixture.state.entry = { ...fixture.state.entry, ...finalReceipt };
      fixture.dispatchDone.resolve({ status: "ok", result: { payloads: [] } });
      await expect(delivery).resolves.toMatchObject({ delivered: false });
      expect(fixture.read).not.toHaveBeenCalled();
      expect(fixture.dispatch).toHaveBeenCalledOnce();
      expect(fixture.send).not.toHaveBeenCalled();
    },
  );

  it.each(["source retired", "cancelled", "read failed"] as const)(
    "does not accept late evidence when %s during its read",
    async (change) => {
      const fixture = setup();
      const delivery = fixture.startDelivery();
      await fixture.dispatchEntered.promise;
      fixture.state.entry = { ...fixture.state.entry, ...finalReceipt };
      fixture.dispatchDone.resolve({ status: "accepted" });
      await Promise.race([
        fixture.readEntered.promise,
        delivery.then(() => {
          throw new Error("Delivery settled before reading its late recovery receipt");
        }),
      ]);
      if (change === "source retired") {
        fixture.state.allowed = false;
      }
      if (change === "cancelled") {
        fixture.controller.abort();
      }
      if (change === "read failed") {
        fixture.readDone.reject(new Error("worker unavailable"));
      } else {
        fixture.readDone.resolve();
      }
      const result = await delivery;
      expect(result).toMatchObject({ delivered: false });
      expect(result.reason).toBe(
        change === "source retired"
          ? "source_owner_changed"
          : change === "read failed"
            ? "requester_turn_pending"
            : undefined,
      );
      expect(fixture.dispatch).toHaveBeenCalledOnce();
      expect(fixture.send).not.toHaveBeenCalled();
    },
  );
});
