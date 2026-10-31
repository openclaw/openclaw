import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureSessionTarget,
  runSessionMutation,
} from "../../sessions/session-controller.lifecycle.js";
import {
  captureSessionControllerProducers,
  type SessionControllerProducer,
} from "../../sessions/session-controller.producer-custody.js";
import { captureSessionControllerStop } from "../../sessions/session-controller.stop.js";
import { recordSubagentTerminalState } from "../../sessions/subagent-terminal-state.js";
import {
  AcpRuntimeError,
  toAcpRuntimeError,
  withAcpRuntimeErrorBoundary,
} from "../runtime/errors.js";
import {
  matchesAcpSessionRuntimeLocator,
  resolveAcpSessionControlOwner,
} from "../runtime/session-control-owner.js";
import type { AcpSessionRuntimeLocator } from "../runtime/session-meta-control.types.js";
import { resolveSessionStorePathForAcp } from "../runtime/session-meta-store.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import { emitCancelledAcpTurn } from "./manager.turn-stream.js";
import type {
  ActiveTurnState,
  AcpCancelSessionInput,
  AcpRunTurnInput,
  AcpSessionTarget,
  AcpSessionManagerDeps,
  EnsureManagerRuntimeHandle,
  ResolveManagerSessionAsync,
  RevalidateManagerSessionControl,
  SetManagerSessionState,
  WithManagerSessionActor,
} from "./manager.types.js";
import { requireReadySessionMeta, resolveAcpSessionTarget } from "./manager.utils.js";
import { normalizeText } from "./runtime-options.js";

type ManagerCancellationServices = {
  withSessionActor: WithManagerSessionActor;
  resolveSession: ResolveManagerSessionAsync;
  prepareSessionControlRead: AcpSessionManagerDeps["prepareSessionControlRead"];
  ensureRuntimeHandle: EnsureManagerRuntimeHandle;
  runtimeHandles: Pick<ManagerRuntimeHandleCache, "get" | "clearIfHandleMatches">;
  setSessionState: SetManagerSessionState;
};

/** Selects cancellation targets before awaiting authority, excluding later arrivals. */
export async function runManagerCancelSession(
  params: AcpCancelSessionInput & ManagerCancellationServices & { producerOwner: object },
): Promise<void> {
  params.assertActive?.();
  const target = resolveAcpSessionTarget(params);
  const { storePath, storeSessionKey } = resolveSessionStorePathForAcp({
    cfg: params.cfg,
    ...target,
  });
  const controllerTarget = captureSessionTarget({
    storeScope: storePath,
    sessionKey: storeSessionKey,
    agentId: target.agentId,
  });
  const expectedRunId = params.expectedRunId?.trim();
  const expectedInstanceId = params.expectedInstanceId?.trim();
  const expectedOwnerKey = params.expectedOwnerKey?.trim();
  const producers = captureSessionControllerProducers({
    owner: params.producerOwner,
    target: controllerTarget,
    expectedRunId,
    expectedInstanceId,
  });
  if (producers.length) {
    await cancelManagerProducers({ ...params, ...target, expectedOwnerKey, producers });
    return;
  }
  if (expectedRunId || expectedInstanceId) {
    throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP task is no longer the active run.");
  }
  await runSessionMutation({
    target: controllerTarget,
    policy: "allow-live",
    assertCurrent: params.assertActive,
    run: async () => {
      const captured = captureSessionControllerStop({ targets: [controllerTarget] });
      if (
        captured.operations.length ||
        captured.inputs.some((input) => input.claim && !input.claim.released)
      ) {
        throw new AcpRuntimeError(
          "ACP_TURN_FAILED",
          "ACP session has controller-owned work; cancel it through Stop.",
        );
      }
      await cancelIdleManagerSession({ ...params, ...target, expectedOwnerKey });
    },
  });
}

