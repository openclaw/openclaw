/**
 * CLI session persistence helpers.
 * Keeps provider-keyed session bindings, reuse fingerprints, and legacy
 * Claude CLI state in one normalized session-store contract.
 */
import crypto from "node:crypto";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  CliSessionAuthIdentitySnapshot,
  CliSessionBinding,
  SessionEntry,
} from "../config/sessions.js";
import { normalizeCliSessionReseedReceipt } from "../config/sessions/cli-session-binding.js";
import { readErrorName } from "../infra/errors.js";
import { isFailoverError } from "./failover-error.js";
import type { FailoverReason } from "./failover/signal.js";
export {
  clearAllCliSessions,
  getCliSessionBinding,
  getCliSessionId,
} from "../config/sessions/cli-session-binding.js";

const CLAUDE_CLI_BACKEND_ID = "claude-cli";

/** Whether a failover proves the provider-side conversation can no longer be resumed. */
export function isCliSessionInvalidatingFailoverReason(reason: FailoverReason): boolean {
  // Auth identity changes are handled by the reuse fingerprint's auth epoch.
  // Other execution failures say nothing about the persisted transcript.
  return reason === "session_expired";
}

/** Hash CLI session-sensitive text so reuse checks can compare stable fingerprints. */
export function hashCliSessionText(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  return crypto.createHash("sha256").update(trimmed).digest("hex");
}

/**
 * Store a reusable CLI session ID without extra reuse guards.
 *
 * `authIdentity` is the identity the run that produced `sessionId` executed
 * under. Passing it is what keeps this fallback from writing an auth-less
 * binding: a binding with no recorded identity has no auth boundary for
 * `clearCliSession` to preserve, which is how a later clear used to erase the
 * record outright and let the next turn raw-reseed prior-auth history.
 */
export function setCliSessionId(
  entry: SessionEntry,
  provider: string,
  sessionId: string,
  authIdentity?: CliSessionAuthIdentitySnapshot,
): void {
  setCliSessionBinding(entry, provider, { sessionId, ...authIdentity });
}

/** Store a CLI session binding and mirror it to legacy/simple session-id fields. */
export function setCliSessionBinding(
  entry: SessionEntry,
  provider: string,
  binding: CliSessionBinding,
): void {
  const normalized = normalizeProviderId(provider);
  const trimmed = normalizeOptionalString(binding.sessionId);
  if (!trimmed) {
    return;
  }
  const previousBinding = entry.cliSessionBindings?.[normalized];
  const previousReceipt =
    normalizeOptionalString(previousBinding?.sessionId) === trimmed
      ? normalizeCliSessionReseedReceipt(previousBinding?.reseedReceipt)
      : undefined;
  const reseedReceipt = normalizeCliSessionReseedReceipt(binding.reseedReceipt) ?? previousReceipt;
  entry.cliSessionBindings = {
    ...entry.cliSessionBindings,
    [normalized]: {
      sessionId: trimmed,
      ...(normalizeOptionalString(binding.resumeCheckpointId)
        ? { resumeCheckpointId: normalizeOptionalString(binding.resumeCheckpointId) }
        : {}),
      ...(binding.forceReuse === true ? { forceReuse: true } : {}),
      ...(binding.forkNextResume === true ? { forkNextResume: true } : {}),
      ...(normalizeOptionalString(binding.authProfileId)
        ? { authProfileId: normalizeOptionalString(binding.authProfileId) }
        : {}),
      ...(normalizeOptionalString(binding.authEpoch)
        ? { authEpoch: normalizeOptionalString(binding.authEpoch) }
        : {}),
      ...(typeof binding.authEpochVersion === "number" && Number.isFinite(binding.authEpochVersion)
        ? { authEpochVersion: binding.authEpochVersion }
        : {}),
      ...(normalizeOptionalString(binding.extraSystemPromptHash)
        ? { extraSystemPromptHash: normalizeOptionalString(binding.extraSystemPromptHash) }
        : {}),
      ...(normalizeOptionalString(binding.messageToolPolicyHash)
        ? { messageToolPolicyHash: normalizeOptionalString(binding.messageToolPolicyHash) }
        : {}),
      ...(normalizeOptionalString(binding.promptToolNamesHash)
        ? { promptToolNamesHash: normalizeOptionalString(binding.promptToolNamesHash) }
        : {}),
      ...(normalizeOptionalString(binding.cwdHash)
        ? { cwdHash: normalizeOptionalString(binding.cwdHash) }
        : {}),
      ...(normalizeOptionalString(binding.mcpConfigHash)
        ? { mcpConfigHash: normalizeOptionalString(binding.mcpConfigHash) }
        : {}),
      ...(normalizeOptionalString(binding.mcpResumeHash)
        ? { mcpResumeHash: normalizeOptionalString(binding.mcpResumeHash) }
        : {}),
      ...(reseedReceipt ? { reseedReceipt } : {}),
    },
  };
  entry.cliSessionIds = { ...entry.cliSessionIds, [normalized]: trimmed };
  if (normalized === CLAUDE_CLI_BACKEND_ID) {
    entry.claudeCliSessionId = trimmed;
  }
}

