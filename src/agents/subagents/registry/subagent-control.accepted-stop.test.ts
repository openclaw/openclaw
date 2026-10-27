// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { runSubagentStateWorkerOperation, useSubagentControlFixture } from "./subagent-control.test-support.js";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { createAgentAdmissionController } from "../../../gateway/agent-turn/agent-admission-controller.js";
import { createAgentDedupeLifecycle } from "../../../gateway/agent-turn/agent-dedupe-lifecycle.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { createDirectChatContext } from "../../../gateway/server-chat.agent-events.test-helpers.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../../../plugins/registry-inspection-resources.js";
import { retireInspectionInstances } from "../../../plugins/registry-inspection.test-support.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
  getGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import { withSessionControllerSource } from "../../../sessions/session-controller.context.js";
import {
  beginSessionEffect,
  captureSessionTarget,
  getSessionMutationCount,
} from "../../../sessions/session-controller.lifecycle.js";
import {
  retireSessionControllerInput,
  trackSessionControllerSourceWork,
} from "../../../sessions/session-controller.mailbox.js";
import {
  getRpcSource,
  type RpcSourceRef,
} from "../../../sessions/session-controller.rpc-sources.js";
import { markReplyOperationExecutionStarted } from "../../../sessions/session-controller.state.js";
import { rpcSourceTesting } from "../../../sessions/session-lifecycle-admission.test-support.js";
import { createEnteredGate } from "../../entered-gate.test-support.js";
import { observeSettlement } from "../../promise-settlement.test-support.js";
import { isSubagentRegistryWriteCommand } from "../../subagent-test-fixtures.test-helpers.js";
import * as subagentKillSettlement from "./subagent-control-kill-settlement.js";
import { killSessionSubagentRuns } from "./subagent-control-kill.js";
import {
  createControlRunFixture,
  expectControlIdle as expectIdle,
  controlController,
} from "./subagent-control.fixtures.test-support.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import {
  captureSubagentExecution,
  retireSubagentGatewayBinding,
} from "./subagent-registry-execution-cleanup.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { markSubagentRunTerminated } from "./subagent-registry.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

const fixture = useSubagentControlFixture();
const { writeSession, register } = createControlRunFixture(() => fixture.stateDir);
const executionJoinObservers = new Map<RpcSourceRef, () => void>();

function interceptRegistryWrite(
  runId: string,
  before: (next: SubagentRunRecord | undefined) => (() => void | Promise<void>) | undefined,
) {
  fixture.worker.mockImplementation((stateContext, operation, options) =>
    runSubagentStateWorkerOperation(
      stateContext,
      (scope) =>
        operation({
          execute: async (command, commandOptions) => {
            const row = isSubagentRegistryWriteCommand(command)
              ? command.input.values.find((candidate) => candidate.run_id === runId)
              : undefined;
            const after = before(row ? (rowToSubagentRunRecord(row) ?? undefined) : undefined);
            const receipt = await scope.execute(command, commandOptions);
            const pending = after?.();
            if (pending) {
              await pending;
            }
            return receipt;
          },
        }),
      options,
    ),
  );
}
beforeEach(() => {
  executionJoinObservers.clear();
  const settleSources = subagentKillSettlement.settleSubagentKillSources;
  vi.spyOn(subagentKillSettlement, "settleSubagentKillSources").mockImplementation((params) => {
    if (params.execution) {
      executionJoinObservers.get(params.execution)?.();
    }
    return settleSources(params);
  });
});

async function seedExecutionTarget(
  name: string,
  lifecycleRevision?: string,
  sessionKey = `agent:main:subagent:${name}`,
) {
  const sessionId = `${name}-session`;
  const runId = `${name}-run`;
  const storePath = await writeSession(name, lifecycleRevision, { sessionKey });
  const sessionEntry = await readSessionEntryReadOnlyInWorker({
    agentId: "main",
    storePath,
    sessionKey,
  });
  await register(name, storePath, { runId, childSessionKey: sessionKey, sessionEntry });
  const context = createDirectChatContext({ getRuntimeConfig });
  const resolveGatewayContext = () => context;
  bindGatewayContextResolver(subagentRuns.get(runId)!, resolveGatewayContext);
  return { sessionKey, sessionId, sessionEntry, runId, storePath, context, resolveGatewayContext };
}