/** Cancels only the invocation snapshot, retaining its authority guard through backend effects. */
async function cancelManagerProducers(params: {
  assertActive?: () => void;
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  reason?: string;
  expectedOwnerKey?: string;
  producers: readonly SessionControllerProducer[];
  prepareSessionControlRead: AcpSessionManagerDeps["prepareSessionControlRead"];
}): Promise<void> {
  params.assertActive?.();
  const control = params.expectedOwnerKey
    ? await params.prepareSessionControlRead({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
      })
    : undefined;
  const assertCurrent = () => {
    control?.assertCurrent(params.cfg);
    params.assertActive?.();
  };
  const revalidate = async () => {
    assertCurrent();
    if (control) {
      const current = await control.readCurrent(params.cfg);
      assertCurrent();
      if (
        !current.session?.acp ||
        resolveAcpSessionControlOwner(current.entry) !== params.expectedOwnerKey
      ) {
        throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP task owner could not be verified.");
      }
    }
  };
  try {
    await revalidate();
    const settled = await Promise.allSettled(
      params.producers.map(async (producer) => {
        producer.cancel(params.reason, { revalidate, assertCurrent });
        await producer.settled;
      }),
    );
    const failed = settled.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") {
      throw failed.reason;
    }
  } finally {
    control?.release();
  }
}

/** Sends ACP cancel to a backend that has no OpenClaw turn, such as a persistent runtime. */
async function cancelIdleManagerSession(
  params: AcpCancelSessionInput & AcpSessionTarget & ManagerCancellationServices,
): Promise<void> {
  params.assertActive?.();
  const target = { cfg: params.cfg, sessionKey: params.sessionKey, agentId: params.agentId };
  type ControlRead = Awaited<ReturnType<AcpSessionManagerDeps["prepareSessionControlRead"]>>;
  const readCurrentOwner = async (read: ControlRead) => {
    const current = await read.readCurrent(params.cfg);
    read.assertCurrent(params.cfg);
    if (
      !current.session?.acp ||
      (params.expectedOwnerKey &&
        resolveAcpSessionControlOwner(current.entry) !== params.expectedOwnerKey)
    ) {
      throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP task owner could not be verified.");
    }
    return current;
  };
  await params.withSessionActor(params, async (isCurrentActor) => {
    const control = await params.prepareSessionControlRead(target);
    let runtimeLocator: AcpSessionRuntimeLocator | undefined;
    const assertTargetCurrent = () => {
      control.assertCurrent(params.cfg);
      control.assertAcpCurrent?.(params.cfg, runtimeLocator);
      if (!isCurrentActor()) {
        throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP session actor was replaced.");
      }
    };
    const assertAdmission = () => {
      assertTargetCurrent();
      params.assertActive?.();
    };
    try {
      assertAdmission();
      if (params.expectedOwnerKey) {
        await readCurrentOwner(control);
        assertAdmission();
      }
      const resolution = await params.resolveSession({ ...target, assertCurrent: assertAdmission });
      assertAdmission();
      const resolvedMeta = requireReadySessionMeta(resolution);
      const { entry, constraint } = await readCurrentOwner(control);
      assertAdmission();
      const ownerKey = resolveAcpSessionControlOwner(entry);
      const { runtime, handle } = await params.ensureRuntimeHandle({
        ...target,
        assertActive: assertAdmission,
        meta: resolvedMeta,
        isCurrentActor,
        readAcpControl: () => constraint,
        assertMetadataCommitAllowed: (locator) => {
          control.assertAcpCurrent?.(params.cfg, locator);
        },
        expectedControlBinding:
          entry && ownerKey
            ? {
                sessionId: entry.sessionId,
                lifecycleRevision: entry.lifecycleRevision,
                sessionStartedAt: entry.sessionStartedAt,
                ownerKey,
              }
            : undefined,
      });
      const ensuredLocator: AcpSessionRuntimeLocator = {
        backend: handle.backend,
        runtimeSessionName: handle.runtimeSessionName,
      };
      runtimeLocator = ensuredLocator;
      const readCurrentRuntime = async () => {
        const current = await readCurrentOwner(control);
        if (!matchesAcpSessionRuntimeLocator(current.session.acp, ensuredLocator)) {
          throw new AcpRuntimeError(
            "ACP_TURN_FAILED",
            "ACP runtime locator changed before cancellation.",
          );
        }
        return current.constraint
          ? { ...current.constraint, runtimeLocator: ensuredLocator }
          : undefined;
      };
      let failure: AcpRuntimeError | undefined;
      try {
        await readCurrentRuntime();
        assertAdmission();
        try {
          await runtime.cancel({ handle, reason: params.reason });
        } catch (error) {
          failure = toAcpRuntimeError({
            error,
            fallbackCode: "ACP_TURN_FAILED",
            fallbackMessage: "ACP cancel failed before completion.",
          });
        }
        const acpControl = await readCurrentRuntime();
        assertTargetCurrent();
        await params.setSessionState({
          ...target,
          state: failure ? "error" : "idle",
          lastError: failure?.message,
          clearLastError: !failure,
          isCurrentActor,
          assertCurrent: assertTargetCurrent,
          acpControl,
        });
      } catch (error) {
        // Retire only this cache entry; persistent backend state may have another owner.
        if (isCurrentActor() && params.runtimeHandles.get(target)?.handle === handle) {
          params.runtimeHandles.clearIfHandleMatches({ ...target, handle });
        }
        throw error;
      }
      if (failure) {
        throw failure;
      }
    } finally {
      control.release();
    }
  });
}

