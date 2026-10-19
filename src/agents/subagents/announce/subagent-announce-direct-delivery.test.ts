import { describe, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../../test/helpers/promise.js";
import { createSessionWorkStartChangedError } from "../../../config/sessions/lifecycle.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import * as sessionEntryWorker from "../../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createRecoveryTypingManager } from "../../../gateway/recovery-typing.js";
import type { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { registerGatewayRecoveryRuntime } from "../../../gateway/server-recovery-runtime-context.js";
import type { sendMessage } from "../../../infra/outbound/message.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import type { ReplyBackendMessageInjectionV2 } from "../../../sessions/session-controller.contracts.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import {
  clearSessionControllerMailbox,
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../../../sessions/session-controller.operation.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import * as embeddedRuns from "../../embedded-agent-runner/runs.js";
import { deliverSubagentAnnouncement, testing } from "./subagent-announce-delivery.test-support.js";
import { sendSubagentAnnounceDirectly } from "./subagent-announce-direct-delivery.js";

const sentDeliveryStatus = { status: "sent", resultCount: 1 } as const;
const response = (payloads: unknown[] = [], deliveryStatus?: unknown) => ({
  status: "ok",
  result: { payloads, ...(deliveryStatus ? { deliveryStatus } : {}) },
});
const unconfirmedCommit = {
  transcriptCommit: "unconfirmed",
  errorMessage: "commit outcome unknown",
} as const;

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
    const state = { entry: initialEntry, allowed: true, active: false };
    const storePath = "/synthetic/requester-recovery/sessions.json";
    const cfg: OpenClawConfig = { session: { store: storePath } };
    const target = captureSessionTarget({
      storeScope: storePath,
      sessionKey,
      agentId: "main",
      incarnation: initialEntry.sessionId,
    });
    let executionStarted: (() => unknown) | undefined;
    const dispatch = vi.fn(async function <T>(
      ...args: Parameters<typeof dispatchGatewayMethodInProcess>
    ) {
      executionStarted = args[2]?.onExecutionStarted;
      args[2]?.onAccepted?.({ status: "accepted" });
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
    testing.setDepsForTest({
      getRuntimeConfig: () => cfg,
      loadRequesterSessionEntry: (key) => ({
        cfg,
        canonicalKey: key,
        agentId: "main",
        storePath,
        entry: state.entry,
      }),
      getRequesterSessionActivity: () => ({
        sessionId: initialEntry.sessionId,
        isActive: state.active,
        target,
      }),
      dispatchGatewayMethodInProcess: dispatch,
      sendMessage: send,
    });
    const params: Parameters<typeof deliverSubagentAnnouncement>[0] = {
      requesterSessionKey: sessionKey,
      requesterAgentId: "main",
      targetRequesterSessionKey: sessionKey,
      triggerMessage: "All children settled",
      directOrigin: { channel: "slack", to: "channel:C123", accountId: "acct-1" },
      sourceTool: "subagent_settle",
      requesterIsSubagent: false,
      expectsCompletionMessage: false,
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
      target,
      startDelivery,
      state,
      params,
      controller,
      dispatch,
      dispatchEntered,
      dispatchDone,
      startExecution: () => executionStarted?.(),
      read,
      readEntered,
      readDone,
      send,
    };
  }

  function steering(
    fixture: ReturnType<typeof setup>,
    inject: ReplyBackendMessageInjectionV2["queueMessage"],
  ) {
    const { target } = fixture;
    const operation = createReplyOperation({
      sessionKey,
      sessionId: fixture.state.entry.sessionId,
      resetTriggered: false,
      target,
    });
    operation.setPhase("running");
    const queueMessage = vi.fn(inject);
    operation.attachBackend({
      kind: "embedded",
      cancel() {},
      supportsTranscriptCommitWait: true,
      messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage },
    });
    const input = reserveSessionControllerSource(sessionKey, {
      target,
      policy: { mode: "steer" },
    });
    onTestFinished(() => {
      operation.complete();
      retireSessionControllerInput(input);
      clearSessionControllerMailbox(input.mailbox, () => {});
    });
    fixture.state.active = true;
    return { queueMessage, input };
  }

  function expectNoReplay(fixture: ReturnType<typeof setup>, dispatches = 1) {
    expect(fixture.dispatch).toHaveBeenCalledTimes(dispatches);
    expect(fixture.send).not.toHaveBeenCalled();
  }

  it.each([
    ["committed steering", false, false, { delivered: true, path: "steered" }],
    [
      "unconfirmed steering",
      false,
      true,
      { delivered: false, path: "steered", error: "commit outcome unknown" },
    ],
    ["required direct delivery", true, false, { delivered: true, path: "direct" }],
  ] as const)(
    "preserves the completion dispatch phase for %s without replacing controller custody",
    async (_name, requireDirectDelivery, unconfirmed, expected) => {
      const fixture = setup();
      const { queueMessage, input } = steering(fixture, async (_text, options, assertCurrent) => {
        assertCurrent();
        options?.onQueueAccepted?.(true);
        return unconfirmed ? unconfirmedCommit : undefined;
      });
      fixture.dispatchDone.resolve(response([{ text: "Completed directly" }], sentDeliveryStatus));
      const result = await deliverSubagentAnnouncement({
        ...fixture.params,
        sourceTool: "subagent_announce",
        expectsCompletionMessage: true,
        controllerInput: input,
        requireDirectDelivery,
      });
      expect(result).toMatchObject(expected);
      expect(result.phases).toEqual([
        {
          phase: "direct-primary",
          ...expected,
          deliveredAt: undefined,
          enqueuedAt: undefined,
          ...(!unconfirmed ? { error: undefined } : {}),
        },
      ]);
      expect(queueMessage).toHaveBeenCalledTimes(requireDirectDelivery ? 0 : 1);
      expect(fixture.dispatch).toHaveBeenCalledTimes(requireDirectDelivery ? 1 : 0);
      if (requireDirectDelivery) {
        expect(fixture.dispatch.mock.calls[0]?.[2]?.controllerInput).toBe(input);
      }
    },
  );

  it.for(["current", "revoked"] as const)(
    "settles a rejected recovery handoff before releasing the parent turn (%s source)",
    async (source, { signal }) => {
      const fixture = setup();
      const { target } = fixture;
      const recoveryEntered = createDeferredCore();
      const releaseRecovery = createDeferredCore();
      const retirementEntered = createDeferredCore();
      const releaseRetirement = createDeferredCore();
      const recovery = withSessionTurn(
        { target, sessionKey, sessionId: fixture.state.entry.sessionId },
        async (operation) => {
          if (!operation) {
            throw new Error("Timeout recovery requires its retained controller operation");
          }
          operation.setPhase("preflight_compacting");
          recoveryEntered.resolve();
          await releaseRecovery.promise;
        },
      );
      const abandonment = vi
        .spyOn(embeddedRuns, "resolveEmbeddedRunAbandonment")
        .mockReturnValue("recovering_timeout");
      fixture.state.active = true;
      fixture.dispatch.mockRejectedValue(
        new Error("Completion must not dispatch behind held timeout recovery"),
      );
      fixture.readDone.resolve();
      let input: ReturnType<typeof reserveSessionControllerSource> | undefined;
      let delivery: ReturnType<typeof fixture.startDelivery> | undefined;
      let handoffSettled = false;
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            recoveryEntered.promise,
            recovery,
            "Recovery exited before retaining its controller turn",
          ),
          signal,
        );
        input = reserveSessionControllerSource(sessionKey, {
          target,
          policy: { mode: "followup" },
          adapter: {
            onSettled: async () => {
              retirementEntered.resolve();
              await releaseRetirement.promise;
            },
          },
        });
        const parentClaim = input.mailbox.claim;
        expect(parentClaim).toBeDefined();
        expect(parentClaim?.operation).toMatchObject({
          phase: "preflight_compacting",
          result: null,
        });
        fixture.params.sourceTool = "subagent_announce";
        fixture.params.expectsCompletionMessage = true;
        fixture.params.controllerInput = input;
        delivery = fixture.startDelivery().finally(() => {
          handoffSettled = true;
        });
        await withinTest(
          awaitGateBeforeSettlement(
            retirementEntered.promise,
            delivery,
            "Completion returned before retiring its rejected controller input",
          ),
          signal,
        );
        expect(handoffSettled).toBe(false);
        expect(input.mailbox.entries).toContain(input);
        expect(input.mailbox.claim).toBe(parentClaim);
        expect(parentClaim?.operation?.result).toBeNull();
        if (source === "revoked") {
          fixture.state.allowed = false;
        }
        releaseRetirement.resolve();
        const result = await withinTest(
          awaitGateBeforeSettlement(
            delivery,
            recovery,
            "Recovery released before the completion handoff settled",
          ),
          signal,
        );
        await input.settlement.promise;
        expect(result).toMatchObject(
          source === "current"
            ? { delivered: false, reason: "completion_handoff_pending", disposition: "retryable" }
            : {
                delivered: false,
                reason: "source_owner_changed",
                terminal: true,
                disposition: "intentional_non_delivery",
              },
        );
        expect(input.phase).toBe("consumed");
        expect(input.mailbox.entries).not.toContain(input);
        expect(input.mailbox.claim).toBe(parentClaim);
        expect(parentClaim).toMatchObject({
          released: false,
          operation: { phase: "preflight_compacting", result: null },
        });
        expectNoReplay(fixture, 0);
        releaseRecovery.resolve();
        await recovery;
        expectNoReplay(fixture, 0);
      } finally {
        releaseRetirement.resolve();
        releaseRecovery.resolve();
        if (input) {
          retireSessionControllerInput(input);
        }
        await Promise.allSettled([
          recovery,
          ...(delivery ? [delivery] : []),
          ...(input ? [input.settlement.promise] : []),
        ]);
        abandonment.mockRestore();
      }
    },
  );

  it("reports no attempted completion phase when cancelled before dispatch", async () => {
    const fixture = setup();
    fixture.controller.abort();
    await expect(fixture.startDelivery()).resolves.toEqual({
      delivered: false,
      path: "none",
      phases: [],
    });
    expectNoReplay(fixture, 0);
  });

  it("preserves the pending requester reason for a settle response", async () => {
    const fixture = setup();
    fixture.dispatchDone.resolve({ status: "accepted", runId: "pending-requester" });
    await expect(fixture.startDelivery()).resolves.toMatchObject({
      delivered: false,
      path: "direct",
      reason: "requester_turn_pending",
      disposition: "session_queued",
    });
    expectNoReplay(fixture);
  });

  it.each([
    { outcome: "accepted", change: "admission" },
    { outcome: "indeterminate", change: "admission" },
    { outcome: "accepted", change: "effects" },
    { outcome: "indeterminate", change: "effects" },
    { outcome: "accepted", change: "yield" },
    { outcome: "indeterminate", change: "yield" },
    { outcome: "accepted", change: "before admission" },
  ] as const)(
    "preserves $outcome steering evidence when $change closes",
    async ({ outcome, change }) => {
      const fixture = setup();
      let admission = change !== "before admission";
      let yielded = false;
      const { queueMessage, input } = steering(fixture, async (_text, options, assertCurrent) => {
        assertCurrent();
        options?.onQueueAccepted?.(true);
        admission = false;
        fixture.state.allowed = change !== "effects";
        yielded = change === "yield";
        return outcome === "indeterminate" ? unconfirmedCommit : undefined;
      });
      const result = await sendSubagentAnnounceDirectly({
        ...fixture.params,
        sourceTool: "subagent_announce",
        expectsCompletionMessage: true,
        controllerInput: input,
        isSourceSessionAdmissionAllowed: () => admission,
        isCompletionOwnedByRequesterYield: () => yielded,
      });
      if (change === "before admission") {
        expect(result).toMatchObject({ delivered: false, reason: "completion_handoff_pending" });
        expect(queueMessage).not.toHaveBeenCalled();
      } else {
        expect(queueMessage).toHaveBeenCalledOnce();
        expect(result).toMatchObject(
          change === "admission"
            ? outcome === "accepted"
              ? { delivered: true, path: "steered" }
              : {
                  delivered: false,
                  path: "steered",
                  disposition: "ambiguous",
                  error: "commit outcome unknown",
                }
            : { delivered: false, reason: "source_owner_changed" },
        );
      }
      expectNoReplay(fixture, 0);
    },
  );

  it.each(["subagent_settle", "subagent_announce"])(
    "joins an interrupted %s continuation and consumes its final receipt without replay",
    async (sourceTool) => {
      const fixture = setup();
      fixture.params.sourceTool = sourceTool;
      fixture.params.expectsCompletionMessage = sourceTool === "subagent_announce";
      fixture.state.entry = {
        ...fixture.state.entry,
        restartRecoveryDeliverySourceRunId: sourceRunId,
        restartRecoveryDeliveryRunId: "recovery-successor",
      };
      fixture.dispatchDone.resolve(
        response([{ text: "Unexpected duplicate" }], sentDeliveryStatus),
      );
      await expect(fixture.startDelivery()).resolves.toMatchObject({
        delivered: false,
        reason: "requester_turn_pending",
        disposition: "session_queued",
      });
      expect(fixture.dispatch).not.toHaveBeenCalled();
      fixture.state.active = true;
      fixture.state.entry = {
        ...fixture.state.entry,
        ...finalReceipt,
        restartRecoveryDeliveryRunId: undefined,
        restartRecoveryDeliverySourceRunId: undefined,
      };
      await expect(deliverSubagentAnnouncement(fixture.params)).resolves.toMatchObject({
        delivered: true,
        requesterVisibleFinalDelivered: true,
      });
      expectNoReplay(fixture, 0);
    },
  );

  it.each([
    "completed",
    "cancelled",
    "authority revoked",
    "private",
    "child",
    "session-only",
  ] as const)("scopes resumed parent activity to its live visible run (%s)", async (ending) => {
    await import("../../agent-scope-config.js");
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const sendTyping = vi.fn(async () => {});
    const clearTyping = vi.fn(async () => {});
    const typing = createRecoveryTypingManager({
      getConfig: () => ({}),
      isAvailable: () => true,
      resolveAdapter: async () => ({ sendTypingGuarded: sendTyping, clearTyping }),
    });
    const unused = async () => {
      throw new Error("unexpected recovery dispatch");
    };
    const unregister = registerGatewayRecoveryRuntime({
      prepareRestartRecovery: unused,
      dispatchSessionMethod: unused,
      dispatchAgent: unused,
      waitForAgent: unused,
      sendRecoveryNotice: unused,
      startRecoveryTyping: (params) => typing.start(params),
    });
    const fixture = setup();
    fixture.params.directOrigin = {
      channel: "telegram",
      to: "123",
      accountId: "work",
      threadId: "42",
    };
    const visible = ending !== "private" && ending !== "child" && ending !== "session-only";
    if (ending === "private") {
      fixture.params.completionTarget = "parent";
      fixture.params.completionRequesterSessionId = "requester-session";
      fixture.params.completionRequesterLifecycleRevision = "requester-revision";
    }
    if (ending === "child") {
      fixture.params.requesterIsSubagent = true;
    }
    if (ending === "session-only") {
      fixture.params.directOrigin = undefined;
    }
    onTestFinished(() => {
      typing.close();
      unregister();
      vi.useRealTimers();
    });
    const delivery = fixture.startDelivery();
    await fixture.dispatchEntered.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(sendTyping).not.toHaveBeenCalled();
    fixture.startExecution();
    await vi.advanceTimersByTimeAsync(0);
    if (!visible) {
      expect(sendTyping).not.toHaveBeenCalled();
      fixture.readDone.resolve();
      fixture.dispatchDone.resolve(response());
      await delivery;
      expect(clearTyping).not.toHaveBeenCalled();
      return;
    }
    expect(sendTyping).toHaveBeenCalledWith(
      expect.objectContaining({ to: "123", accountId: "work", threadId: "42" }),
    );
    await vi.advanceTimersByTimeAsync(65_000);
    expect(sendTyping.mock.calls.length).toBeGreaterThan(10);
    if (ending === "cancelled") {
      fixture.controller.abort();
    }
    if (ending === "authority revoked") {
      fixture.state.allowed = false;
    }
    if (ending !== "completed") {
      await vi.advanceTimersByTimeAsync(3_000);
      expect(clearTyping).toHaveBeenCalledOnce();
    }
    fixture.dispatchDone.resolve(response([{ text: "Done" }], sentDeliveryStatus));
    await delivery;
    await vi.advanceTimersByTimeAsync(0);
    const count = sendTyping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendTyping).toHaveBeenCalledTimes(count);
    expect(clearTyping).toHaveBeenCalledOnce();
  });

  type LateOutcome = {
    name: string;
    sourceTool?: string;
    response?: unknown;
    error?: Error;
    patch: Partial<SessionEntry>;
    expected: { delivered: boolean; requesterVisibleFinalDelivered?: boolean; reason?: string };
    disposition?: string;
  };
  function recovered(
    name: string,
    outcome: Pick<LateOutcome, "response" | "error" | "sourceTool">,
  ): LateOutcome {
    return {
      name,
      ...outcome,
      patch: finalReceipt,
      expected: { delivered: true, requesterVisibleFinalDelivered: true },
    };
  }
  function missingReceipt(
    name: string,
    patch: Partial<SessionEntry>,
    disposition = "retryable",
    reason = "visible_reply_missing",
  ): LateOutcome {
    return {
      name,
      patch,
      disposition,
      response: response(),
      expected: { delivered: false, reason },
    };
  }
  it.each<LateOutcome>([
    recovered("announcement completed while waiting for recovery", {
      sourceTool: "subagent_announce",
      error: createSessionWorkStartChangedError(sessionKey),
    }),
    recovered("empty final", { response: response() }),
    recovered("restart interruption", { response: { status: "error", stopReason: "restart" } }),
    recovered("old keyed-input rejection", { error: new Error("old keyed input rejected") }),
    missingReceipt(
      "live claim",
      {
        restartRecoveryDeliverySourceRunId: sourceRunId,
        restartRecoveryDeliveryRunId: "successor",
      },
      "session_queued",
      "requester_turn_pending",
    ),
    missingReceipt(
      "terminal without receipt",
      { restartRecoveryTerminalRunIds: [sourceRunId] },
      "permanent_failure",
    ),
    missingReceipt("unrelated source", { restartRecoveryTerminalRunIds: ["another-source"] }),
    missingReceipt("replacement session", { ...finalReceipt, sessionId: "replacement" }),
    missingReceipt("replacement lifecycle", { ...finalReceipt, lifecycleRevision: "replacement" }),
    missingReceipt("unsent external final", {
      restartRecoveryTerminalDeliveryEvidence: [
        { runId: sourceRunId, captured: true, payloads: [{ visible: true }] },
      ],
    }),
  ])("reconciles the exact late receipt for $name without replay", async (outcome) => {
    const fixture = setup();
    if (outcome.sourceTool) {
      fixture.params.sourceTool = outcome.sourceTool;
      fixture.params.expectsCompletionMessage = true;
    }
    const delivery = fixture.startDelivery();
    await fixture.dispatchEntered.promise;
    fixture.state.entry = { ...fixture.state.entry, ...outcome.patch };
    fixture.readDone.resolve();
    if (outcome.error) {
      fixture.dispatchDone.reject(outcome.error);
    } else {
      fixture.dispatchDone.resolve(outcome.response);
    }
    const result = await delivery;
    expect(result).toMatchObject(outcome.expected);
    expect(result.disposition).toBe(outcome.disposition);
    expectNoReplay(fixture);
  });

  it.each<[string, unknown, boolean, string?]>([
    ["committed final", response([{ text: "Sent final" }], sentDeliveryStatus), true],
    [
      "partial send",
      { status: "ok", result: { deliveryStatus: { status: "partial_failed", resultCount: 1 } } },
      false,
      "ambiguous",
    ],
    [
      "intentional suppression",
      {
        status: "ok",
        result: {
          deliveryStatus: {
            status: "suppressed",
            reason: "cancelled_by_message_sending_hook",
            resultCount: 0,
          },
        },
      },
      false,
      "intentional_non_delivery",
    ],
    ["explicit stop", { status: "error", stopReason: "rpc" }, false],
    [
      "permanent failure",
      Object.assign(new Error("unsupported channel: fixture"), { code: "UNSUPPORTED" }),
      false,
      "permanent_failure",
    ],
    [
      "flattened transcript turn assertion",
      new Error("Error: Session transcript keyed user is outside the current turn: old-input"),
      false,
      "permanent_failure",
    ],
    [
      "send ambiguity",
      Object.assign(new Error("send outcome unknown"), { sentBeforeError: true }),
      false,
      "ambiguous",
    ],
  ])("preserves the original %s", async (_name, outcome, delivered, disposition) => {
    const fixture = setup();
    const onDeliveryError = vi.fn();
    fixture.params.onDeliveryError = onDeliveryError;
    const delivery = fixture.startDelivery();
    await fixture.dispatchEntered.promise;
    fixture.state.entry = { ...fixture.state.entry, ...finalReceipt };
    fixture.readDone.resolve();
    if (outcome instanceof Error) {
      fixture.dispatchDone.reject(outcome);
    } else {
      fixture.dispatchDone.resolve(outcome);
    }
    const result = await delivery;
    expect(result).toMatchObject({
      delivered,
      disposition,
    });
    if (outcome instanceof Error) {
      expect(onDeliveryError).toHaveBeenCalledWith(outcome);
      expect(result.error).toBe(outcome.message);
    } else {
      expect(onDeliveryError).not.toHaveBeenCalled();
    }
    expect(fixture.read).not.toHaveBeenCalled();
    expectNoReplay(fixture);
  });

  it.each(["private", "incognito"] as const)(
    "does not add recovery reads to %s delivery",
    async (scope) => {
      const fixture = setup();
      if (scope === "private") {
        fixture.params.completionTarget = "parent";
        fixture.params.completionRequesterSessionId = "requester-session";
        fixture.params.completionRequesterLifecycleRevision = "requester-revision";
      } else {
        fixture.params.requesterSessionKey = "agent:main:dashboard:incognito-recovery";
        fixture.params.targetRequesterSessionKey = fixture.params.requesterSessionKey;
        const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
        onTestFinished(() =>
          memorySessionActorOwners.closeDatabase({ agentId: "main", path: storePath }),
        );
        await replaceSessionEntry(
          { agentId: "main", sessionKey: fixture.params.requesterSessionKey, storePath },
          { ...fixture.state.entry, incognito: true },
        );
      }
      const delivery = fixture.startDelivery();
      await awaitGateBeforeSettlement(
        fixture.dispatchEntered.promise,
        delivery,
        "Announcement did not reach direct delivery",
      );
      fixture.state.entry = { ...fixture.state.entry, ...finalReceipt };
      fixture.dispatchDone.resolve(response());
      await expect(delivery).resolves.toMatchObject({ delivered: false });
      expect(fixture.read).not.toHaveBeenCalled();
      expectNoReplay(fixture);
    },
  );

  it.each(["source retired", "cancelled", "read failed"] as const)(
    "does not accept late evidence when %s during its read",
    async (change) => {
      const fixture = setup();
      const delivery = fixture.startDelivery();
      await fixture.dispatchEntered.promise;
      fixture.state.entry = { ...fixture.state.entry, ...finalReceipt };
      fixture.dispatchDone.reject(new Error("gateway unavailable before admission"));
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
      expect(result.reason).toBe(change === "source retired" ? "source_owner_changed" : undefined);
      expectNoReplay(fixture);
    },
  );
});