type ExecutionTarget = Pick<
  Awaited<ReturnType<typeof seedExecutionTarget>>,
  "sessionKey" | "sessionId" | "runId" | "storePath"
> & { resolveGatewayContext: GatewayContextResolver | undefined };
function registerAbort(
  { runId, sessionKey, sessionId, storePath, resolveGatewayContext }: ExecutionTarget,
  lifecycleGeneration?: string,
) {
  return withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
    registerChatAbortController({
      target: captureSessionTarget({
        storeScope: storePath,
        sessionKey,
        agentId: "main",
        incarnation: sessionId,
      }),
      runId,
      sessionKey,
      sessionId,
      lifecycleGeneration,
      kind: "agent",
      timeoutMs: 60_000,
    }),
  );
}

async function holdExecution(target: ExecutionTarget, cleanupDuringExecution = true) {
  const registration = registerAbort(target);
  const owner = registration.entry!;
  const releaseTail = createDeferred();
  const { completion: execution } = await startSourceExecution(
    owner,
    async () => {
      await releaseTail.promise;
      if (cleanupDuringExecution) {
        registration.cleanup();
      }
    },
    registration.cleanup,
  );
  return { registration, owner, releaseTail, execution };
}

it.each([
  { original: undefined, current: undefined, matches: true, retired: false },
  { original: "original-revision", current: "original-revision", matches: true, retired: false },
  { original: undefined, current: "successor-revision", matches: false, retired: false },
  { original: "original-revision", current: undefined, matches: false, retired: false },
  { original: "original-revision", current: "original-revision", matches: false, retired: true },
])(
  "retains cleanup custody only for the recorded revision ($original -> $current, already retired=$retired)",
  async ({ original, current, matches, retired }) => {
    const target = await seedExecutionTarget("cleanup-revision", original);
    const { sessionKey, sessionId, sessionEntry, runId, storePath } = target;
    const entry = subagentRuns.get(runId)!;
    expect(entry.childSessionIdentity).toEqual({ sessionId, lifecycleRevision: original });
    if (retired) {
      // An explicitly unbound retired row must not adopt a later same-ID source.
      clearGatewayContextResolver(entry);
      retireSubagentGatewayBinding(entry);
    }
    const { registration, releaseTail, execution } = await holdExecution(
      { ...target, resolveGatewayContext: retired ? undefined : target.resolveGatewayContext },
      false,
    );
    try {
      retireSubagentGatewayBinding(entry);
      await replaceSessionEntry(
        { agentId: "main", storePath, sessionKey },
        { ...sessionEntry!, lifecycleRevision: current },
      );
      const cleanup = captureSubagentExecution({
        entry,
        session: {
          agentId: "main",
          storePath,
          entry: await readSessionEntryReadOnlyInWorker({ agentId: "main", storePath, sessionKey }),
        },
      });
      expect(cleanup !== undefined).toBe(matches);
      if (matches) {
        expect(cleanup?.execution).toBe(registration.entry);
        expect(cleanup?.execution.input.settlement.promise).toBe(
          registration.entry?.input.settlement.promise,
        );
      }
    } finally {
      releaseTail.resolve();
      await execution;
      registration.cleanup();
    }
  },
);

async function startSourceExecution(
  entry: RpcSourceRef,
  run: () => Promise<void>,
  cleanup: () => void,
  runAfterTurn = false,
) {
  const started = createDeferred();
  const target = entry.input.target!;
  const execute = async () => {
    started.resolve();
    try {
      await run();
    } finally {
      cleanup();
    }
  };
  const completion = withSessionControllerSource(entry.input, async () => {
    await withSessionTurn(
      {
        sessionKey: target.sessionKey,
        sessionId: target.incarnation,
        agentId: target.agentId,
        target,
        controllerInput: entry.input,
      },
      async (operation) => {
        markReplyOperationExecutionStarted(expectDefined(operation, "claimed source operation"));
        if (!runAfterTurn) {
          await execute();
        }
      },
    );
    if (runAfterTurn) {
      await execute();
    }
  });
  void completion.catch(() => {});
  trackSessionControllerSourceWork(entry.input, completion);
  await awaitGateBeforeSettlement(
    started.promise,
    completion,
    "Source did not enter its real controller turn",
  );
  return { completion };
}

