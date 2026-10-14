import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { toErrorObject } from "../../infra/errors.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { isAcpSessionKey } from "../../sessions/session-key-utils.js";
import { ACP_ERROR_CODES, AcpRuntimeError } from "../runtime/errors.js";
import { buildAcpDatabaseSessionKey } from "../runtime/session-meta-keys.js";
import {
  resolveSessionStorePathForAcp,
  type AcpSessionStoreEntry,
} from "../runtime/session-meta-store.js";
import type { AcpSessionResolution, AcpSessionTarget } from "./manager.types.js";

export function resolveAcpAgentFromSessionKey(sessionKey: string, fallback = "main"): string {
  const parsed = parseAgentSessionKey(sessionKey);
  return normalizeAgentId(parsed?.agentId ?? fallback);
}

function resolveMissingMetaError(sessionKey: string): AcpRuntimeError {
  return new AcpRuntimeError(
    "ACP_SESSION_INIT_FAILED",
    `ACP metadata is missing for ${sessionKey}. Recreate this ACP session with /acp spawn and rebind the thread.`,
  );
}

/** Project the selected store result without reopening storage. */
export function resolveStoredAcpSession(
  target: AcpSessionTarget,
  stored: AcpSessionStoreEntry | null,
): AcpSessionResolution {
  if (stored?.acp) {
    return { kind: "ready", ...target, meta: stored.acp, entry: stored.entry };
  }
  return isAcpSessionKey(target.sessionKey)
    ? { kind: "stale", ...target, error: resolveMissingMetaError(target.sessionKey) }
    : { kind: "none", ...target };
}

export function resolveAcpSessionResolutionError(
  resolution: AcpSessionResolution,
): AcpRuntimeError | null {
  if (resolution.kind === "ready") {
    return null;
  }
  if (resolution.kind === "stale") {
    return resolution.error;
  }
  return new AcpRuntimeError(
    "ACP_SESSION_INIT_FAILED",
    `Session is not ACP-enabled: ${resolution.sessionKey}`,
  );
}

export function requireReadySessionMeta(resolution: AcpSessionResolution): SessionAcpMeta {
  if (resolution.kind === "ready") {
    return resolution.meta;
  }
  throw toErrorObject(resolveAcpSessionResolutionError(resolution), "Non-Error thrown");
}

/** Resolve ownership before main aliases can erase the encoded agent namespace. */
export function resolveAcpSessionTarget(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}): AcpSessionTarget {
  const normalized = normalizeLowercaseStringOrEmpty(params.sessionKey);
  if (!normalized) {
    throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
  }
  const { agentId, storeSessionKey: sessionKey } = resolveSessionStorePathForAcp({
    ...params,
    sessionKey: normalized,
  });
  return { agentId, sessionKey };
}

/** Components normalize before encoding; base64url itself is case-sensitive. */
export function acpSessionActorKey(target: AcpSessionTarget): string {
  return buildAcpDatabaseSessionKey(
    normalizeLowercaseStringOrEmpty(target.sessionKey),
    target.agentId,
  );
}

export function normalizeAcpErrorCode(code: string | undefined): AcpRuntimeError["code"] {
  if (!code) {
    return "ACP_TURN_FAILED";
  }
  const normalized = code.trim().toUpperCase();
  return ACP_ERROR_CODES.find((allowed) => allowed === normalized) ?? "ACP_TURN_FAILED";
}

export function createUnsupportedControlError(params: {
  backend: string;
  control: string;
}): AcpRuntimeError {
  return new AcpRuntimeError(
    "ACP_BACKEND_UNSUPPORTED_CONTROL",
    `ACP backend "${params.backend}" does not support ${params.control}.`,
  );
}

export function hasLegacyAcpIdentityProjection(meta: SessionAcpMeta): boolean {
  const raw = meta as Record<string, unknown>;
  return (
    Object.hasOwn(raw, "backendSessionId") ||
    Object.hasOwn(raw, "agentSessionId") ||
    Object.hasOwn(raw, "sessionIdsProvisional")
  );
}

const SESSION_ACTOR_SUPERSEDED_DETAIL_CODE = "SESSION_ACTOR_SUPERSEDED";

export function createSupersededActorError(sessionKey: string): AcpRuntimeError {
  return new AcpRuntimeError(
    "ACP_SESSION_INIT_FAILED",
    `ACP session actor was superseded during runtime initialization for ${sessionKey}.`,
    { detailCode: SESSION_ACTOR_SUPERSEDED_DETAIL_CODE },
  );
}

export function isSupersededActorError(error: unknown): boolean {
  return (
    error instanceof AcpRuntimeError && error.detailCode === SESSION_ACTOR_SUPERSEDED_DETAIL_CODE
  );
}

export function assertCurrentAcpActor(current: boolean, sessionKey: string): void {
  if (!current) {
    throw createSupersededActorError(sessionKey);
  }
}
