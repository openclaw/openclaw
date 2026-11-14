import assert from "node:assert/strict";
import { expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../../test/helpers/promise.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createLifecycleTypingManager } from "../../../gateway/lifecycle-typing.js";
import { registerGatewayLifecycleRuntime } from "../../../gateway/server-lifecycle-runtime-context.js";
import type { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
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
const queued = {
  delivered: false,
  reason: "requester_turn_pending",
  disposition: "session_queued",
} as const;

const sessionKey = "agent:main:requester-settle";
const sourceRunId = "announce-requester-settle";

function setup(sourceTool = "subagent_settle") {
  const controller = new AbortController();
  let ownedDelivery: ReturnType<typeof deliverSubagentAnnouncement> | undefined;
  const dispatchEntered = createDeferredCore();
  const dispatchDone = createDeferredCore<unknown>();
  const initialEntry: SessionEntry = {
    sessionId: "requester-session",
    lifecycleRevision: "requester-revision",
    updatedAt: 1,
  };
  const state = { entry: initialEntry, allowed: true, active: false };
  const storePath = "/synthetic/requester-completion/sessions.json";
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
  onTestFinished(async () => {
    // Revoke, release, and join before restoring shared dependencies.
    controller.abort();
    dispatchDone.resolve({ status: "error", stopReason: "rpc" });
    await Promise.allSettled(ownedDelivery ? [ownedDelivery] : []);
    testing.setDepsForTest();
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
  const typing = createLifecycleTypingManager({
    getConfig: () => ({}),
    isAvailable: () => true,
    resolveAdapter: async () => ({ sendTypingGuarded: sendTyping, clearTyping }),
  });
  const unused = async () => {
    throw new Error("unexpected lifecycle dispatch");
  };
  const unregister = registerGatewayLifecycleRuntime({
    dispatchSessionMethod: unused,
    dispatchAgent: unused,
    waitForAgent: unused,
    sendNotice: unused,
    startTyping: (params) => typing.start(params),
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

it.each([
  {
    name: "pending settle response",
    input: { status: "accepted", runId: "pending-requester" },
    expected: { ...queued, path: "direct" },
  },
  {
    name: "explicit stop",
    input: { status: "error", stopReason: "rpc" },
    expected: { delivered: false, disposition: undefined },
  },
  {
    name: "partial send failure",
    input: Object.assign(new Error("send incomplete"), { sentBeforeError: true }),
    expected: { delivered: false, disposition: "ambiguous" },
  },
])("reports the direct outcome for $name without replay", async ({ input, expected }) => {
  const fixture = setup();
  const onDeliveryError = vi.fn();
  fixture.params.onDeliveryError = onDeliveryError;
  const delivery = fixture.startDelivery();
  await fixture.dispatchEntered.promise;
  if (input instanceof Error) {
    fixture.dispatchDone.reject(input);
  } else {
    fixture.dispatchDone.resolve(input);
  }
  const result = await delivery;
  const { disposition, ...fields } = expected;
  expect(result).toMatchObject(fields);
  expect(result.disposition).toBe(disposition);
  if (input instanceof Error) {
    expect(onDeliveryError).toHaveBeenCalledWith(input);
    expect(result.error).toBe(input.message);
  } else {
    expect(onDeliveryError).not.toHaveBeenCalled();
  }
  expectNoReplay(fixture);
});
