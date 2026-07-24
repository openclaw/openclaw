/** Startup scan that resolves pending ACP session identities when backends can report status. */
import {
  identityHasStableSessionId,
  isSessionIdentityPending,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { toAcpRuntimeError } from "../runtime/errors.js";
import type {
  AcpSessionManagerDeps,
  AcpStartupIdentityReconcileResult,
  EnsureManagerRuntimeHandle,
  ReconcileManagerRuntimeSessionIdentifiers,
  ResolveManagerSession,
  WithManagerSessionActor,
} from "./manager.types.js";

const ACP_RECONCILE_LOG_FIELD_MAX_LENGTH = 500;
const acpManagerLog = createSubsystemLogger("acp/manager");

function sanitizeAcpReconcileLogValue(value: string): string {
  const normalized = sanitizeForLog(value);
  const sanitized = sanitizeForLog(redactSensitiveText(normalized)).replace(/\s+/g, " ").trim();
  if (!sanitized) {
    return "<empty>";
  }
  if (sanitized.length <= ACP_RECONCILE_LOG_FIELD_MAX_LENGTH) {
    return sanitized;
  }
  return `${sanitized.slice(0, ACP_RECONCILE_LOG_FIELD_MAX_LENGTH - 3)}...`;
}

function logStartupIdentityReconcileFailure(sessionKey: string, error: unknown) {
  const acpError = toAcpRuntimeError({
    error,
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "ACP startup identity reconcile failed.",
  });
  const safeSessionKey = sanitizeAcpReconcileLogValue(sessionKey);
  const safeMessage = sanitizeAcpReconcileLogValue(acpError.message);
  acpManagerLog.warn(
    `acp-manager: startup identity reconcile failed for ${safeSessionKey}: code=${acpError.code} message=${safeMessage}`,
  );
}

/** Resolves pending ACP session identities opportunistically during manager startup. */
export async function runManagerStartupIdentityReconcile(params: {
  cfg: OpenClawConfig;
  deps: Pick<AcpSessionManagerDeps, "listAcpSessions">;
  withSessionActor: WithManagerSessionActor;
  resolveSession: ResolveManagerSession;
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
      const becameResolved = await params.withSessionActor(session.sessionKey, async () => {
        const resolution = params.resolveSession({
          cfg: params.cfg,
          sessionKey: session.sessionKey,
        });
        if (resolution.kind !== "ready") {
          return false;
        }
        const { runtime, handle, meta } = await params.ensureRuntimeHandle({
          cfg: params.cfg,
          sessionKey: session.sessionKey,
          meta: resolution.meta,
        });
        const reconciled = await params.reconcileRuntimeSessionIdentifiers({
          cfg: params.cfg,
          sessionKey: session.sessionKey,
          runtime,
          handle,
          meta,
          failOnStatusError: false,
        });
        return !isSessionIdentityPending(resolveSessionIdentityFromMeta(reconciled.meta));
      });
      if (becameResolved) {
        resolved += 1;
      }
    } catch (error) {
      failed += 1;
      logStartupIdentityReconcileFailure(session.sessionKey, error);
      logVerbose(
        `acp-manager: startup identity reconcile failed for ${session.sessionKey}: ${String(error)}`,
      );
    }
  }

  return { checked, resolved, failed };
}
