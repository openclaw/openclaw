import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  AcpRuntimeError,
  toAcpRuntimeError,
  withAcpRuntimeErrorBoundary,
} from "../runtime/errors.js";
import {
  matchesAcpSessionRuntimeLocator,
  resolveAcpSessionControlOwner,
  type AcpSessionRuntimeLocator,
} from "../runtime/session-control-owner.js";
import type { AcceptedTurnState, AcceptedTurns } from "./manager.accepted-turns.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import type {
  ActiveTurnState,
  AcpSessionManagerDeps,
  EnsureManagerRuntimeHandle,
  ResolveManagerSessionAsync,
  SetManagerSessionState,
  WithManagerSessionActor,
} from "./manager.types.js";
import { acpSessionActorKey, requireReadySessionMeta } from "./manager.utils.js";

async function settleManagerCancellations(cancellations: Promise<void>[]): Promise<void> {
  const settled = await Promise.allSettled(cancellations);
  const errors = [
    ...new Set(settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))),
  ];
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "ACP accepted cancellation failed before completion.");
  }
}

export async function runManagerCancelSession(params: {
  assertActive?: () => void;
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  reason?: string;
  expectedRunId?: string;
  expectedInstanceId?: string;
  expectedOwnerKey?: string;
  activeTurnBySession: Map<string, ActiveTurnState>;
  acceptedTurns: AcceptedTurns;
  withSessionActor: WithManagerSessionActor;
  resolveSession: ResolveManagerSessionAsync;
  prepareSessionControlRead: AcpSessionManagerDeps["prepareSessionControlRead"];
  ensureRuntimeHandle: EnsureManagerRuntimeHandle;
  runtimeHandles: Pick<ManagerRuntimeHandleCache, "get" | "clearIfHandleMatches">;
  setSessionState: SetManagerSessionState;
}): Promise<void> {
  params.assertActive?.();
  const actorKey = acpSessionActorKey(params);
  const target = { cfg: params.cfg, sessionKey: params.sessionKey, agentId: params.agentId };
  const expectedRunId = params.expectedRunId?.trim();
  const expectedInstanceId = params.expectedInstanceId?.trim();
  const expectedOwnerKey = params.expectedOwnerKey?.trim();
  const requireExpectedTurn = (
    current: Pick<ActiveTurnState, "requestId" | "instanceId"> | undefined,
  ) => {
    if (
      (expectedRunId && current?.requestId !== expectedRunId) ||
      (expectedInstanceId && current?.instanceId !== expectedInstanceId)
    ) {
      throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP task is no longer the active run.");
    }
  };
  type ControlRead = Awaited<ReturnType<AcpSessionManagerDeps["prepareSessionControlRead"]>>;
  const requireExpectedOwner = async (read: ControlRead) => {
    const current = await read.readCurrent(params.cfg);
    read.assertCurrent(params.cfg);
    if (
      !current.session?.acp ||
      (expectedOwnerKey && resolveAcpSessionControlOwner(current.entry) !== expectedOwnerKey)
    ) {
      throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP task owner could not be verified.");
    }
    return current;
  };
  // Snapshot accepted instances before yielding: a later successor is never cancelled.
  const acceptedSet = params.acceptedTurns.get(actorKey);
  const accepted = [...(acceptedSet ?? [])].filter(
    (turn) =>
      (!expectedRunId || turn.requestId === expectedRunId) &&
      (!expectedInstanceId || turn.instanceId === expectedInstanceId),
  );
  if (accepted.length > 0) {
    const control = expectedOwnerKey ? await params.prepareSessionControlRead(target) : undefined;
    try {
      await settleManagerCancellations(
        accepted.map((acceptedTurn) => {
          let admitted = false;
          let publicationLocator: AcpSessionRuntimeLocator | undefined;
          const retireCapturedHandle = () => {
            const handle = acceptedTurn.runtimeHandle;
            if (
              handle &&
              acceptedTurn.isCurrentActor() &&
              params.runtimeHandles.get(target)?.handle === handle
            ) {
              params.runtimeHandles.clearIfHandleMatches({ ...target, handle });
            }
          };
          return cancelManagerAcceptedTurn({
            acceptedTurn,
            reason: params.reason,
            revalidate: control
              ? async (phase) => {
                  try {
                    const current = await requireExpectedOwner(control);
                    const runtimeLocator = acceptedTurn.runtimeHandle ?? publicationLocator;
                    if (
                      phase === "publication" &&
                      runtimeLocator &&
                      !matchesAcpSessionRuntimeLocator(current.session.acp, runtimeLocator)
                    ) {
                      throw new AcpRuntimeError(
                        "ACP_TURN_FAILED",
                        "ACP runtime locator changed before cancellation publication.",
                      );
                    }
                    const constraint = current.constraint
                      ? runtimeLocator
                        ? {
                            ...current.constraint,
                            runtimeLocator: {
                              backend: runtimeLocator.backend,
                              runtimeSessionName: runtimeLocator.runtimeSessionName,
                            },
                          }
                        : current.constraint
                      : undefined;
                    if (admitted && constraint) {
                      acceptedTurn.cancelConstraint = constraint;
                    }
                    return constraint;
                  } catch (error) {
                    if (phase === "publication") {
                      retireCapturedHandle();
                    }
                    throw error;
                  }
                }
              : undefined,
            assertCurrent: (phase, expectedLocator) => {
              if (control && phase === "publication" && expectedLocator) {
                publicationLocator ??= {
                  backend: expectedLocator.backend,
                  runtimeSessionName: expectedLocator.runtimeSessionName,
                };
              }
              try {
                control?.assertCurrent(params.cfg);
                control?.assertNativeAcpCurrent?.(
                  params.cfg,
                  phase === "publication"
                    ? (expectedLocator ?? acceptedTurn.runtimeHandle ?? publicationLocator)
                    : undefined,
                );
                if (
                  params.acceptedTurns.get(actorKey) !== acceptedSet ||
                  !acceptedSet?.has(acceptedTurn) ||
                  !acceptedTurn.isCurrentActor() ||
                  (acceptedTurn.activeTurn &&
                    params.activeTurnBySession.get(actorKey) !== acceptedTurn.activeTurn)
                ) {
                  throw new AcpRuntimeError(
                    "ACP_TURN_FAILED",
                    "ACP task is no longer the accepted run.",
                  );
                }
                requireExpectedTurn(acceptedTurn);
              } catch (error) {
                if (control && phase === "publication") {
                  retireCapturedHandle();
                }
                throw error;
              }
            },
            assertCancellationAllowed: () => {
              params.assertActive?.();
              admitted = true;
            },
          });
        }),
      );
    } finally {
      control?.release();
    }
    return;
  }
  requireExpectedTurn(undefined);

  await params.withSessionActor(params, async (isCurrentActor) => {
    const control = await params.prepareSessionControlRead(target);
    let runtimeLocator: AcpSessionRuntimeLocator | undefined;
    const assertTargetCurrent = () => {
      control.assertCurrent(params.cfg);
      control.assertNativeAcpCurrent?.(params.cfg, runtimeLocator);
      if (!isCurrentActor()) {
        throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP session actor was replaced.");
      }
      requireExpectedTurn(params.activeTurnBySession.get(actorKey));
    };
    const assertAdmission = () => {
      assertTargetCurrent();
      params.assertActive?.();
    };
    try {
      assertAdmission();
      if (expectedOwnerKey) {
        await requireExpectedOwner(control);
        assertAdmission();
      }
      const resolution = await params.resolveSession({ ...target, assertCurrent: assertAdmission });
      assertAdmission();
      const resolvedMeta = requireReadySessionMeta(resolution);
      const { entry, constraint } = await requireExpectedOwner(control);
      assertAdmission();
      const ownerKey = resolveAcpSessionControlOwner(entry);
      const { runtime, handle } = await params.ensureRuntimeHandle({
        ...target,
        assertActive: assertAdmission,
        meta: resolvedMeta,
        isCurrentActor,
        readAcpControl: () => constraint,
        assertMetadataCommitAllowed: (locator) => {
          control.assertNativeAcpCurrent?.(params.cfg, locator);
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
        const current = await requireExpectedOwner(control);
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
  revalidate?: AcceptedTurnState["revalidateCancel"];
  assertCurrent?: () => void;
}): Promise<void> {
  if (!params.activeTurn.cancelPromise) {
    let runtimeCancelStarted = false;
    // The stream abort and its caller join the same read admission and runtime effect.
    const cancellation = withAcpRuntimeErrorBoundary({
      run: async () => {
        // Yield even without a read so reentrant cancellation sees the installed promise.
        await params.revalidate?.();
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
      // A refused read can retry; an attempted RPC must retain its possibly applied outcome.
      if (!runtimeCancelStarted && params.activeTurn.cancelPromise === cancellation) {
        params.activeTurn.cancelPromise = undefined;
      }
    });
  }
  await params.activeTurn.cancelPromise;
}

/** Cancellation retains setup custody until a late handle and its turn settle. */
export async function cancelManagerAcceptedTurn(params: {
  acceptedTurn: AcceptedTurnState;
  reason?: string;
  revalidate?: AcceptedTurnState["revalidateCancel"];
  assertCurrent?: AcceptedTurnState["assertCancelCurrent"];
  assertCancellationAllowed?: () => void;
}): Promise<void> {
  const pending = params.revalidate?.();
  const constraint = pending ? await pending : undefined;
  params.assertCurrent?.();
  // Caller authority admits the abort once; target checks retain cleanup custody.
  params.assertCancellationAllowed?.();
  const turn = params.acceptedTurn;
  turn.cancelReason ??= params.reason;
  turn.revalidateCancel ??= params.revalidate;
  turn.assertCancelCurrent ??= params.assertCurrent;
  if (constraint) {
    const runtimeLocator =
      turn.runtimeHandle ?? turn.cancelConstraint?.runtimeLocator ?? constraint.runtimeLocator;
    turn.cancelConstraint = runtimeLocator
      ? {
          ...constraint,
          runtimeLocator: {
            backend: runtimeLocator.backend,
            runtimeSessionName: runtimeLocator.runtimeSessionName,
          },
        }
      : constraint;
  }
  turn.abortController.abort();
  if (turn.activeTurn) {
    const activeTurn = turn.activeTurn;
    await settleManagerCancellations([
      cancelManagerActiveTurn({
        activeTurn,
        reason: turn.cancelReason,
        revalidate: turn.revalidateCancel,
        assertCurrent: () => {
          turn.assertCancelCurrent?.();
          if (turn.activeTurn !== activeTurn) {
            throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP runtime handle was replaced.");
          }
        },
      }),
      turn.settled,
    ]);
  } else {
    await turn.settled;
  }
}