it("lifecycle cleanup joins terminal controller disposal before completing", async () => {
  const target = await seedExecutionTarget("terminal-disposal", "original-revision");
  const { owner, releaseTail, execution, registration } = await holdExecution(target);
  let pending: ReturnType<typeof killSessionSubagentRuns> | undefined;
  const joined = createDeferred();
  const settlement = observeExecutionJoin(owner, joined.resolve);
  try {
    emitAgentEvent({
      runId: target.runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        endedAt: Date.now(),
        terminalReply: { disposition: "visible", text: "completed" },
      },
    });
    await fixture.settle();
    const entry = expectDefined(subagentRuns.get(target.runId), "terminal child");
    expect(entry.execution.status).toBe("terminal");
    expect(entry.requesterSettleWake).toBeUndefined();
    expect(getGatewayContextResolver(entry)).toBeUndefined();
    pending = killSessionSubagentRuns({
      cfg: getRuntimeConfig(),
      sessionKey: entry.requesterSessionKey,
      agentId: "main",
    });
    await awaitGateBeforeSettlement(
      joined.promise,
      pending,
      "Reset did not join controller disposal",
    );
    expect(settlement.status).toBe("pending");
    releaseTail.resolve();
    await expect(pending).resolves.toMatchObject({ status: "ok", killed: 0 });
    await execution;
    expect(settlement.status).toBe("fulfilled");
  } finally {
    releaseTail.resolve();
    await Promise.allSettled([pending, execution]);
    registration.cleanup();
  }
});

function observeExecutionJoin(entry: RpcSourceRef, selected: () => void) {
  let state: "pending" | "fulfilled" | "rejected" = "pending";
  void entry.input.settlement.promise.then(
    () => {
      state = "fulfilled";
    },
    () => {
      state = "rejected";
    },
  );
  // Observe the cleanup owner joining this source, not earlier reads while capturing it.
  executionJoinObservers.set(entry, selected);
  return {
    get status() {
      return state;
    },
  };
}

