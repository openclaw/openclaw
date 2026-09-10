/**
 * Automatic Daybreak escalation for OpenAI cyber-policy refusals.
 *
 * OpenAI refuses some defensive-cyber work on its general models and directs
 * approved workspaces to a Daybreak model instead. When a turn is refused, this
 * owner retries it exactly once on the configured Daybreak model so the refused
 * work reaches the tier that is allowed to answer it.
 *
 * Daybreak trails the general models in capability, so escalation stays scoped
 * to work that was actually refused: one retry per turn, a bounded session-local
 * window, and no change to the session's stored model selection.
 *
 * Authorization stays server-owned. `model/list` advertises Daybreak to every
 * client, but an unentitled workspace still gets 401/403 on use, so entitlement
 * is only ever observed from an actual attempt — never assumed from the catalog.
 */

import { readCodexPluginConfig } from "./config-parsing.js";

export type CodexCyberFailoverConfig = {
  mode: "auto" | "off";
  model: string;
  cooloffMs: number;
};

// Codex catalog id for Daybreak Blue, verified against a live `model/list`.
const DEFAULT_CYBER_FAILOVER: CodexCyberFailoverConfig = {
  mode: "auto",
  model: "gpt-daybreak-blue-latest",
  cooloffMs: 600_000,
};

/** Reads `plugins.entries.codex.config.appServer.cyberFailover`, applying defaults. */
export function resolveCodexCyberFailoverConfig(pluginConfig: unknown): CodexCyberFailoverConfig {
  const configured = readCodexPluginConfig(pluginConfig).appServer?.cyberFailover;
  if (!configured) {
    return DEFAULT_CYBER_FAILOVER;
  }
  return {
    mode: configured.mode ?? DEFAULT_CYBER_FAILOVER.mode,
    model: configured.model ?? DEFAULT_CYBER_FAILOVER.model,
    cooloffMs: configured.cooloffMs ?? DEFAULT_CYBER_FAILOVER.cooloffMs,
  };
}

/**
 * What an escalation attempt tells later turns.
 * `unavailable` means the workspace cannot use the target at all, which is an
 * account-level fact. `suppressed` records that this session just made an
 * attempt, so it does not immediately make another.
 */
export type CodexCyberEscalationOutcome = "unavailable" | "suppressed";

// Session-scoped attempt history, deliberately in memory: the window is minutes
// long, so it must not outlive the process or enter the session store. Entries
// expire on read, so writes also sweep to keep the map bounded. Values are the
// expiry of that session's suppression.
const escalationWindows = new Map<string, number>();
const MAX_ESCALATION_WINDOWS = 256;

// Authorization is a property of the authenticated workspace and the target
// model, not of any one session, so an unauthorized target is remembered once
// for every session under that workspace. One process can host several
// agent-scoped Codex homes, so the key carries the workspace identity too: a
// workspace without entitlement must not disable escalation for one that has it.
// Bounded by configured targets times workspaces, and never evicted by session
// churn — which is what makes the expensive 401/403 reconnect ladder genuinely
// unrepeatable inside its cooloff.
const unavailableTargets = new Map<string, number>();
const MAX_UNAVAILABLE_TARGETS = 256;
// One probe per workspace and target at a time. Without this, sibling sessions
// refused at the same moment would each pay the 401/403 reconnect ladder before
// the first result records the target as unavailable.
const inFlightProbes = new Set<string>();

/** Identifies the authenticated workspace an authorization result belongs to. */
export type CodexCyberWorkspace = {
  agentId?: string | undefined;
  authProfileId?: string | undefined;
};

function normalizeModelKey(model: string): string {
  const trimmed = model.trim().toLowerCase();
  const slashIndex = trimmed.lastIndexOf("/");
  return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
}

function targetKey(model: string, workspace: CodexCyberWorkspace | undefined): string {
  return [
    workspace?.agentId?.trim().toLowerCase() ?? "",
    workspace?.authProfileId?.trim().toLowerCase() ?? "",
    normalizeModelKey(model),
  ].join("\u0000");
}

function isTargetUnavailable(
  model: string,
  workspace: CodexCyberWorkspace | undefined,
  now: number,
): boolean {
  const key = targetKey(model, workspace);
  const expiresAt = unavailableTargets.get(key);
  if (expiresAt === undefined) {
    return false;
  }
  if (expiresAt <= now) {
    unavailableTargets.delete(key);
    return false;
  }
  return true;
}

