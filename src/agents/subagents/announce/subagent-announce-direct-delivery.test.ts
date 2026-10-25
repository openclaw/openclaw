import assert from "node:assert/strict";
import { expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../../test/helpers/promise.js";
import { createSessionWorkStartChangedError } from "../../../config/sessions/lifecycle.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import * as sessionEntryWorker from "../../../config/sessions/session-entry-read-runtime.js";
import { SqliteTranscriptMutationConflictError } from "../../../config/sessions/session-mutation-conflict-error.js";
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
import { ReplaySafeTranscriptConflictError } from "../../embedded-agent-runner/transcript-conflict.js";
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
const queued = {
  delivered: false,
  reason: "requester_turn_pending",
  disposition: "session_queued",
} as const;

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

function setup(sourceTool = "subagent_settle") {
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
    // Revoke, release, and join before restoring shared dependencies.
    controller.abort();
    dispatchDone.resolve({ status: "error", stopReason: "rpc" });
    readDone.resolve();
    await Promise.allSettled(ownedDelivery ? [ownedDelivery] : []);
    try {
      read.mockRestore();
    } finally {
      testing.setDepsForTest();
    }
  });
  const send = vi.fn<typeof sendMessage>(async () => {
    throw new Error("Unexpected replay");
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
    sourceTool,
    requesterIsSubagent: false,
    expectsCompletionMessage: sourceTool === "subagent_announce",
    requireVisibleReply: true,
    directIdempotencyKey: sourceRunId,
    isSourceSessionEffectsAllowed: () => state.allowed,
    signal: controller.signal,
  };
  return {
    target,
    startDelivery: () => (ownedDelivery = deliverSubagentAnnouncement(params)),
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

it("preserves the direct completion phase without replacing controller custody", async () => {
  const fixture = setup("subagent_announce");
  const expected = { delivered: true, path: "direct" };
  const { queueMessage, input } = steering(fixture, async () => {
    throw new Error("Required direct delivery must not steer");
  });
  fixture.dispatchDone.resolve(response([{ text: "Completed directly" }], sentDeliveryStatus));
  const result = await deliverSubagentAnnouncement({
    ...fixture.params,
    controllerInput: input,
    requireDirectDelivery: true,
  });
  expect(result).toMatchObject(expected);
  expect(result.phases).toEqual([
    {
      phase: "direct-primary",
      ...expected,
      deliveredAt: undefined,
      enqueuedAt: undefined,
      error: undefined,
    },
  ]);
  expect(queueMessage).not.toHaveBeenCalled();
  expect(fixture.dispatch.mock.calls[0]?.[2]?.controllerInput).toBe(input);
});

it("keeps the same completion input queued when timeout recovery cannot accept steering", async ({
  signal,
}) => {
  const fixture = setup("subagent_announce");
  const recoveryEntered = createDeferredCore();
  const releaseRecovery = createDeferredCore();
  const recovery = withSessionTurn(
    { target: fixture.target, sessionKey, sessionId: fixture.state.entry.sessionId },
    async (operation) => {
      assert(operation, "Missing timeout recovery operation");
      operation.setPhase("preflight_compacting");
      recoveryEntered.resolve();
      await releaseRecovery.promise;
    },
  );
  const abandonment = vi
    .spyOn(embeddedRuns, "resolveEmbeddedRunAbandonment")
    .mockReturnValue("recovering_timeout");
  fixture.state.active = true;
  fixture.readDone.resolve();
  let input: ReturnType<typeof reserveSessionControllerSource> | undefined;
  let delivery: ReturnType<typeof fixture.startDelivery> | undefined;
  try {
    await withinTest(recoveryEntered.promise, signal);
    input = reserveSessionControllerSource(sessionKey, {
      target: fixture.target,
      policy: { mode: "followup" },
    });
    const parentClaim = input.mailbox.claim;
    fixture.params.controllerInput = input;
    delivery = fixture.startDelivery();
    await withinTest(
      awaitGateBeforeSettlement(
        fixture.dispatchEntered.promise,
        delivery,
        "Completion lost its controller input",
      ),
      signal,
    );
    expect(fixture.dispatch.mock.calls[0]?.[2]?.controllerInput).toBe(input);
    expect(input.mailbox.claim).toBe(parentClaim);
    expect(input.phase).not.toBe("consumed");
    releaseRecovery.resolve();
    await recovery;
    fixture.dispatchDone.resolve(response([{ text: "Recovered completion" }], sentDeliveryStatus));
    await expect(delivery).resolves.toMatchObject({ delivered: true, path: "direct" });
    expectNoReplay(fixture);
  } finally {
    releaseRecovery.resolve();
    fixture.dispatchDone.resolve(response());
    if (input) {
      retireSessionControllerInput(input);
    }
    await Promise.allSettled([recovery, delivery, input?.settlement.promise]);
    abandonment.mockRestore();
  }
});

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

it.each([
  { outcome: "accepted", change: "admission" },
  { outcome: "indeterminate", change: "admission" },
  { outcome: "accepted", change: "effects" },
  { outcome: "indeterminate", change: "effects" },
  { outcome: "accepted", change: "yield" },
  { outcome: "indeterminate", change: "yield" },
  { outcome: "accepted", change: "before admission" },
] as const)("steering $outcome after $change", async ({ outcome, change }) => {
  const fixture = setup("subagent_announce");
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
});

it.each(["subagent_settle", "subagent_announce"])("reuses %s receipt", async (sourceTool) => {
  const fixture = setup(sourceTool);
  fixture.state.entry = {
    ...fixture.state.entry,
    restartRecoveryDeliverySourceRunId: sourceRunId,
    restartRecoveryDeliveryRunId: "recovery-successor",
  };
  fixture.dispatchDone.resolve(response([{ text: "Unexpected duplicate" }], sentDeliveryStatus));
  await expect(fixture.startDelivery()).resolves.toMatchObject(queued);
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
});

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
    resumeChatInput: unused,
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

type DirectOutcome = {
  name: string;
  sourceTool?: string;
  input: unknown;
  patch?: Partial<SessionEntry>;
  expected: Partial<Awaited<ReturnType<typeof deliverSubagentAnnouncement>>>;
  preserve?: boolean;
};
type Expected = DirectOutcome["expected"];
const recovered = {
  delivered: true,
  requesterVisibleFinalDelivered: true,
  disposition: undefined,
} satisfies Expected;
const missing = { delivered: false, reason: "visible_reply_missing" } as const;
const retryable = { ...missing, disposition: "retryable" } satisfies Expected;
const permanent = { delivered: false, disposition: "permanent_failure" } satisfies Expected;
const ambiguous = { delivered: false, disposition: "ambiguous" } satisfies Expected;
const liveClaim = {
  restartRecoveryDeliverySourceRunId: sourceRunId,
  restartRecoveryDeliveryRunId: "successor",
} satisfies Partial<SessionEntry>;
const unsent = {
  restartRecoveryTerminalDeliveryEvidence: [
    { runId: sourceRunId, captured: true, payloads: [{ visible: true }] },
  ],
} satisfies Partial<SessionEntry>;
const safeConflict = () =>
  new ReplaySafeTranscriptConflictError(new SqliteTranscriptMutationConflictError("fixture"));
const terminalOnly = {
  restartRecoveryTerminalRunIds: [sourceRunId],
} satisfies Partial<SessionEntry>;
it.each`
  name                                                 | input                                                       | patch                                                                                    | expected                                                                                                      | sourceTool             | preserve
  ${"pending settle response"}                         | ${{ status: "accepted", runId: "pending-requester" }}       | ${{} satisfies Partial<SessionEntry>}                                                    | ${{ ...queued, path: "direct" } satisfies Expected}                                                           | ${undefined}           | ${false}
  ${"announcement during recovery"}                    | ${createSessionWorkStartChangedError(sessionKey)}           | ${undefined}                                                                             | ${recovered}                                                                                                  | ${"subagent_announce"} | ${false}
  ${"empty final"}                                     | ${response()}                                               | ${undefined}                                                                             | ${recovered}                                                                                                  | ${undefined}           | ${false}
  ${"restart interruption"}                            | ${{ status: "error", stopReason: "restart" }}               | ${undefined}                                                                             | ${recovered}                                                                                                  | ${undefined}           | ${false}
  ${"old keyed-input rejection"}                       | ${new Error("old keyed input rejected")}                    | ${undefined}                                                                             | ${recovered}                                                                                                  | ${undefined}           | ${false}
  ${"safe rejected transcript under current custody"}  | ${safeConflict()}                                           | ${terminalOnly}                                                                          | ${{ delivered: false, reason: "requester_transcript_conflict", disposition: "retryable" } satisfies Expected} | ${undefined}           | ${false}
  ${"unqualified transcript error without receipt"}    | ${new SqliteTranscriptMutationConflictError("fixture")}     | ${terminalOnly}                                                                          | ${{ ...missing, ...permanent } satisfies Expected}                                                            | ${undefined}           | ${false}
  ${"safe rejected transcript with committed receipt"} | ${safeConflict()}                                           | ${undefined}                                                                             | ${recovered}                                                                                                  | ${undefined}           | ${false}
  ${"live claim"}                                      | ${response()}                                               | ${liveClaim}                                                                             | ${queued}                                                                                                     | ${undefined}           | ${false}
  ${"terminal without receipt"}                        | ${response()}                                               | ${{ restartRecoveryTerminalRunIds: [sourceRunId] } satisfies Partial<SessionEntry>}      | ${{ ...missing, ...permanent } satisfies Expected}                                                            | ${undefined}           | ${false}
  ${"unrelated source"}                                | ${response()}                                               | ${{ restartRecoveryTerminalRunIds: ["another-source"] } satisfies Partial<SessionEntry>} | ${retryable}                                                                                                  | ${undefined}           | ${false}
  ${"replacement session"}                             | ${response()}                                               | ${{ ...finalReceipt, sessionId: "replacement" } satisfies Partial<SessionEntry>}         | ${retryable}                                                                                                  | ${undefined}           | ${false}
  ${"replacement lifecycle"}                           | ${response()}                                               | ${{ ...finalReceipt, lifecycleRevision: "replacement" } satisfies Partial<SessionEntry>} | ${retryable}                                                                                                  | ${undefined}           | ${false}
  ${"unsent external final"}                           | ${response()}                                               | ${unsent}                                                                                | ${retryable}                                                                                                  | ${undefined}           | ${false}
  ${"explicit stop"}                                   | ${{ status: "error", stopReason: "rpc" }}                   | ${undefined}                                                                             | ${{ delivered: false, disposition: undefined } satisfies Expected}                                            | ${undefined}           | ${true}
  ${"safe conflict cannot override send ambiguity"}    | ${Object.assign(safeConflict(), { sentBeforeError: true })} | ${undefined}                                                                             | ${ambiguous}                                                                                                  | ${undefined}           | ${true}
`("reconciles the direct outcome for $name without replay", async (outcome: DirectOutcome) => {
  const fixture = setup(outcome.sourceTool);
  const onDeliveryError = vi.fn();
  if (outcome.preserve) {
    fixture.params.onDeliveryError = onDeliveryError;
  }
  const delivery = fixture.startDelivery();
  await fixture.dispatchEntered.promise;
  fixture.state.entry = { ...fixture.state.entry, ...(outcome.patch ?? finalReceipt) };
  fixture.readDone.resolve();
  if (outcome.input instanceof Error) {
    fixture.dispatchDone.reject(outcome.input);
  } else {
    fixture.dispatchDone.resolve(outcome.input);
  }
  const result = await delivery;
  const { disposition, ...expected } = outcome.expected;
  expect(result).toMatchObject(expected);
  expect(result.disposition).toBe(disposition);
  if (outcome.preserve) {
    expect(fixture.read).not.toHaveBeenCalled();
    if (outcome.input instanceof Error) {
      expect(onDeliveryError).toHaveBeenCalledWith(outcome.input);
      expect(result.error).toBe(outcome.input.message);
    } else {
      expect(onDeliveryError).not.toHaveBeenCalled();
    }
  }
  expectNoReplay(fixture);
});

it.each(["private", "incognito"] as const)("no recovery reads for %s", async (scope) => {
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
});

it.each(["source retired", "cancelled", "read failed"] as const)(
  "does not accept late evidence when %s during its read",
  async (change) => {
    const fixture = setup();
    const delivery = fixture.startDelivery();
    await fixture.dispatchEntered.promise;
    fixture.state.entry = { ...fixture.state.entry, ...finalReceipt };
    fixture.dispatchDone.reject(new Error("gateway unavailable before admission"));
    await awaitGateBeforeSettlement(
      fixture.readEntered.promise,
      delivery,
      "Delivery settled before reading its late recovery receipt",
    );
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