it.each([
  "abort",
  "interruption",
  "replacement",
  "already terminal",
  "declined",
  "throws",
] as const)(
  "joins accepted Stop cleanup before settling native or callback cancellation (%s)",
  async (mode) => {
    const callback = mode === "declined" || mode === "throws";
    const name = callback ? "callback-stop" : "accepted-stop";
    const target = await seedExecutionTarget(name, `${name}-revision`);
    const { sessionKey, sessionId, runId, storePath } = target;
    const { registration, owner, releaseTail, execution } = await holdExecution(target);
    const selectedTail = createDeferred();
    let observingStop = false;
    const settlement = observeExecutionJoin(owner, () => {
      if (observingStop) {
        selectedTail.resolve();
      }
    });
    const admission =
      mode === "interruption"
        ? await beginSessionEffect({
            scope: storePath,
            identities: [sessionKey, sessionId],
            resolveGatewayContext: target.resolveGatewayContext,
            assertAllowed: () => {},
            onInterrupt: () => {
              registration.controller.abort();
              admission?.release();
              return { runId };
            },
          })
        : undefined;
    let termination: ReturnType<typeof markSubagentRunTerminated> | undefined;
    let pending: ReturnType<typeof killSubagentRunAdmin> | undefined;
    let callerAuthorized = true;
    const onResult = callback ? undefined : vi.fn(() => undefined);
    try {
      if (mode === "already terminal") {
        termination = markSubagentRunTerminated({ runId, reason: "killed" });
        expect(await termination).toBe(1);
      }
      observingStop = true;
      pending = killSubagentRunAdmin(
        { cfg: getRuntimeConfig(), sessionKey, expectedRunId: runId, onResult },
        {
          assertCurrent: () => {
            if (!callerAuthorized) {
              throw new Error("Caller control revoked during raw execution settlement.");
            }
          },
          beforeSessionKill: callback
            ? () => {
                registration.controller.abort();
                if (mode === "declined") {
                  return false;
                }
                throw new Error("callback failed after Stop");
              }
            : undefined,
        },
      );
      await awaitGateBeforeSettlement(
        selectedTail.promise,
        pending,
        "Stop returned before joining its exact raw execution",
      );
      expect(settlement.status).toBe("pending");
      expect(getSessionMutationCount()).toBe(0);
      expect(owner.input.abortSignal.aborted).toBe(mode !== "already terminal");
      if (callback) {
        releaseTail.resolve();
        const result = await pending;
        expect(result).toMatchObject({ found: true, killed: false });
        if (mode === "throws") {
          expect(result).toHaveProperty("error", expect.any(String));
        }
        return;
      }
      callerAuthorized = false;
      if (mode === "replacement") {
        rpcSourceTesting.deleteExpected(runId, owner);
        registerAbort(target);
      }
      releaseTail.resolve();
      await expect(pending).rejects.toThrow("Caller control revoked");
      expect(settlement.status).toBe("fulfilled");
      expect(subagentRuns.get(runId)?.execution.status).toBe("terminal");
      expect(subagentRuns.get(runId)?.endedReason).toBe(SUBAGENT_ENDED_REASON_KILLED);
      expect(onResult).not.toHaveBeenCalled();
      if (mode === "replacement") {
        expect(getRpcSource(runId)?.input.abortSignal.aborted).toBe(false);
      } else if (mode === "already terminal") {
        expect(owner.input.abortSignal.aborted).toBe(false);
      }
    } finally {
      releaseTail.resolve();
      admission?.release();
      await Promise.allSettled([termination, pending, execution]);
      registration.cleanup();
      if (mode === "replacement") {
        const replacement = getRpcSource(runId);
        if (replacement) {
          retireSessionControllerInput(replacement.input);
        }
      }
      expectIdle();
    }
  },
);

it.for(["canonical", "raw"] as const)(
  "joins only the cancelled %s source when its abort revokes caller authority",
  async (kind, { signal }) => {
    const executionTarget = await seedExecutionTarget(
      "partial-revocation",
      "partial-revocation-revision",
      kind === "raw" ? "global" : undefined,
    );
    const { sessionKey, sessionId, runId, storePath } = executionTarget;
    const target = captureSessionTarget({
      storeScope: storePath,
      sessionKey,
      agentId: "main",
      incarnation: sessionId,
    });
    const cancelled = registerAbort(executionTarget);
    const untouched = registerAbort({ ...executionTarget, runId: `${runId}-untouched` });
    const entered = createDeferred();
    const aborted = createDeferred();
    const joinedCancelled = createDeferred();
    const releaseCancelled = createDeferred();
    const releaseUntouched = createDeferred();
    let callerAuthorized = true;
    cancelled.controller.signal.addEventListener(
      "abort",
      () => {
        callerAuthorized = false;
        aborted.resolve();
      },
      { once: true },
    );
    const cancelledWork = withSessionTurn(
      { sessionKey, agentId: "main", target, controllerInput: cancelled.entry!.input },
      async (operation) => {
        expect(operation).toBeUndefined();
        entered.resolve();
        try {
          await releaseCancelled.promise;
        } finally {
          cancelled.cleanup();
        }
      },
    );
    trackSessionControllerSourceWork(cancelled.entry!.input, cancelledWork);
    const untouchedWork = releaseUntouched.promise.then(() => untouched.cleanup());
    trackSessionControllerSourceWork(untouched.entry!.input, untouchedWork);
    const cancelledSettlement = observeExecutionJoin(cancelled.entry!, () => {
      if (!callerAuthorized) {
        joinedCancelled.resolve();
      }
    });
    const untouchedSettlement = observeExecutionJoin(untouched.entry!, () => {});
    let pending: ReturnType<typeof killSubagentRunAdmin> | undefined;
    const onResult = vi.fn(() => undefined);
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, cancelledWork, "Preparation did not start"),
        signal,
      );
      expect(cancelled.entry!.input.claim?.operation).toBeUndefined();
      expect(cancelled.entry!.input.claim).toBeDefined();
      expect(untouched.entry!.input.claim).toBeUndefined();
      pending = killSubagentRunAdmin(
        { cfg: getRuntimeConfig(), sessionKey, agentId: "main", expectedRunId: runId, onResult },
        {
          assertCurrent: () => {
            if (!callerAuthorized) {
              throw new Error("Caller control revoked by accepted source cancellation.");
            }
          },
        },
      );
      await withinTest(
        awaitGateBeforeSettlement(aborted.promise, pending, "Stop returned before cancellation"),
        signal,
      );
      await withinTest(
        awaitGateBeforeSettlement(
          joinedCancelled.promise,
          pending,
          "Stop returned before joining its accepted source",
        ),
        signal,
      );
      expect(cancelledSettlement.status).toBe("pending");
      expect(untouchedSettlement.status).toBe("pending");
      expect(untouched.controller.signal.aborted).toBe(false);
      releaseCancelled.resolve();
      await expect(withinTest(pending, signal)).rejects.toThrow("Caller control revoked");
      expect(cancelledSettlement.status).toBe("fulfilled");
      expect(untouchedSettlement.status).toBe("pending");
      expect(untouched.controller.signal.aborted).toBe(false);
      expect(untouched.entry!.input.retirementRequested).not.toBe(true);
      expect(onResult).not.toHaveBeenCalled();
    } finally {
      releaseCancelled.resolve();
      releaseUntouched.resolve();
      await Promise.allSettled([pending, cancelledWork, untouchedWork]);
      cancelled.cleanup();
      untouched.cleanup();
      expectIdle();
    }
  },
);

