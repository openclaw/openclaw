// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { runSubagentStateWorkerOperation, useSubagentControlFixture } from "./subagent-control.test-support.js";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { createAgentAdmissionController } from "../../../gateway/agent-turn/agent-admission-controller.js";
import { createAgentDedupeLifecycle } from "../../../gateway/agent-turn/agent-dedupe-lifecycle.js";
import { runWithChatAbortExecution } from "../../../gateway/chat-abort-lifecycle-internal.js";
import {
  registerChatAbortController,
  type ChatAbortControllerEntry,
} from "../../../gateway/chat-abort.js";
import { createDirectChatContext } from "../../../gateway/server-chat.agent-events.test-helpers.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../../../plugins/registry-inspection-resources.js";
import { retireInspectionInstances } from "../../../plugins/registry-inspection.test-support.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
  getActiveSessionWorkAdmissionCount,
} from "../../../sessions/session-lifecycle-admission.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import { isSubagentRegistryWriteCommand } from "../../subagent-test-fixtures.test-helpers.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { markSubagentRunTerminated, registerSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

const fixture = useSubagentControlFixture();

async function seedExecutionTarget(name: string, task: string) {
  const sessionKey = `agent:main:subagent:${name}`;
  const sessionId = `${name}-session`;
  const runId = `${name}-run`;
  const storePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey,
    defaultSessionId: sessionId,
  });
  await registerSubagentRun({
    runId,
    childSessionKey: sessionKey,
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task,
    cleanup: "keep",
    expectsCompletionMessage: false,
  });
  const context = createDirectChatContext({ getRuntimeConfig });
  const resolveGatewayContext = () => context;
  bindGatewayContextResolver(subagentRuns.get(runId)!, resolveGatewayContext);
  return { sessionKey, sessionId, runId, storePath, context, resolveGatewayContext };
}

function observeExecutionJoin(entry: ChatAbortControllerEntry, selected: () => void) {
  const settlement = entry.executionSettlement!;
  const completion = settlement.completion;
  // Observe selection without replacing the execution owner's promise.
  Object.defineProperty(settlement, "completion", {
    get() {
      selected();
      return completion;
    },
  });
  return settlement;
}

it.each(["abort", "interruption", "replacement", "already terminal"] as const)(
  "joins accepted native Stop cleanup before refusing revoked publication (%s)",
  async (mode) => {
    const { sessionKey, sessionId, runId, storePath, context } = await seedExecutionTarget(
      "accepted-stop",
      "retain the selected cancellation outcome",
    );
    const registration = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId,
      sessionKey,
      sessionId,
      kind: "agent",
      timeoutMs: 60_000,
    });
    const owner = registration.entry!;
    const releaseTail = createDeferred();
    const selectedTail = createDeferred();
    const execution = runWithChatAbortExecution(
      owner,
      async () => {
        await releaseTail.promise;
        registration.cleanup();
      },
      registration.cleanup,
    );
    let observingStop = false;
    const settlement = observeExecutionJoin(owner, () => {
      if (observingStop) {
        selectedTail.resolve();
      }
    });
    const abort = vi.fn(() => registration.controller.abort());
    const handle = createEmbeddedRunHandle({ runId, abort });
    setActiveEmbeddedRun(sessionId, handle, sessionKey);
    const admission =
      mode === "interruption"
        ? await beginSessionWorkAdmission({
            scope: storePath,
            identities: [sessionKey, sessionId],
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
    const onResult = vi.fn(() => undefined);
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
        },
      );
      await awaitGateBeforeSettlement(
        selectedTail.promise,
        pending,
        "Stop returned before joining its exact raw execution",
      );
      expect(settlement.status).toBe("pending");
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
      expect(owner.controller.signal.aborted).toBe(mode !== "already terminal");
      callerAuthorized = false;
      if (mode === "replacement") {
        context.chatAbortControllers.set(runId, {
          ...owner,
          controller: new AbortController(),
          executionSettlement: undefined,
        });
      }
      releaseTail.resolve();
      await expect(pending).rejects.toThrow("Caller control revoked");
      expect(settlement.status).toBe("fulfilled");
      expect(subagentRuns.get(runId)?.execution.status).toBe("terminal");
      expect(subagentRuns.get(runId)?.endedReason).toBe(SUBAGENT_ENDED_REASON_KILLED);
      expect(onResult).not.toHaveBeenCalled();
      if (mode === "replacement") {
        expect(context.chatAbortControllers.get(runId)?.controller.signal.aborted).toBe(false);
      } else if (mode === "already terminal") {
        expect(abort).not.toHaveBeenCalled();
      }
    } finally {
      releaseTail.resolve();
      admission?.release();
      await Promise.allSettled([termination, pending, execution]);
      registration.cleanup();
      context.chatAbortControllers.clear();
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      expect(getActiveSessionWorkAdmissionCount()).toBe(0);
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
    }
  },
);