/**
 * Reduces a cleared binding to the auth identity its transcript was written under.
 *
 * A finite `authEpochVersion` counts as auth identity on its own. An install
 * with neither an auth profile nor a resolvable credential epoch has an empty
 * identity, and a versioned record of that emptiness is still a tombstone: it
 * is what lets the next turn tell "the identity is still empty" from "an
 * identity appeared". This mirrors the reader in `cli-session-binding.ts`, which
 * accepts a version-only record, and the sibling `toCurrentCliSessionAuthBoundary`,
 * which writes one — the shape this PR itself persists on a `current`-provenance
 * clear.
 *
 * Returns undefined only when the binding carried no profile, no epoch, and no
 * finite version, which means the clear can erase the record outright.
 */
function toClearedCliSessionAuthBoundary(
  binding: CliSessionBinding | undefined,
): CliSessionBinding | undefined {
  const authProfileId = normalizeOptionalString(binding?.authProfileId);
  const authEpoch = normalizeOptionalString(binding?.authEpoch);
  const authEpochVersion =
    typeof binding?.authEpochVersion === "number" && Number.isFinite(binding.authEpochVersion)
      ? binding.authEpochVersion
      : undefined;
  if (!authProfileId && !authEpoch && authEpochVersion === undefined) {
    return undefined;
  }
  return {
    ...(authProfileId ? { authProfileId } : {}),
    ...(authEpoch ? { authEpoch } : {}),
    ...(authEpochVersion !== undefined ? { authEpochVersion } : {}),
  };
}

/**
 * Reduces the clearing turn's own auth identity to a tombstone.
 *
 * Used only when the outgoing binding recorded no identity of its own. Note
 * that an all-empty identity still yields a tombstone carrying `authEpochVersion`:
 * "this transcript belongs to an install with no auth identity" is a fact worth
 * recording, and it is what makes a later-appearing profile or epoch read as a
 * crossing rather than as a session that was never bound.
 */
function toCurrentCliSessionAuthBoundary(
  identity: CliSessionAuthIdentitySnapshot,
): CliSessionBinding | undefined {
  const authProfileId = normalizeOptionalString(identity.authProfileId);
  const authEpoch = normalizeOptionalString(identity.authEpoch);
  const boundary: CliSessionBinding = {
    ...(authProfileId ? { authProfileId } : {}),
    ...(authEpoch ? { authEpoch } : {}),
    ...(typeof identity.authEpochVersion === "number" && Number.isFinite(identity.authEpochVersion)
      ? { authEpochVersion: identity.authEpochVersion }
      : {}),
  };
  return Object.keys(boundary).length > 0 ? boundary : undefined;
}

/**
 * Reduces an unattributable clear to a tombstone that refuses reseed outright.
 *
 * Used when the outgoing binding recorded no identity *and* the clearing path
 * ran outside a turn's resolved auth, so no identity can honestly be attributed
 * to the transcript. The marker is deliberately not identity-shaped: an
 * identity-shaped tombstone is compared against the next turn's identity and can
 * match it, and a transcript nobody can attribute must never match anything.
 * Reuse resolution maps this to `auth-unknown`, which every transcript-reseed
 * branch refuses.
 */
function toUnknownCliSessionAuthBoundary(): CliSessionBinding {
  return { clearedAuthProvenance: "unknown" };
}