/** Aborts and deduplicates runtime cancellation for one active manager turn. */
export async function cancelManagerActiveTurn(params: {
  activeTurn: ActiveTurnState;
  reason?: string;
  assertCurrent?: () => void;
  revalidate?: RevalidateManagerSessionControl;
}): Promise<void> {
  if (!params.activeTurn.cancelPromise) {
    let runtimeCancelStarted = false;
    // The stream abort and its caller join the same runtime effect.
    const cancellation = withAcpRuntimeErrorBoundary({
      run: async () => {
        // Yield so reentrant cancellation from the abort below sees the installed promise.
        await (params.revalidate?.() ?? Promise.resolve());
        params.assertCurrent?.();
        params.activeTurn.abortController.abort();
        runtimeCancelStarted = true;
        await params.activeTurn.runtime.cancel({
          handle: params.activeTurn.handle,
          reason: params.reason,
        });
      },
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "ACP cancel failed before completion.",
    });
    params.activeTurn.cancelPromise = cancellation;
    void cancellation.catch(() => {
      // A refused admission can retry; an attempted RPC must retain its possibly applied outcome.
      if (!runtimeCancelStarted && params.activeTurn.cancelPromise === cancellation) {
        params.activeTurn.cancelPromise = undefined;
      }
    });
  }
  await params.activeTurn.cancelPromise;
}

/** Persists a queued cancellation before publishing its terminal event. */
export async function publishManagerCancelledTurnBeforeStart(params: {
  input: AcpRunTurnInput;
  target: AcpSessionTarget;
  ownsRunTerminal: boolean;
  assertActorCurrent: () => void;
  prepareSessionControlRead: AcpSessionManagerDeps["prepareSessionControlRead"];
}): Promise<void> {
  const { input, target, ownsRunTerminal, assertActorCurrent } = params;
  const control = await params.prepareSessionControlRead({
    cfg: input.cfg,
    ...target,
    assertCurrent: assertActorCurrent,
  });
  const assertCurrent = () => {
    assertActorCurrent();
    control.assertCurrent(input.cfg);
    control.assertAcpCurrent?.(input.cfg);
  };
  try {
    assertCurrent();
    if (input.mode === "prompt" && ownsRunTerminal) {
      const { entry, constraint } = control.initialRead;
      const requesterSessionKey =
        normalizeText(entry?.spawnedBy) ?? normalizeText(entry?.parentSessionKey);
      if (requesterSessionKey) {
        await recordSubagentTerminalState(
          {
            childSessionKey: target.sessionKey,
            agentId: target.agentId,
            runId: input.requestId,
            requesterSessionKey,
            outcomeStatus: "cancelled",
          },
          assertCurrent,
          constraint,
        );
      }
    }
    // A refused best-effort write must not authorize a stale terminal event.
    const current = await control.readCurrent(input.cfg);
    assertCurrent();
    if (!current.session.acp) {
      throw new AcpRuntimeError(
        "ACP_TURN_FAILED",
        "ACP metadata changed before cancellation publication.",
      );
    }
    await emitCancelledAcpTurn(input.onEvent);
  } finally {
    control.release();
  }
}