it.each(["declined", "throws"] as const)(
  "joins a Stop accepted by the session callback (outcome: %s)",
  async (mode) => {
    const { sessionKey, sessionId, runId, context } = await seedExecutionTarget(
      "callback-stop",
      "retain callback cancellation until raw disposal settles",
    );
    const registration = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId,
      sessionKey,
      sessionId,
      kind: "agent",
      timeoutMs: 60_000,
    });
    const owner = registration.entry!;
    const releaseTail = createDeferred();
    const selectedTail = createDeferred();
    const execution = runWithChatAbortExecution(
      owner,
      async () => {
        await releaseTail.promise;
        registration.cleanup();
      },
      registration.cleanup,
    );
    const settlement = observeExecutionJoin(owner, selectedTail.resolve);
    const pending = killSubagentRunAdmin(
      { cfg: getRuntimeConfig(), sessionKey, expectedRunId: runId },
      {
        assertCurrent: () => {},
        beforeSessionKill: () => {
          registration.controller.abort();
          if (mode === "declined") {
            return false;
          }
          throw new Error("callback failed after Stop");
        },
      },
    );
    try {
      await awaitGateBeforeSettlement(
        selectedTail.promise,
        pending,
        "Stop returned before joining its exact raw execution",
      );
      expect(settlement.status).toBe("pending");
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
      expect(owner.controller.signal.aborted).toBe(true);
      releaseTail.resolve();
      const result = await pending;
      expect(result).toMatchObject({ found: true, killed: false });
      if (mode !== "declined") {
        expect(result).toHaveProperty("error", expect.any(String));
      }
    } finally {
      releaseTail.resolve();
      await Promise.allSettled([pending, execution]);
      registration.cleanup();
      context.chatAbortControllers.clear();
      expect(getActiveSessionWorkAdmissionCount()).toBe(0);
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
    }
  },
);