function isSessionSuppressed(sessionKey: string | undefined, now: number): boolean {
  if (!sessionKey) {
    return false;
  }
  const expiresAt = escalationWindows.get(sessionKey);
  if (expiresAt === undefined) {
    return false;
  }
  if (expiresAt <= now) {
    escalationWindows.delete(sessionKey);
    return false;
  }
  return true;
}

/** Marks a workspace/target probe in flight; the returned handle releases it. */
export function reserveCodexCyberProbe(params: {
  model: string;
  workspace?: CodexCyberWorkspace;
}): () => void {
  const key = targetKey(params.model, params.workspace);
  inFlightProbes.add(key);
  return () => {
    inFlightProbes.delete(key);
  };
}

/** Clears a session's damper so a proven-good target stays reachable. */
export function clearCodexCyberSessionSuppression(sessionKey: string | undefined): void {
  if (sessionKey) {
    escalationWindows.delete(sessionKey);
  }
}

export function recordCodexCyberEscalation(params: {
  sessionKey: string | undefined;
  outcome: CodexCyberEscalationOutcome;
  model: string;
  workspace?: CodexCyberWorkspace;
  cooloffMs: number;
  now?: number;
}): void {
  if (params.cooloffMs <= 0) {
    return;
  }
  const now = params.now ?? Date.now();
  if (params.outcome === "unavailable") {
    // Expired keys are otherwise only dropped when that exact workspace and
    // target is queried again, so short-lived agent or profile ids would linger.
    for (const [key, expiresAt] of unavailableTargets) {
      if (expiresAt <= now) {
        unavailableTargets.delete(key);
      }
    }
    while (unavailableTargets.size >= MAX_UNAVAILABLE_TARGETS) {
      const oldest = unavailableTargets.keys().next();
      if (oldest.done) {
        break;
      }
      unavailableTargets.delete(oldest.value);
    }
    unavailableTargets.set(targetKey(params.model, params.workspace), now + params.cooloffMs);
    return;
  }
  if (!params.sessionKey) {
    return;
  }
  if (escalationWindows.size >= MAX_ESCALATION_WINDOWS) {
    for (const [sessionKey, expiresAt] of escalationWindows) {
      if (expiresAt <= now) {
        escalationWindows.delete(sessionKey);
      }
    }
    // These records only damp repeat attempts for one session; the account-level
    // authorization fact lives in unavailableTargets and is never evicted. So a
    // full map can shed its soonest-to-expire entry to stay hard-bounded.
    while (escalationWindows.size >= MAX_ESCALATION_WINDOWS) {
      let soonestKey: string | undefined;
      let soonestExpiry = Number.POSITIVE_INFINITY;
      for (const [sessionKey, expiresAt] of escalationWindows) {
        if (expiresAt < soonestExpiry) {
          soonestExpiry = expiresAt;
          soonestKey = sessionKey;
        }
      }
      if (soonestKey === undefined) {
        break;
      }
      escalationWindows.delete(soonestKey);
    }
  }
  escalationWindows.set(params.sessionKey, now + params.cooloffMs);
}

// Host refs may be provider-qualified (`openai/gpt-...`); compare the model id.
function sameModel(left: string | undefined, right: string): boolean {
  const trimmed = left?.trim();
  return trimmed ? normalizeModelKey(trimmed) === normalizeModelKey(right) : false;
}

export type CodexCyberEscalationPlan =
  | { kind: "escalate"; model: string }
  | {
      kind: "skip";
      reason:
        | "disabled"
        | "already_daybreak"
        | "cooling_off"
        | "no_target"
        | "not_replay_safe"
        | "target_unavailable";
    };

