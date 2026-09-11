/**
 * Automatic Daybreak escalation for OpenAI cyber-policy refusals.
 *
 * OpenAI refuses some defensive-cyber work on its general models and directs
 * approved workspaces to a Daybreak model instead. When a turn is refused, the
 * harness retries it once on the configured Daybreak model so the refused work
 * reaches the tier allowed to answer it. Only a refused turn is ever routed
 * there, and the retry never changes the session's stored model selection.
 *
 * Authorization stays server-owned. `model/list` advertises Daybreak to every
 * client, but an unentitled workspace still gets 401/403 on use, and each such
 * attempt costs the transport's full five-try reconnect ladder. Entitlement is
 * therefore only ever observed from an actual attempt, and a failure is
 * remembered per workspace so siblings do not each pay for it.
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

/** Identifies the authenticated workspace an authorization result belongs to. */
export type CodexCyberWorkspace = {
  agentId?: string | undefined;
  authProfileId?: string | undefined;
};

// Unauthorized targets, keyed by workspace and model and holding an expiry.
// Authorization belongs to the workspace rather than any one conversation, and
// one process can host several agent-scoped Codex homes, so an unentitled
// workspace must not disable escalation for one that is entitled. Writes sweep
// expired keys, so live entries are bounded by the workspaces that actually
// failed inside one window; the cap is an unreachable backstop.
const unavailableTargets = new Map<string, number>();
const MAX_UNAVAILABLE_TARGETS = 256;
// One probe per workspace and target at a time, so siblings refused at the same
// moment do not each pay the reconnect ladder before the first result lands.
const inFlightProbes = new Set<string>();

function targetKey(model: string, workspace: CodexCyberWorkspace | undefined): string {
  // Host refs may be provider-qualified (`openai/gpt-...`); key on the model id.
  const normalized = model.trim().toLowerCase();
  const slashIndex = normalized.lastIndexOf("/");
  return [
    workspace?.agentId?.trim().toLowerCase() ?? "",
    workspace?.authProfileId?.trim().toLowerCase() ?? "",
    slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized,
  ].join("\u0000");
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

/** Remembers that this workspace cannot use the target for `cooloffMs`. */
export function recordCodexCyberTargetUnavailable(params: {
  model: string;
  workspace?: CodexCyberWorkspace;
  cooloffMs: number;
  now?: number;
}): void {
  if (params.cooloffMs <= 0) {
    return;
  }
  const now = params.now ?? Date.now();
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
}

export type CodexCyberEscalationPlan =
  | { kind: "escalate"; model: string }
  | {
      kind: "skip";
      reason:
        | "disabled"
        | "already_daybreak"
        | "no_target"
        | "not_replay_safe"
        | "target_unavailable"
        | "probe_in_flight";
    };

/** Decides whether a refused turn may be retried on Daybreak. */
export function planCodexCyberEscalation(params: {
  config: CodexCyberFailoverConfig;
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
  const key = targetKey(config.model, params.workspace);
  if (params.currentModel && targetKey(params.currentModel, params.workspace) === key) {
    return { kind: "skip", reason: "already_daybreak" };
  }
  const now = params.now ?? Date.now();
  const expiresAt = unavailableTargets.get(key);
  if (expiresAt !== undefined && expiresAt <= now) {
    unavailableTargets.delete(key);
  } else if (expiresAt !== undefined) {
    return { kind: "skip", reason: "target_unavailable" };
  }
  if (inFlightProbes.has(key)) {
    return { kind: "skip", reason: "probe_in_flight" };
  }
  return { kind: "escalate", model: config.model };
}

/**
 * Structural view of the attempt outcome this owner reads. The runner's
 * `EmbeddedRunAttemptResult` satisfies it, so callers pass the real result and
 * the compiler still checks these accesses.
 */
type AttemptMessage = {
  role?: string;
  diagnostics?: readonly { type: string; details?: Record<string, unknown> }[];
  errorMessage?: string;
  stopReason?: string;
};

export type CodexCyberAttemptOutcome = {
  lastAssistant?: AttemptMessage | undefined;
  currentAttemptAssistant?: AttemptMessage | undefined;
  promptError?: unknown;
  replayMetadata?: { replaySafe?: boolean } | undefined;
};

export type CodexCyberAttemptVerdict = {
  /** OpenAI refused this attempt under its cyber policy. */
  cyberRefused: boolean;
  /** Nothing was committed that a retry would repeat. */
  replaySafe: boolean;
  /** The attempt produced an actual reply. */
  answered: boolean;
  /** The workspace cannot use the model this attempt ran on. */
  unavailable: boolean;
};

const AUTHORIZATION_FAILURE_RE = /\b(401|403)\b|unauthorized|not authorized|forbidden/i;

/** Everything the escalation decision needs from one attempt outcome. */
export function readCodexCyberAttemptVerdict(
  result: CodexCyberAttemptOutcome | undefined,
): CodexCyberAttemptVerdict {
  // `lastAssistant` may carry an older turn's row, so only this attempt's own
  // row speaks for it. A refusal always populates that row, so requiring it
  // costs nothing and stops an earlier refusal from rerouting a later turn.
  const message = result?.currentAttemptAssistant;
  const refusals = message?.role === "assistant" ? (message.diagnostics ?? []) : [];
  const cyberRefused = refusals.some(
    (d) =>
      d.type === "provider_refusal" &&
      d.details?.category === "cyber" &&
      d.details?.provider === "openai",
  );
  const promptError = result?.promptError;
  const failed = promptError !== undefined && promptError !== null;
  // Any refusal category is a refusal, not an answer, so bio and misalignment
  // never look like a successful escalation either.
  const answered =
    !failed &&
    message?.role === "assistant" &&
    !refusals.some((d) => d.type === "provider_refusal") &&
    message.stopReason !== "error" &&
    message.stopReason !== "aborted";
  const errorTexts = [
    typeof promptError === "string" ? promptError : undefined,
    promptError instanceof Error ? promptError.message : undefined,
    result?.lastAssistant?.errorMessage,
    message?.errorMessage,
  ];
  return {
    cyberRefused,
    // Absence of an explicit safe verdict counts as unsafe.
    replaySafe: result?.replayMetadata?.replaySafe === true,
    answered,
    unavailable: errorTexts.some((t) => t !== undefined && AUTHORIZATION_FAILURE_RE.test(t)),
  };
}