/**
 * Auth provenance a clear can record when the outgoing binding recorded none.
 *
 * `current` carries the identity the clearing turn itself resolved, which is
 * the only identity anyone can honestly attribute to a binding that never
 * recorded one. `unknown` is for the clear paths that run before the turn
 * resolves its auth (a pre-run repair, or a handled `before_agent_reply`
 * synthetic turn that returns before CLI preparation) or after it failed without
 * ever getting that far.
 *
 * `unknown` fails closed: it records an explicit unknown-provenance tombstone
 * rather than erasing the record. Erasing it is what let the next turn read the
 * session as never-bound, take the `missing-transcript` reseed path, and hand a
 * later, different auth identity the prior identity's transcript. Refusing one
 * history reseed is the correct price for a transcript nobody can attribute.
 *
 * Deliberately not a bare optional, and the `unknown` tombstone is deliberately
 * not an empty/identity-shaped record: an empty tombstone written on every
 * auth-less clear would never match a run that does have an auth profile, so
 * reuse resolution would answer `auth-profile` forever and refuse the reseed
 * this whole path exists to allow (#124991). Callers must say which case they
 * are in, and the two cases persist distinguishable shapes.
 */
export type CliSessionClearAuthProvenance =
  | { kind: "current"; identity: CliSessionAuthIdentitySnapshot }
  | { kind: "unknown" };

/** Clear provenance for the paths that run outside a turn's resolved auth. */
export const CLI_SESSION_CLEAR_AUTH_UNKNOWN: CliSessionClearAuthProvenance = { kind: "unknown" };

/** Clear provenance from the identity the clearing turn resolved, when it has one. */
export function cliSessionClearAuthFromRun(
  identity: CliSessionAuthIdentitySnapshot | undefined,
): CliSessionClearAuthProvenance {
  return identity ? { kind: "current", identity } : CLI_SESSION_CLEAR_AUTH_UNKNOWN;
}

/**
 * Remove the stored CLI session binding for one provider.
 *
 * Sole owner of binding removal: settlement (`clearCliSessionBinding` meta, both
 * the command and auto-reply lanes), `clearCliSessionInStore`, and
 * `clearCliSessionBindingForRun` all land here, so the auth-boundary invariant
 * belongs here rather than at each caller. Erasing a binding outright would also
 * erase the only record that this session's transcript belongs to a different
 * auth identity, and the next turn would read the missing binding as "never
 * bound" and raw-reseed prior-auth history. The resumable handle is what a clear
 * must destroy, so it drops `sessionId` and the legacy mirrors while leaving an
 * auth-boundary tombstone: reuse resolution still refuses to resume it, but it
 * resolves as `auth-profile`/`auth-epoch` instead of `missing-transcript`.
 *
 * Two record shapes carry no identity of their own and so cannot source that
 * tombstone from the outgoing binding: the legacy `cliSessionIds` /
 * `claudeCliSessionId` rows that predate bindings, and a modern binding written
 * by the bare-id fallback. Both take the tombstone from `currentAuth` instead.
 * With `current` provenance that is the identity the clearing turn is running
 * under. Same identity next turn: reuse resolution reports no invalidation, the
 * turn reads as unbound, and raw reseed proceeds. Changed identity: it reports
 * the crossing and reseed is refused. That is the boundary this file promises,
 * extended to the records that never recorded one.
 *
 * With `unknown` provenance there is no identity to record, and the tombstone
 * says exactly that. Deleting the record instead is what let the next turn read
 * `{mode:"none"}`, default to `missing-transcript`, and reseed the prior
 * identity's transcript under whichever identity showed up next. The
 * unknown-provenance tombstone resolves as `auth-unknown`, which both reseed
 * branches refuse. It suppresses history for exactly one fresh prompt: the next
 * successful run writes a real binding with a session id and current auth, which
 * replaces it. Native resume is untouched — the tombstone never carried a
 * resumable handle to begin with.
 */