/** Decides whether a refused turn may be retried on Daybreak. */
export function planCodexCyberEscalation(params: {
  config: CodexCyberFailoverConfig;
  sessionKey: string | undefined;
  currentModel: string | undefined;
  replaySafe: boolean;
  workspace?: CodexCyberWorkspace;
  now?: number;
}): CodexCyberEscalationPlan {
  const { config } = params;
  if (config.mode !== "auto") {
    return { kind: "skip", reason: "disabled" };
  }
  // Retrying a turn that already acted would repeat those actions.
  if (!params.replaySafe) {
    return { kind: "skip", reason: "not_replay_safe" };
  }
  if (!config.model.trim()) {
    return { kind: "skip", reason: "no_target" };
  }
  if (sameModel(params.currentModel, config.model)) {
    return { kind: "skip", reason: "already_daybreak" };
  }
  const now = params.now ?? Date.now();
  // An unauthorized target is an account-level fact: no session may retry it and
  // pay the transport's full reconnect ladder again. A probe already in flight
  // for this workspace counts the same way until it reports back.
  if (
    isTargetUnavailable(config.model, params.workspace, now) ||
    inFlightProbes.has(targetKey(config.model, params.workspace))
  ) {
    return { kind: "skip", reason: "target_unavailable" };
  }
  // One attempt per session per cooloff: a refused turn is retried once, and a
  // burst of them does not each pay for their own retry.
  if (isSessionSuppressed(params.sessionKey, now)) {
    return { kind: "skip", reason: "cooling_off" };
  }
  return { kind: "escalate", model: config.model };
}

/**
 * Structural view of the attempt outcome this owner reads. The runner's
 * `EmbeddedRunAttemptResult` satisfies it, so callers pass the real result and
 * the compiler still checks these accesses.
 */
type CyberRefusalMessage = {
  role?: string;
  diagnostics?: readonly { type: string; details?: Record<string, unknown> }[];
  errorMessage?: string;
  stopReason?: string;
};

export type CodexCyberAttemptOutcome = {
  lastAssistant?: CyberRefusalMessage | undefined;
  currentAttemptAssistant?: CyberRefusalMessage | undefined;
  promptError?: unknown;
  replayMetadata?: { replaySafe?: boolean } | undefined;
};

/**
 * True when the refused attempt committed nothing that a retry would repeat.
 * The projector reports this for every settled turn, so anything else — a sent
 * message, a cron add, a spawned session, generated media — must not be
 * replayed by an escalation. Absence is treated as unsafe.
 */
export function isCodexCyberEscalationReplaySafe(
  result: CodexCyberAttemptOutcome | undefined,
): boolean {
  return result?.replayMetadata?.replaySafe === true;
}

function hasRefusalDiagnostic(
  message: CyberRefusalMessage | undefined,
  category?: string,
): boolean {
  if (message?.role !== "assistant") {
    return false;
  }
  return (
    message.diagnostics?.some(
      (diagnostic) =>
        diagnostic.type === "provider_refusal" &&
        (category === undefined || diagnostic.details?.category === category),
    ) === true
  );
}

/**
 * True when this attempt ended in OpenAI's cyber refusal specifically. Bio and
 * misalignment refusals carry their own categories and are never escalated.
 */
export function isCodexCyberRefusalResult(result: CodexCyberAttemptOutcome | undefined): boolean {
  // `lastAssistant` may carry an older turn's row, so it only speaks for this
  // attempt when the attempt produced no row of its own.
  return hasRefusalDiagnostic(result?.currentAttemptAssistant ?? result?.lastAssistant, "cyber");
}

/**
 * True when the escalated attempt actually produced a reply. Absence of an
 * authorization error is not evidence of one: a transport failure, cancellation,
 * or any other terminal error must not be mistaken for Daybreak answering.
 */
export function isCodexCyberEscalationAnswered(
  result: CodexCyberAttemptOutcome | undefined,
): boolean {
  if (result?.promptError !== undefined && result.promptError !== null) {
    return false;
  }
  const message = result?.currentAttemptAssistant ?? result?.lastAssistant;
  if (message?.role !== "assistant") {
    return false;
  }
  // Any refusal category counts as refused, not answered: bio and misalignment
  // keep their own handling and must never look like a successful escalation.
  if (hasRefusalDiagnostic(message)) {
    return false;
  }
  return message.stopReason !== "error" && message.stopReason !== "aborted";
}

const AUTHORIZATION_FAILURE_RE = /\b(401|403)\b|unauthorized|not authorized|forbidden/i;

/**
 * True when an escalated attempt failed because the workspace cannot use the
 * Daybreak target, rather than because Daybreak also refused the work.
 */
export function isCodexDaybreakUnavailableResult(
  result: CodexCyberAttemptOutcome | undefined,
): boolean {
  const promptError = result?.promptError;
  const candidates = [
    typeof promptError === "string" ? promptError : undefined,
    promptError instanceof Error ? promptError.message : undefined,
    result?.lastAssistant?.errorMessage,
    result?.currentAttemptAssistant?.errorMessage,
  ];
  return candidates.some((text) => text !== undefined && AUTHORIZATION_FAILURE_RE.test(text));
}
