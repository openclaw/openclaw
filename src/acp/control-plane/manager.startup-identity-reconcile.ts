import {
  identityHasStableSessionId,
  isSessionIdentityPending,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import type {
  AcpSessionManagerDeps,
  AcpStartupIdentityReconcileResult,
  EnsureManagerRuntimeHandle,
  ReconcileManagerRuntimeSessionIdentifiers,
  ResolveManagerSessionAsync,
  WithManagerSessionActor,
} from "./manager.types.js";
import { assertCurrentAcpActor, resolveAcpSessionTarget } from "./manager.utils.js";

export async function runManagerStartupIdentityReconcile(params: {
  cfg: OpenClawConfig;
  deps: Pick<AcpSessionManagerDeps, "listAcpSessions">;
  withSessionActor: WithManagerSessionActor;
  resolveSession: ResolveManagerSessionAsync;
  ensureRuntimeHandle: EnsureManagerRuntimeHandle;
  reconcileRuntimeSessionIdentifiers: ReconcileManagerRuntimeSessionIdentifiers;
}): Promise<AcpStartupIdentityReconcileResult> {
  let checked = 0;
  let resolved = 0;
  let failed = 0;

  let acpSessions: Awaited<ReturnType<AcpSessionManagerDeps["listAcpSessions"]>>;
  try {
    acpSessions = await params.deps.listAcpSessions({
      cfg: params.cfg,
    });
  } catch (error) {
    logVerbose(`acp-manager: startup identity scan failed: ${String(error)}`);
    return { checked, resolved, failed: failed + 1 };
  }

  for (const session of acpSessions) {
    if (!session.acp || !session.sessionKey) {
      continue;
    }
    if (session.acp.mode === "oneshot") {
      continue;
    }
    const currentIdentity = resolveSessionIdentityFromMeta(session.acp);
    if (
      !isSessionIdentityPending(currentIdentity) ||
      !identityHasStableSessionId(currentIdentity)
    ) {
      continue;
    }

    checked += 1;
    try {
      const target = resolveAcpSessionTarget({
        cfg: params.cfg,
        sessionKey: session.sessionKey,
        agentId: session.agentId,
      });
      const becameResolved = await params.withSessionActor(target, async (isCurrentActor) => {
        const assertCurrent = () => {
          assertCurrentAcpActor(isCurrentActor(), target.sessionKey);
        };
        const resolution = await params.resolveSession({
          cfg: params.cfg,
          ...target,
          assertCurrent,
        });
        assertCurrent();
        if (resolution.kind !== "ready") {
          return false;
        }
        const { runtime, handle, meta } = await params.ensureRuntimeHandle({
          cfg: params.cfg,
          ...target,
          meta: resolution.meta,
          isCurrentActor,
        });
        const reconciled = await params.reconcileRuntimeSessionIdentifiers({
          cfg: params.cfg,
          ...target,
          runtime,
          handle,
          meta,
          failOnStatusError: false,
          isCurrentActor,
        });
        return !isSessionIdentityPending(resolveSessionIdentityFromMeta(reconciled.meta));
      });
      if (becameResolved) {
        resolved += 1;
      }
    } catch (error) {
      failed += 1;
      logVerbose(
        `acp-manager: startup identity reconcile failed for ${session.sessionKey}: ${String(error)}`,
      );
    }
  }

  return { checked, resolved, failed };
}
