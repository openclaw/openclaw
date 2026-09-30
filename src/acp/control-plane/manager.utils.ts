import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { toErrorObject } from "../../infra/errors.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { isAcpSessionKey } from "../../sessions/session-key-utils.js";
/** Shared ACP manager normalization, resolution, and error helpers. */
import { ACP_ERROR_CODES, AcpRuntimeError } from "../runtime/errors.js";
import { buildAcpDatabaseSessionKey } from "../runtime/session-meta-keys.js";
import { isClosedAcpSessionMeta } from "../runtime/session-meta-readonly.js";
import {
  resolveSessionStorePathForAcp,
  type AcpSessionStoreEntry,
} from "../runtime/session-meta-store.js";
import type { AcpSessionResolution, AcpSessionTarget } from "./manager.types.js";

/** Resolves the agent id encoded in an ACP session key. */
export function resolveAcpAgentFromSessionKey(sessionKey: string, fallback = "main"): string {
  const parsed = parseAgentSessionKey(sessionKey);
  return normalizeAgentId(parsed?.agentId ?? fallback);
}

/** Builds the stale-session error shown when ACP metadata is missing. */
function resolveMissingMetaError(sessionKey: string): AcpRuntimeError {
  return new AcpRuntimeError(
    "ACP_SESSION_INIT_FAILED",
    `ACP metadata is missing for ${sessionKey}. Recreate this ACP session with /acp spawn and rebind the thread.`,
  );
}

/** Structured detail code for turns and controls that reach a closed ACP session. */
const ACP_SESSION_CLOSED_DETAIL_CODE = "ACP_SESSION_CLOSED";

/** Builds the terminal-session error shown when ACP metadata is closed. */
function resolveClosedSessionError(sessionKey: string, closedAt?: number): AcpRuntimeError {
  const closedText = closedAt === undefined ? "" : ` at ${new Date(closedAt).toISOString()}`;
  return new AcpRuntimeError(
    "ACP_SESSION_INIT_FAILED",
    `ACP session ${sessionKey} was closed${closedText}. Start a new ACP session with /acp spawn and rebind the thread.`,
    { detailCode: ACP_SESSION_CLOSED_DETAIL_CODE },
  );
}

/** Project the selected store result without reopening storage. */
export function resolveStoredAcpSession(
  target: AcpSessionTarget,
  stored: AcpSessionStoreEntry | null,
): AcpSessionResolution {
  const acp = stored?.acp;
  if (acp && isClosedAcpSessionMeta(acp)) {
    // A closed row keeps provenance but can never accept a turn or control again.
    return {
      kind: "stale",
      ...target,
      error: resolveClosedSessionError(target.sessionKey, acp.closedAt),
      closedMeta: acp,
    };
  }
  if (acp) {
    return { kind: "ready", ...target, meta: acp, entry: stored.entry };
  }
  return isAcpSessionKey(target.sessionKey)
    ? { kind: "stale", ...target, error: resolveMissingMetaError(target.sessionKey) }
    : { kind: "none", ...target };
}

/** Converts a session resolution union into the runtime error callers should throw. */
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

/** Returns ready ACP metadata or throws the matching resolution error. */
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

/** Restricts runtime-provided error codes to the ACP error-code enum. */
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