export function clearCliSession(
  entry: SessionEntry,
  provider: string,
  currentAuth: CliSessionClearAuthProvenance,
): void {
  const normalized = normalizeProviderId(provider);
  const hadBinding = entry.cliSessionBindings?.[normalized] !== undefined;
  const hadLegacyRow =
    normalizeOptionalString(entry.cliSessionIds?.[normalized]) !== undefined ||
    (normalized === CLAUDE_CLI_BACKEND_ID &&
      normalizeOptionalString(entry.claudeCliSessionId) !== undefined);
  const boundary =
    toClearedCliSessionAuthBoundary(entry.cliSessionBindings?.[normalized]) ??
    (currentAuth.kind === "current"
      ? toCurrentCliSessionAuthBoundary(currentAuth.identity)
      : toUnknownCliSessionAuthBoundary());
  // A legacy row with no binding record still leaves a tombstone: erasing it
  // is the same markerless delete, and it drops a session that reuse resolution
  // would otherwise have reported as auth-invalidated.
  if (hadBinding || (hadLegacyRow && boundary)) {
    const next = { ...entry.cliSessionBindings };
    if (boundary) {
      next[normalized] = boundary;
    } else {
      delete next[normalized];
    }
    entry.cliSessionBindings = Object.keys(next).length > 0 ? next : undefined;
  }
  if (entry.cliSessionIds?.[normalized] !== undefined) {
    const next = { ...entry.cliSessionIds };
    delete next[normalized];
    entry.cliSessionIds = Object.keys(next).length > 0 ? next : undefined;
  }
  if (normalized === CLAUDE_CLI_BACKEND_ID) {
    entry.claudeCliSessionId = undefined;
  }
}

/** Decide whether a failed CLI turn invalidates the binding it tried to resume. */
export function shouldClearFailedCliSessionBinding(params: {
  error: unknown;
  binding?: CliSessionBinding;
  hasNewGeneratedMediaTask?: boolean;
}): boolean {
  if (!normalizeOptionalString(params.binding?.sessionId)) {
    return false;
  }
  // Detached media delivers back into this run later and still needs the binding.
  if (params.hasNewGeneratedMediaTask === true) {
    return false;
  }
  if (isFailoverError(params.error)) {
    return isCliSessionInvalidatingFailoverReason(params.error.reason);
  }
  // A pre-successor fork abort keeps its one-shot marker for the next turn.
  return params.binding?.forkNextResume !== true && readErrorName(params.error) === "AbortError";
}

/** Stable reason used when recording why a failed reused CLI session was cleared. */
export function resolveCliSessionClearReason(error: unknown): string {
  return isFailoverError(error) ? error.reason : (readErrorName(error) ?? "error");
}

type CliSessionInvalidatedReason =
  | "auth-profile"
  | "auth-epoch"
  | "auth-unknown"
  | "message-policy"
  | "cwd"
  | "mcp";

type CliSessionContentDriftReason = "system-prompt" | "prompt-tools";

export type CliSessionReuseResult =
  | { mode: "none" }
  | { mode: "reuse"; sessionId: string }
  | {
      mode: "reuse-with-drift";
      sessionId: string;
      drift: { reasons: CliSessionContentDriftReason[] };
    }
  | { mode: "invalidate"; invalidatedReason: CliSessionInvalidatedReason };

type CliSessionAuthIdentity = {
  authProfileId?: string;
  authEpoch?: string;
  authEpochVersion: number;
};

/**
 * Auth-identity half of reuse resolution.
 *
 * Shared with the cleared-binding path so an auth-boundary tombstone is judged
 * by exactly the same rule as a live binding; a second copy of this comparison
 * is how the boundary drifts out of sync.
 */
function resolveCliSessionAuthInvalidation(
  binding: CliSessionBinding,
  params: CliSessionAuthIdentity,
): "auth-profile" | "auth-epoch" | undefined {
  const currentAuthProfileId = normalizeOptionalString(params.authProfileId);
  const currentAuthEpoch = normalizeOptionalString(params.authEpoch);
  const storedAuthProfileId = normalizeOptionalString(binding.authProfileId);
  const storedAuthEpoch = normalizeOptionalString(binding.authEpoch);
  const hasMatchingVersionedAuthEpoch =
    binding.authEpochVersion === params.authEpochVersion &&
    storedAuthEpoch !== undefined &&
    currentAuthEpoch !== undefined &&
    storedAuthEpoch === currentAuthEpoch;
  if (storedAuthProfileId !== currentAuthProfileId && !hasMatchingVersionedAuthEpoch) {
    return "auth-profile";
  }
  if (
    binding.authEpochVersion === params.authEpochVersion &&
    storedAuthEpoch !== currentAuthEpoch
  ) {
    return "auth-epoch";
  }
  return undefined;
}