it("joins an execution registered while its accepted Stop awaits kill-claim persistence", async () => {
  const { sessionKey, sessionId, sessionEntry, runId, storePath, context, resolveGatewayContext } =
    await seedExecutionTarget("late-execution-stop", "late-execution-stop-revision");
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const io = { emitAcceptance: vi.fn(), emitFinal: vi.fn() };
  const agentDedupeKeys = [`agent:${runId}`];
  const dedupeLifecycle = createAgentDedupeLifecycle({
    cfg: getRuntimeConfig(),
    request: { message: "Continue admitted work", idempotencyKey: runId },
    runId,
    agentDedupeKeys,
    suppressVisibleSessionEffects: false,
    context,
    io,
  });
  dedupeLifecycle.reserve(sessionKey, "main");
  dedupeLifecycle.bindSessionTarget({ sessionKey, sessionId, agentId: "main" });
  const claimGate = createEnteredGate();
  const interrupted = createDeferred();
  const releaseTail = createDeferred();
  const selectedTail = createDeferred();
  const onAbort = () => interrupted.resolve();
  let heldClaim = false;
  let admission: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
  let registration: ReturnType<typeof registerChatAbortController> | undefined;
  let execution: Promise<void> | undefined;
  let pending: ReturnType<typeof killSubagentRunAdmin> | undefined;
  const onResult = vi.fn(() => undefined);
  try {
    // The fence blocks new admission. This existing lease is adopted after capture.
    admission = await beginSessionEffect({
      scope: storePath,
      identities: [sessionKey, sessionId],
      run: { runId, sessionKey, sessionId, agentId: "main" },
      resolveGatewayContext,
      assertAllowed: () => {},
    });
    let admissionEntry: SessionEntry | undefined = sessionEntry;
    const nativeAdmission = createAgentAdmissionController({
      runId,
      agentDedupeKeys,
      expectedSession: { handoffId: admission.createHandoff(), sessionId },
      context,
      io,
      dedupeLifecycle,
      getRequestedSessionKey: () => sessionKey,
      getResolvedSessionKey: () => sessionKey,
      getResolvedSessionId: () => sessionId,
      getSessionEntry: () => admissionEntry,
      setSessionEntry: (entry) => {
        admissionEntry = entry;
      },
      getResolvedSessionAgentId: () => "main",
      getAgentId: () => "main",
      getSessionPersisted: () => true,
      getSupersededSessionId: () => undefined,
      setAdmittedSessionId: (value) => expect(value).toBe(sessionId),
    });
    interceptRegistryWrite(runId, (next) => {
      if (!next?.killIntent || heldClaim) {
        return undefined;
      }
      heldClaim = true;
      return claimGate.wait;
    });
    pending = killSubagentRunAdmin({
      cfg: getRuntimeConfig(),
      sessionKey,
      expectedRunId: runId,
      onResult,
    });
    const stopSettled = observeSettlement(pending);
    await awaitGateBeforeSettlement(
      claimGate.entered,
      pending,
      "Stop returned before the native kill claim committed",
    );
    expect(getRpcSource(runId)).toBeUndefined();
    expect(getSessionMutationCount()).toBe(1);
    await nativeAdmission.acquire(storePath);
    expect(nativeAdmission.getAdmission()).toBe(admission);
    expect(nativeAdmission.assertAllowed()).toMatchObject({ sessionId });
    expect(nativeAdmission.hasOutcome()).toBe(false);
    const activeRegistration = registerAbort(
      { runId, sessionKey, sessionId, storePath, resolveGatewayContext },
      lifecycleGeneration,
    );
    registration = activeRegistration;
    nativeAdmission.setAdmittedRunAbort(activeRegistration);
    const owner = activeRegistration.entry!;
    owner.input.abortSignal.addEventListener("abort", onAbort, { once: true });
    // Request preparation is already running under the adopted effect; cancellation
    // must retain its raw disposal even though no model turn has started yet.
    execution = (async () => {
      try {
        await interrupted.promise;
        activeRegistration.cleanup();
        nativeAdmission.release();
        await releaseTail.promise;
      } finally {
        activeRegistration.cleanup();
      }
    })();
    trackSessionControllerSourceWork(owner.input, execution);
    const settlement = observeExecutionJoin(owner, selectedTail.resolve);
    claimGate.release();
    await awaitGateBeforeSettlement(
      selectedTail.promise,
      pending,
      "Stop returned before joining its late execution",
    );
    expect(owner.input.abortSignal.aborted).toBe(true);
    expect(owner.adapter.abortStopReason).toBe("rpc");
    expect(settlement.status).toBe("pending");
    expectIdle();
    expect(stopSettled()).toBe(false);
    expect(onResult).not.toHaveBeenCalled();
    releaseTail.resolve();
    await expect(pending).resolves.toMatchObject({ found: true, killed: true });
    await execution;
    expect(settlement.status).toBe("fulfilled");
    expect(subagentRuns.get(runId)?.endedReason).toBe(SUBAGENT_ENDED_REASON_KILLED);
    expect(getRpcSource(runId)).toBeUndefined();
    expect(onResult).toHaveBeenCalledOnce();
  } finally {
    claimGate.release();
    interrupted.resolve();
    releaseTail.resolve();
    admission?.release();
    await Promise.allSettled([pending, execution]);
    registration?.controller.signal.removeEventListener("abort", onAbort);
    registration?.cleanup();
    fixture.worker.mockImplementation(runSubagentStateWorkerOperation);
    dedupeLifecycle.clearUnaccepted();
    expectIdle();
  }
});