it("joins an execution registered while its accepted Stop awaits kill-claim persistence", async () => {
  const { sessionKey, sessionId, runId, storePath, context, resolveGatewayContext } =
    await seedExecutionTarget(
      "late-execution-stop",
      "join the exact execution that accepts cancellation",
    );
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const io = { emitAcceptance: vi.fn(), emitFinal: vi.fn() };
  const agentDedupeKeys = [`agent:${runId}`];
  const dedupeLifecycle = createAgentDedupeLifecycle({
    cfg: getRuntimeConfig(),
    request: { message: "Continue admitted work", idempotencyKey: runId },
    runId,
    lifecycleGeneration,
    agentDedupeKeys,
    suppressVisibleSessionEffects: false,
    context,
    io,
  });
  dedupeLifecycle.reserve(sessionKey, "main");
  dedupeLifecycle.bindSessionTarget({ sessionKey, sessionId, agentId: "main" });
  const claimCommitted = createDeferred();
  const releaseClaim = createDeferred();
  const interrupted = createDeferred();
  const releaseTail = createDeferred();
  const selectedTail = createDeferred();
  const onAbort = () => interrupted.resolve();
  let heldClaim = false;
  let admission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
  let registration: ReturnType<typeof registerChatAbortController> | undefined;
  let execution: Promise<void> | undefined;
  let pending: ReturnType<typeof killSubagentRunAdmin> | undefined;
  let stopSettled = false;
  const onResult = vi.fn(() => undefined);
  try {
    // The fence blocks new admission. This existing lease is adopted after capture.
    admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      resolveGatewayContext,
      assertAllowed: () => {},
    });
    let admissionEntry: SessionEntry | undefined = { sessionId, updatedAt: 1 };
    const nativeAdmission = createAgentAdmissionController({
      runId,
      lifecycleGeneration,
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
    fixture.worker.mockImplementation((stateContext, operation, options) =>
      runSubagentStateWorkerOperation(
        stateContext,
        (scope) =>
          operation({
            execute: async (command, commandOptions) => {
              const row = isSubagentRegistryWriteCommand(command)
                ? command.input.values.find((candidate) => candidate.run_id === runId)
                : undefined;
              const claim = row && rowToSubagentRunRecord(row)?.killIntent;
              const holdClaim = Boolean(claim) && !heldClaim;
              heldClaim ||= holdClaim;
              const receipt = await scope.execute(command, commandOptions);
              if (holdClaim) {
                claimCommitted.resolve();
                await releaseClaim.promise;
              }
              return receipt;
            },
          }),
        options,
      ),
    );
    pending = killSubagentRunAdmin({
      cfg: getRuntimeConfig(),
      sessionKey,
      expectedRunId: runId,
      onResult,
    });
    void pending.then(
      () => {
        stopSettled = true;
      },
      () => {
        stopSettled = true;
      },
    );
    await awaitGateBeforeSettlement(
      claimCommitted.promise,
      pending,
      "Stop returned before the native kill claim committed",
    );
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    expect(getActiveSessionLifecycleMutationCount()).toBe(1);
    await nativeAdmission.acquire(storePath);
    expect(nativeAdmission.getAdmission()).toBe(admission);
    expect(nativeAdmission.assertAllowed()).toMatchObject({ sessionId });
    expect(nativeAdmission.hasOutcome()).toBe(false);
    const activeRegistration = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId,
      sessionKey,
      sessionId,
      lifecycleGeneration,
      kind: "agent",
      timeoutMs: 60_000,
    });
    registration = activeRegistration;
    nativeAdmission.setAdmittedRunAbort(activeRegistration);
    const owner = activeRegistration.entry!;
    owner.controller.signal.addEventListener("abort", onAbort, { once: true });
    execution = runWithChatAbortExecution(
      owner,
      async () => {
        await interrupted.promise;
        activeRegistration.cleanup();
        nativeAdmission.release();
        // Native execution releases admission before its async runtime disposal ends.
        await releaseTail.promise;
      },
      activeRegistration.cleanup,
    );
    const settlement = observeExecutionJoin(owner, selectedTail.resolve);
    releaseClaim.resolve();
    await awaitGateBeforeSettlement(
      selectedTail.promise,
      pending,
      "Stop returned before joining its late execution",
    );
    expect(owner.controller.signal.aborted).toBe(true);
    expect(owner.abortStopReason).toBe("rpc");
    expect(settlement.status).toBe("pending");
    expect(getActiveSessionWorkAdmissionCount()).toBe(0);
    expect(getActiveSessionLifecycleMutationCount()).toBe(0);
    expect(stopSettled).toBe(false);
    expect(onResult).not.toHaveBeenCalled();
    releaseTail.resolve();
    await expect(pending).resolves.toMatchObject({ found: true, killed: true });
    await execution;
    expect(settlement.status).toBe("fulfilled");
    expect(subagentRuns.get(runId)?.endedReason).toBe(SUBAGENT_ENDED_REASON_KILLED);
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    expect(onResult).toHaveBeenCalledOnce();
  } finally {
    releaseClaim.resolve();
    interrupted.resolve();
    releaseTail.resolve();
    admission?.release();
    await Promise.allSettled([pending, execution]);
    registration?.controller.signal.removeEventListener("abort", onAbort);
    registration?.cleanup();
    fixture.worker.mockImplementation(runSubagentStateWorkerOperation);
    dedupeLifecycle.clearUnaccepted();
    context.chatAbortControllers.clear();
    expect(getActiveSessionWorkAdmissionCount()).toBe(0);
    expect(getActiveSessionLifecycleMutationCount()).toBe(0);
  }
});

