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
 * How an escalation attempt should shape later routing.
 * `answered` means Daybreak produced a reply, so related follow-up work in that
 * session goes straight there. `unavailable` means the workspace cannot use the
 * target at all. `suppressed` covers a target that refused the work anyway, or
 * any other failed attempt: not worth retrying, and no reason to send ordinary
 * turns to the weaker model.
 */
export type CodexCyberEscalationOutcome = "answered" | "unavailable" | "suppressed";

type CyberEscalationRecord = {
  outcome: Exclude<CodexCyberEscalationOutcome, "unavailable">;
  expiresAt: number;
};

// Session-scoped routing state, deliberately in memory: the window is minutes
// long, so it must not outlive the process or enter the session store. Entries
// expire on read, so writes also sweep to keep the map bounded.
const escalationWindows = new Map<string, CyberEscalationRecord>();
const MAX_ESCALATION_WINDOWS = 256;

// Authorization is a property of the workspace and the target model, not of any
// one session, so an unauthorized target is remembered once for all of them.
// Keyed by target model, this is bounded by the number of configured targets and
// can never be evicted by session churn — which is what makes the expensive
// 401/403 reconnect ladder genuinely unrepeatable inside its cooloff.
const unavailableTargets = new Map<string, number>();

function normalizeModelKey(model: string): string {
  const trimmed = model.trim().toLowerCase();
  const slashIndex = trimmed.lastIndexOf("/");
  return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
}

function isTargetUnavailable(model: string, now: number): boolean {
  const key = normalizeModelKey(model);
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

function readWindow(
  sessionKey: string | undefined,
  now: number,
): CyberEscalationRecord | undefined {
  if (!sessionKey) {
    return undefined;
  }
  const record = escalationWindows.get(sessionKey);
  if (!record) {
    return undefined;
  }
  if (record.expiresAt <= now) {
    escalationWindows.delete(sessionKey);
    return undefined;
  }
  return record;
}

export function recordCodexCyberEscalation(params: {
  sessionKey: string | undefined;
  outcome: CodexCyberEscalationOutcome;
  model: string;
  cooloffMs: number;
  now?: number;
}): void {
  if (params.cooloffMs <= 0) {
    return;
  }
  const now = params.now ?? Date.now();
  if (params.outcome === "unavailable") {
    unavailableTargets.set(normalizeModelKey(params.model), now + params.cooloffMs);
    return;
  }
  if (!params.sessionKey) {
    return;
  }
  if (escalationWindows.size >= MAX_ESCALATION_WINDOWS) {
    for (const [sessionKey, record] of escalationWindows) {
      if (record.expiresAt <= now) {
        escalationWindows.delete(sessionKey);
      }
    }
    // These records only tune routing for one session; the account-level
    // authorization fact lives in unavailableTargets and is never evicted. So a
    // full map can shed its soonest-to-expire entry to stay hard-bounded.
    while (escalationWindows.size >= MAX_ESCALATION_WINDOWS) {
      let soonestKey: string | undefined;
      let soonestExpiry = Number.POSITIVE_INFINITY;
      for (const [sessionKey, record] of escalationWindows) {
        if (record.expiresAt < soonestExpiry) {
          soonestExpiry = record.expiresAt;
          soonestKey = sessionKey;
        }
      }
      if (soonestKey === undefined) {
        break;
      }
      escalationWindows.delete(soonestKey);
    }
  }
  escalationWindows.set(params.sessionKey, {
    outcome: params.outcome,
    expiresAt: now + params.cooloffMs,
  });
}

// Host refs may be provider-qualified (`openai/gpt-...`); compare the model id.
function sameModel(left: string | undefined, right: string): boolean {
  const trimmed = left?.trim();
  return trimmed ? normalizeModelKey(trimmed) === normalizeModelKey(right) : false;
}

/**
 * Model a turn should start on before it has been refused. Only a window whose
 * escalation actually produced a reply pre-routes; a suppressed window must not
 * send ordinary work to a model that cannot or will not answer it.
 */
export function resolveCodexCyberStickyModel(params: {
  config: CodexCyberFailoverConfig;
  sessionKey: string | undefined;
  currentModel: string | undefined;
  now?: number;
}): string | undefined {
  if (params.config.mode !== "auto") {
    return undefined;
  }
  const now = params.now ?? Date.now();
  const record = readWindow(params.sessionKey, now);
  if (record?.outcome !== "answered" || isTargetUnavailable(params.config.model, now)) {
    return undefined;
  }
  return sameModel(params.currentModel, params.config.model) ? undefined : params.config.model;
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
  // pay the transport's full reconnect ladder again.
  if (isTargetUnavailable(config.model, now)) {
    return { kind: "skip", reason: "target_unavailable" };
  }
  // Either session outcome blocks a fresh attempt: an answered one has already
  // pre-routed this turn, and a suppressed one is not worth repeating.
  if (readWindow(params.sessionKey, now)) {
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

function hasCyberRefusalDiagnostic(message: CyberRefusalMessage | undefined): boolean {
  if (message?.role !== "assistant") {
    return false;
  }
  return (
    message.diagnostics?.some(
      (diagnostic) =>
        diagnostic.type === "provider_refusal" && diagnostic.details?.category === "cyber",
    ) === true
  );
}

/**
 * True when this attempt ended in OpenAI's cyber refusal. Bio and misalignment
 * refusals carry their own categories and are never escalated.
 */
export function isCodexCyberRefusalResult(result: CodexCyberAttemptOutcome | undefined): boolean {
  // `lastAssistant` may carry an older turn's row, so it only speaks for this
  // attempt when the attempt produced no row of its own.
  return hasCyberRefusalDiagnostic(result?.currentAttemptAssistant ?? result?.lastAssistant);
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