/** Decide whether a stored CLI session can be reused for the current auth/prompt/cwd/MCP state. */
export function resolveCliSessionReuse(params: {
  binding?: CliSessionBinding;
  authProfileId?: string;
  authEpoch?: string;
  authEpochVersion: number;
  extraSystemPromptHash?: string;
  messageToolPolicyHash?: string;
  promptToolNamesHash?: string;
  cwdHash?: string;
  mcpConfigHash?: string;
  mcpResumeHash?: string;
}): CliSessionReuseResult {
  const binding = params.binding;
  const sessionId = normalizeOptionalString(binding?.sessionId);
  if (!sessionId) {
    // No resumable handle. A binding record still present here is the
    // auth-boundary tombstone `clearCliSession` leaves behind, and reporting its
    // auth mismatch is what keeps the next turn's raw-reseed reason on the auth
    // boundary instead of degrading to "never bound".
    if (binding?.clearedAuthProvenance === "unknown") {
      // Unknown provenance is checked before the identity comparison and answers
      // unconditionally: this tombstone carries no identity fields, so comparing
      // it would report "identity unchanged" against a turn that also resolves
      // none, and the transcript would reseed under an identity nobody can prove
      // wrote it.
      return { mode: "invalidate", invalidatedReason: "auth-unknown" };
    }
    const clearedAuthInvalidation = binding
      ? resolveCliSessionAuthInvalidation(binding, params)
      : undefined;
    return clearedAuthInvalidation
      ? { mode: "invalidate", invalidatedReason: clearedAuthInvalidation }
      : { mode: "none" };
  }
  if (binding?.forceReuse === true) {
    return { mode: "reuse", sessionId };
  }
  const currentExtraSystemPromptHash = normalizeOptionalString(params.extraSystemPromptHash);
  const currentMessageToolPolicyHash = normalizeOptionalString(params.messageToolPolicyHash);
  const currentPromptToolNamesHash = normalizeOptionalString(params.promptToolNamesHash);
  const currentCwdHash = normalizeOptionalString(params.cwdHash);
  const currentMcpConfigHash = normalizeOptionalString(params.mcpConfigHash);
  const currentMcpResumeHash = normalizeOptionalString(params.mcpResumeHash);
  const authInvalidation = binding ? resolveCliSessionAuthInvalidation(binding, params) : undefined;
  if (authInvalidation) {
    return { mode: "invalidate", invalidatedReason: authInvalidation };
  }
  const storedMessageToolPolicyHash = normalizeOptionalString(binding?.messageToolPolicyHash);
  if (storedMessageToolPolicyHash !== currentMessageToolPolicyHash) {
    return { mode: "invalidate", invalidatedReason: "message-policy" };
  }
  const storedCwdHash = normalizeOptionalString(binding?.cwdHash);
  if (storedCwdHash !== undefined && storedCwdHash !== currentCwdHash) {
    return { mode: "invalidate", invalidatedReason: "cwd" };
  }
  const storedMcpResumeHash = normalizeOptionalString(binding?.mcpResumeHash);
  if (storedMcpResumeHash && currentMcpResumeHash) {
    // Resume hashes are stricter than raw MCP config hashes: a match proves the
    // exact resumed CLI tool topology still belongs to this session.
    if (storedMcpResumeHash !== currentMcpResumeHash) {
      return { mode: "invalidate", invalidatedReason: "mcp" };
    }
  } else {
    const storedMcpConfigHash = normalizeOptionalString(binding?.mcpConfigHash);
    if (storedMcpConfigHash !== currentMcpConfigHash) {
      return { mode: "invalidate", invalidatedReason: "mcp" };
    }
  }

  const driftReasons: CliSessionContentDriftReason[] = [];
  const storedExtraSystemPromptHash = normalizeOptionalString(binding?.extraSystemPromptHash);
  if (storedExtraSystemPromptHash !== currentExtraSystemPromptHash) {
    driftReasons.push("system-prompt");
  }
  const storedPromptToolNamesHash = normalizeOptionalString(binding?.promptToolNamesHash);
  if (storedPromptToolNamesHash !== currentPromptToolNamesHash) {
    driftReasons.push("prompt-tools");
  }
  if (driftReasons.length > 0) {
    // Content drift resumes by contract (#99729): the transcript remains usable.
    // Deleting this binding here makes queued turns spawn without session history.
    return { mode: "reuse-with-drift", sessionId, drift: { reasons: driftReasons } };
  }
  return { mode: "reuse", sessionId };
}
