/** One-run rollback for agent-selected session models. */
import {
  appendTranscriptMessage,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  acquireSessionActorStorage,
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
  runWithSessionActorStorage,
} from "../config/sessions/session-actor-storage-binding.js";
import { readSessionEntryInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  createAgentPatchedSessionModelFallback,
  type AgentPatchedSessionModelFallback,
} from "../config/sessions/session-model-fallback.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { rethrowIncognitoSessionError } from "../state/incognito-session-error.js";
import { resolveFailoverReasonFromError } from "./failover-error.js";
import type { FailoverReason } from "./failover/signal.js";
import { resolveSessionModelRef } from "./session-model-ref.js";

// Revert only when the chosen model is definitively unusable. Transient
// provider states (rate_limit/overloaded/timeout/server_error) hit working
// models too; reverting on them would undo a valid choice.
const REVERT_REASONS = new Set<FailoverReason>([
  "auth",
  "auth_permanent",
  "billing",
  "model_not_found",
]);

type SessionModelRunOutcome =
  | { success: true }
  | { success: false; error?: unknown; reason?: FailoverReason };

async function reconcileAgentPatchedSessionModel(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  storePath?: string;
  outcome: SessionModelRunOutcome;
  expectedMarkerTs?: number;
  validatedFallback?: AgentPatchedSessionModelFallback;
  expectedSession?: { sessionId: string; lifecycleRevision?: string };
}): Promise<void> {
  const reason = params.outcome.success
    ? undefined
    : (params.outcome.reason ?? resolveFailoverReasonFromError(params.outcome.error));
  if (!params.outcome.success && (!reason || !REVERT_REASONS.has(reason))) {
    return;
  }

  let note: string | undefined;
  let sessionId: string | undefined;
  const reconciledEntry = await patchSessionEntryCore(
    {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    (entry) => {
      if (
        params.expectedSession &&
        (entry.sessionId !== params.expectedSession.sessionId ||
          entry.lifecycleRevision !== params.expectedSession.lifecycleRevision)
      ) {
        return null;
      }
      const marker = entry.modelFallback;
      if (marker?.source !== "agent-patch") {
        return null;
      }
      if (params.expectedMarkerTs !== undefined && marker.ts !== params.expectedMarkerTs) {
        if (
          params.outcome.success &&
          params.validatedFallback &&
          marker.ts > params.expectedMarkerTs &&
          params.expectedMarkerTs > (marker.lastValidatedPatchTs ?? -1)
        ) {
          return {
            modelFallback: {
              ...params.validatedFallback,
              ts: marker.ts,
              lastValidatedPatchTs: params.expectedMarkerTs,
            },
          };
        }
        return null;
      }
      sessionId = entry.sessionId;
      if (params.outcome.success) {
        return { modelFallback: undefined };
      }
      const failed = resolveSessionModelRef(params.cfg, entry, params.agentId);
      note = `System note: model ${failed.provider}/${failed.model} failed; reverted to ${marker.prevProvider}/${marker.prevModel}.`;
      return {
        model: marker.prevModel,
        modelProvider: marker.prevProvider,
        modelOverride: marker.prevModelOverride,
        providerOverride: marker.prevProviderOverride,
        modelOverrideSource: marker.prevModelOverrideSource,
        modelOverrideRouteResolution: marker.prevModelOverrideRouteResolution,
        modelOverrideFallbackOriginProvider: marker.prevModelOverrideFallbackOriginProvider,
        modelOverrideFallbackOriginModel: marker.prevModelOverrideFallbackOriginModel,
        authProfileOverride: marker.prevAuthProfileOverride,
        authProfileOverrideSource: marker.prevAuthProfileOverrideSource,
        authProfileOverrideCompactionCount: marker.prevAuthProfileOverrideCompactionCount,
        contextWindow: marker.prevContextWindow,
        thinkingLevel: marker.prevThinkingLevel,
        modelFallback: undefined,
        liveModelSwitchPending: undefined,
      };
    },
  );
  if (note && sessionId) {
    try {
      const timestamp = Date.now();
      await appendTranscriptMessage(
        {
          agentId: params.agentId,
          sessionId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
          expectedLifecycleRevision: reconciledEntry?.lifecycleRevision,
          expectedWriterRunId: reconciledEntry?.activeWriterRunId,
        },
        {
          config: params.cfg,
          message: {
            role: "custom" as const,
            customType: "openclaw.system-note",
            content: note,
            display: true,
            timestamp,
          },
        },
      );
    } catch {
      // Rollback is authoritative; transcript note is best effort.
    }
  }
}

export async function createAgentPatchedSessionModelRunGuard(params: {
  cfg: OpenClawConfig;
  agentId: string | undefined;
  sessionKey: string | undefined;
  storePath: string | undefined;
  assertReadCurrent?: () => void;
  onError?: (error: unknown) => void;
}) {
  const source = params.sessionKey
    ? captureSessionActorStorageOwner(params, {
        assertCurrent() {
          params.assertReadCurrent?.();
        },
        authorize() {},
      })
    : undefined;
  const target = {
    agentId: source?.agentId ?? params.agentId,
    sessionKey: params.sessionKey,
    storePath: source?.path ?? params.storePath,
  };
  let markerTs: number | undefined;
  let expectedSession: { sessionId: string; lifecycleRevision?: string } | undefined;
  let validatedFallback: AgentPatchedSessionModelFallback | undefined;
  if (params.sessionKey) {
    params.assertReadCurrent?.();
    try {
      const entry = source
        ? readCapturedSessionActorEntry(source, params.sessionKey)
        : await readSessionEntryInWorker({
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            storePath: params.storePath,
          });
      params.assertReadCurrent?.();
      const marker = entry?.modelFallback;
      markerTs = marker?.source === "agent-patch" ? marker.ts : undefined;
      if (entry && markerTs !== undefined) {
        expectedSession = {
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
        };
        const current = resolveSessionModelRef(params.cfg, entry, params.agentId);
        validatedFallback = createAgentPatchedSessionModelFallback({
          model: current.model,
          provider: current.provider,
          entry,
          ts: markerTs,
        });
      }
    } catch (error) {
      rethrowIncognitoSessionError(error);
      params.assertReadCurrent?.();
      markerTs = undefined;
    }
  }
  let failure: { error?: unknown; reason?: FailoverReason } = {};
  let reconciled = false;
  const captureFailure = (error: unknown, reason?: string) => {
    // Only the patch captured when this guard was created can be reconciled.
    if (markerTs === undefined) {
      return false;
    }
    const classifiedReason = reason
      ? (reason as FailoverReason)
      : resolveFailoverReasonFromError(error);
    const revertReason =
      classifiedReason && REVERT_REASONS.has(classifiedReason) ? classifiedReason : undefined;
    failure = { error, ...(revertReason ? { reason: revertReason } : {}) };
    return revertReason !== undefined;
  };
  const captureFallbackFailure = (
    attempts: readonly { error: string; reason?: string }[],
  ): boolean | undefined => {
    const attempt = attempts[0];
    return attempt ? captureFailure(new Error(attempt.error), attempt.reason) : undefined;
  };
  const reconcile = async (success: boolean) => {
    if (reconciled || !target.sessionKey || markerTs === undefined) {
      return;
    }
    reconciled = true;
    try {
      const sessionKey = target.sessionKey;
      const reconcileModel = () =>
        reconcileAgentPatchedSessionModel({
          cfg: params.cfg,
          agentId: target.agentId,
          sessionKey,
          storePath: target.storePath,
          expectedMarkerTs: markerTs,
          expectedSession,
          ...(validatedFallback ? { validatedFallback } : {}),
          outcome: success ? { success: true } : { success: false, ...failure },
        });
      if (source) {
        const lifetime = { assertCurrent() {}, assertReadable() {} };
        const actor = source.owner
          ? await source.owner.acquireExisting(sessionKey, lifetime)
          : source.binding
            ? (
                await acquireSessionActorStorage(
                  { ...target, sessionActor: source.binding },
                  {
                    lifetime,
                    authority: source.authority,
                  },
                )
              )?.actor
            : undefined;
        if (!actor) {
          return;
        }
        try {
          await runWithSessionActorStorage({ ...source, actor }, reconcileModel);
        } finally {
          await actor.release();
        }
      } else {
        await reconcileModel();
      }
    } catch (error) {
      params.onError?.(error);
    }
  };
  return {
    captureFailure,
    captureFallbackFailure,
    async fail(error: unknown, reason?: string) {
      captureFailure(error, reason);
      await reconcile(false);
    },
    finish: reconcile,
  };
}