it.each([
  { mode: "completed", startsAfterCleanup: false },
  { mode: "self-disposal", startsAfterCleanup: true },
  { mode: "self-disposal after turn completion", startsAfterCleanup: true },
  { mode: "self-disposal during wake cancellation", startsAfterCleanup: true },
  { mode: "self-disposal after registry binding loss", startsAfterCleanup: true },
  { mode: "completed callback error", startsAfterCleanup: true },
  { mode: "retained error", startsAfterCleanup: true },
  { mode: "controller replaced", startsAfterCleanup: true },
] as const)(
  "normal terminal cleanup preserves exact Stop ownership ($mode, afterCleanup=$startsAfterCleanup)",
  async ({ mode, startsAfterCleanup }) => {
    const sourceOnlyDisposal = mode === "self-disposal after turn completion";
    const registryBindingLoss = mode === "self-disposal after registry binding loss";
    const retiresDuringStop =
      mode === "self-disposal during wake cancellation" || registryBindingLoss;
    const selfDisposal = mode === "self-disposal" || sourceOnlyDisposal || retiresDuringStop;
    const completed = mode === "completed" || mode === "controller replaced" || selfDisposal;
    if (retiresDuringStop) {
      fixture.wake.mockResolvedValue(false);
    }
    const requester = "agent:main:main";
    const key = (id: string) => `agent:main:subagent:${id}`;
    let rootStorePath = "";
    let rootSessionEntry: SessionEntry | undefined;
    for (const id of ["root", "child", "healthy"]) {
      const storePath = await writeSession(id, `${id}-revision`);
      const sessionEntry = await readSessionEntryReadOnlyInWorker({
        agentId: "main",
        storePath,
        sessionKey: key(id),
      });
      if (id === "root") {
        rootStorePath = storePath;
        rootSessionEntry = sessionEntry;
      }
      await register(id, storePath, {
        requesterSessionKey: id === "child" ? key("root") : requester,
        requesterDisplayKey: requester,
        task: "retained cleanup ownership",
        collect: id !== "root" || !retiresDuringStop,
        sessionEntry,
      });
    }
    const root = subagentRuns.get("root")!;
    const captureRootExecution = () =>
      captureSubagentExecution({
        entry: root,
        session: { agentId: "main", storePath: rootStorePath, entry: rootSessionEntry },
      });
    const context = createDirectChatContext({ getRuntimeConfig });
    const resolver = () => context;
    bindGatewayContextResolver(root, resolver);
    const registrationTarget = {
      storePath: rootStorePath,
      runId: "root",
      sessionKey: key("root"),
      sessionId: "root-session",
      resolveGatewayContext: resolver,
    };
    const registration = registerAbort(registrationTarget);
    expect(getGatewayContextResolver(registration.entry!.input)).toBe(resolver);
    const releaseTail = createDeferred();
    const tailSelected = createDeferred();
    const cleanupGate = createEnteredGate();
    const failure = new Error("raw disposal callback failed");
    let callbackCompleted = false;
    let pending: ReturnType<typeof killAllControlledSubagentRuns> | undefined;
    let stopReturned = false;
    let bindingLost = false;
    const stop = () =>
      killAllControlledSubagentRuns({
        cfg: getRuntimeConfig(),
        controller: controlController,
        runs: [root],
        ...(retiresDuringStop ? { suppressTaskDelivery: true } : {}),
      });
    let resources: PluginRegistryInspectionResources | undefined;
    if (mode === "completed callback error") {
      const inspection = new PluginRegistryInspectionResources(retireInspectionInstances);
      resources = inspection;
      inspection.attach(createEmptyPluginRegistry());
      inspection.runRegistration("completed-cleanup", () => {
        inspection.register("completed-cleanup", {
          id: "callback",
          dispose: async () => {
            await releaseTail.promise;
            callbackCompleted = true;
            throw failure;
          },
        });
      });
    }
    const { completion: rawExecution } = await startSourceExecution(
      registration.entry!,
      async () => {
        registration.cleanup();
        await releaseTail.promise;
        if (mode === "retained error") {
          throw failure;
        }
        if (selfDisposal) {
          const selected = expectDefined(subagentRuns.get(root.runId), "terminal cleanup row");
          expect(getGatewayContextResolver(selected)).toBe(
            retiresDuringStop ? resolver : undefined,
          );
          if (retiresDuringStop) {
            expect(selected.requesterSettleWake).toBeDefined();
          }
          if (registryBindingLoss) {
            interceptRegistryWrite(root.runId, (next) => () => {
              if (next?.suppressCompletionDelivery && !next.requesterSettleWake) {
                const current = expectDefined(subagentRuns.get(root.runId), "wake owner");
                expect(getGatewayContextResolver(current)).toBe(resolver);
                // Retiring the registry projection does not revoke the controller input.
                clearGatewayContextResolver(current);
                bindingLost = true;
              }
            });
          }
          pending = stop();
          const result = await pending;
          stopReturned = true;
          const retired = expectDefined(subagentRuns.get(root.runId), "retired cleanup row");
          expect(getGatewayContextResolver(retired)).toBeUndefined();
          expect(retired.requesterSettleWake).toBeUndefined();
          expect(settlement.status).toBe("pending");
          expect(getRpcSource(root.runId)).toBe(registration.entry);
          expect(getGatewayContextResolver(registration.entry!.input)).toBe(resolver);
          if (registryBindingLoss) {
            expect(bindingLost).toBe(true);
          }
          if (result.status === "error") {
            throw new Error(result.error);
          }
        }
        await resources?.release();
      },
      registration.cleanup,
      sourceOnlyDisposal,
    );
    const execution = rawExecution.catch((error: unknown) => error);
    let observingStop = false;
    const settlement = observeExecutionJoin(registration.entry!, () => {
      if (observingStop) {
        tailSelected.resolve();
      }
    });
    fixture.cleanup.mockImplementationOnce(cleanupGate.wait);
    const startStop = async () => {
      observingStop = true;
      pending = stop();
      await awaitGateBeforeSettlement(
        tailSelected.promise,
        pending.then(() => {
          stopReturned = true;
        }),
        "Stop returned before its retired execution settled",
      );
    };
    try {
      emitAgentEvent({
        runId: root.runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          endedAt: Date.now(),
          terminalReply: { disposition: "visible", text: "completed" },
        },
      });
      await cleanupGate.entered;
      expect(subagentRuns.get(root.runId)?.execution.outcome?.status).toBe("ok");
      expect(getGatewayContextResolver(subagentRuns.get(root.runId)!)).toBe(resolver);
      if (!startsAfterCleanup) {
        await startStop();
      }
      cleanupGate.release();
      await fixture.settle();
      expect(subagentRuns.get(root.runId)?.cleanupCompletedAt).toBeTypeOf("number");
      expect(getGatewayContextResolver(subagentRuns.get(root.runId)!)).toBe(
        retiresDuringStop ? resolver : undefined,
      );
      expect(settlement.status).toBe("pending");
      expect(resolveSubagentSessionStatus(subagentRuns.get("child"))).toBe("running");
      if (startsAfterCleanup && !selfDisposal) {
        await startStop();
      }
      expect(stopReturned).toBe(false);
      expect(settlement.status).toBe("pending");
      expect(resolveSubagentSessionStatus(subagentRuns.get("child"))).toBe("running");
      if (mode === "controller replaced") {
        rpcSourceTesting.deleteExpected(root.runId, registration.entry!);
        registerAbort(registrationTarget);
        retireSubagentGatewayBinding(root);
        expect(captureRootExecution()?.execution).toBe(registration.entry);
      }
      releaseTail.resolve();
      if (selfDisposal) {
        expect(await execution).toBeUndefined();
        expect(stopReturned).toBe(true);
      }
      const result = await pending;
      const executionResult = await execution;
      expect(settlement.status).toBe(
        mode === "retained error" || mode === "completed callback error" ? "rejected" : "fulfilled",
      );
      expect(result).toMatchObject({
        status: completed ? "ok" : "error",
        killed: 1,
      });
      if (mode === "completed callback error") {
        expect(callbackCompleted).toBe(true);
        expect(result).toHaveProperty("error", expect.stringContaining(failure.message));
      } else if (mode === "retained error") {
        expect(executionResult).toBe(failure);
        expect(result).toHaveProperty("error", expect.stringContaining(failure.message));
      }
      expect(resolveSubagentSessionStatus(subagentRuns.get("child"))).toBe("killed");
      expect(resolveSubagentSessionStatus(subagentRuns.get("healthy"))).toBe("running");
      if (mode === "controller replaced") {
        expect(getRpcSource(root.runId)).not.toBe(registration.entry);
        retireSubagentGatewayBinding(root);
        expect(captureRootExecution()).toBeUndefined();
      }
    } finally {
      cleanupGate.release();
      releaseTail.resolve();
      await Promise.allSettled([pending, execution]);
      fixture.worker.mockImplementation(runSubagentStateWorkerOperation);
      registration.cleanup();
      if (mode === "controller replaced") {
        const replacement = getRpcSource(root.runId);
        if (replacement) {
          retireSessionControllerInput(replacement.input);
        }
      }
      await resources?.release().catch(() => {});
    }
  },
);