it.each([
  { mode: "completed", startsAfterCleanup: false },
  { mode: "self-disposal", startsAfterCleanup: true },
  { mode: "self-disposal during wake cancellation", startsAfterCleanup: true },
  { mode: "self-disposal with unrecorded binding loss", startsAfterCleanup: true },
  { mode: "completed callback error", startsAfterCleanup: true },
  { mode: "retained error", startsAfterCleanup: true },
  { mode: "controller replaced", startsAfterCleanup: true },
] as const)(
  "normal terminal cleanup preserves exact Stop ownership ($mode, afterCleanup=$startsAfterCleanup)",
  async ({ mode, startsAfterCleanup }) => {
    const unrecordedLoss = mode === "self-disposal with unrecorded binding loss";
    const retiresDuringStop = mode === "self-disposal during wake cancellation" || unrecordedLoss;
    const selfDisposal = mode === "self-disposal" || retiresDuringStop;
    const completed = mode === "completed" || (selfDisposal && !unrecordedLoss);
    if (retiresDuringStop) {
      fixture.wake.mockResolvedValue(false);
    }
    const requester = "agent:main:main";
    const key = (id: string) => `agent:main:subagent:${id}`;
    const controller = {
      controllerSessionKey: requester,
      controllerAgentId: "main",
      callerSessionKey: requester,
      callerIsSubagent: false,
      controlScope: "children" as const,
    };
    for (const id of ["root", "child", "healthy"]) {
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: key(id),
        defaultSessionId: `${id}-session`,
        lifecycleRevision: `${id}-revision`,
      });
      await registerSubagentRun({
        runId: id,
        childSessionKey: key(id),
        requesterSessionKey: id === "child" ? key("root") : requester,
        requesterAgentId: "main",
        requesterDisplayKey: requester,
        task: "retained cleanup ownership",
        cleanup: "keep",
        collect: id !== "root" || !retiresDuringStop,
        sessionEntry: { sessionId: `${id}-session`, lifecycleRevision: `${id}-revision` },
        expectsCompletionMessage: false,
      });
    }
    const root = subagentRuns.get("root")!;
    const context = createDirectChatContext({ getRuntimeConfig });
    const resolver = () => context;
    bindGatewayContextResolver(root, resolver);
    const registrationParams = {
      chatAbortControllers: context.chatAbortControllers,
      runId: "root",
      sessionKey: key("root"),
      sessionId: "root-session",
      kind: "agent" as const,
      timeoutMs: 60_000,
    };
    const registration = registerChatAbortController(registrationParams);
    const releaseTail = createDeferred();
    const tailSelected = createDeferred();
    const cleanupEntered = createDeferred();
    const releaseCleanup = createDeferred();
    const failure = new Error("raw disposal callback failed");
    let callbackCompleted = false;
    let pending: ReturnType<typeof killAllControlledSubagentRuns> | undefined;
    let stopReturned = false;
    let bindingLost = false;
    const stop = () =>
      killAllControlledSubagentRuns({
        cfg: getRuntimeConfig(),
        controller,
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
    const execution = runWithChatAbortExecution(
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
          if (unrecordedLoss) {
            fixture.worker.mockImplementation((stateContext, operation, options) =>
              runSubagentStateWorkerOperation(
                stateContext,
                (scope) =>
                  operation({
                    execute: async (command, commandOptions) => {
                      const row = isSubagentRegistryWriteCommand(command)
                        ? command.input.values.find((candidate) => candidate.run_id === root.runId)
                        : undefined;
                      const next = row && rowToSubagentRunRecord(row);
                      const receipt = await scope.execute(command, commandOptions);
                      if (next?.suppressCompletionDelivery && !next.requesterSettleWake) {
                        const current = expectDefined(subagentRuns.get(root.runId), "wake owner");
                        expect(getGatewayContextResolver(current)).toBe(resolver);
                        // Lose the binding before publication can record its retirement.
                        clearGatewayContextResolver(current);
                        bindingLost = true;
                      }
                      return receipt;
                    },
                  }),
                options,
              ),
            );
          }
          pending = stop();
          const result = await pending;
          stopReturned = true;
          const retired = expectDefined(subagentRuns.get(root.runId), "retired cleanup row");
          expect(getGatewayContextResolver(retired)).toBeUndefined();
          expect(retired.requesterSettleWake).toBeUndefined();
          expect(registration.entry?.executionSettlement).toMatchObject({
            status: "pending",
            cleanupSettled: false,
          });
          expect(context.chatAbortControllers.get(root.runId)).toBe(registration.entry);
          if (unrecordedLoss) {
            expect(bindingLost).toBe(true);
            expect(result).toHaveProperty("error", expect.stringContaining("owner changed"));
          } else if (result.status === "error") {
            throw new Error(result.error);
          }
        }
        await resources?.release();
      },
      registration.cleanup,
    ).catch((error: unknown) => error);
    let observingStop = false;
    const settlement = observeExecutionJoin(registration.entry!, () => {
      if (observingStop) {
        tailSelected.resolve();
      }
    });
    fixture.cleanup.mockImplementationOnce(async () => {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
    });
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
      await cleanupEntered.promise;
      expect(subagentRuns.get(root.runId)?.execution.outcome?.status).toBe("ok");
      expect(getGatewayContextResolver(subagentRuns.get(root.runId)!)).toBe(resolver);
      if (!startsAfterCleanup) {
        await startStop();
      }
      releaseCleanup.resolve();
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
        context.chatAbortControllers.delete(root.runId);
        registerChatAbortController(registrationParams);
      }
      releaseTail.resolve();
      if (selfDisposal) {
        expect(await execution).toBeUndefined();
        expect(stopReturned).toBe(true);
      }
      const result = await pending;
      await execution;
      const cleanupCompleted = completed || mode === "completed callback error";
      expect(settlement.cleanupSettled).toBe(mode !== "retained error");
      expect(result).toMatchObject({
        status: completed ? "ok" : "error",
        killed: cleanupCompleted ? 1 : 0,
      });
      if (mode === "completed callback error") {
        expect(callbackCompleted).toBe(true);
        expect(result).toHaveProperty("error", expect.stringContaining(failure.message));
      } else if (!cleanupCompleted) {
        expect(result).toHaveProperty("error", expect.stringContaining("owner changed"));
      }
      expect(resolveSubagentSessionStatus(subagentRuns.get("child"))).toBe(
        cleanupCompleted ? "killed" : "running",
      );
      expect(resolveSubagentSessionStatus(subagentRuns.get("healthy"))).toBe("running");
      if (mode === "controller replaced") {
        expect(context.chatAbortControllers.get(root.runId)).not.toBe(registration.entry);
      }
    } finally {
      releaseCleanup.resolve();
      releaseTail.resolve();
      await Promise.allSettled([pending, execution]);
      fixture.worker.mockImplementation(runSubagentStateWorkerOperation);
      registration.cleanup();
      await resources?.release().catch(() => {});
      context.chatAbortControllers.clear();
    }
  },
);
