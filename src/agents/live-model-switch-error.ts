/**
 * Live-session model switch control-flow error.
 * Carries the requested provider/model/auth-profile selection out of live
 * session setup code without treating the switch as a failure.
 */
type LiveSessionModelSelection = {
  provider: string;
  model: string;
  agentRuntimeOverride?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
};

/** Control-flow error used to request a live session model switch. */
export class LiveSessionModelSwitchError extends Error {
  provider: string;
  model: string;
  agentRuntimeOverride?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";

  constructor(selection: LiveSessionModelSelection) {
    super(`Live session model switch requested: ${selection.provider}/${selection.model}`);
    this.name = "LiveSessionModelSwitchError";
    this.provider = selection.provider;
    this.model = selection.model;
    this.agentRuntimeOverride = selection.agentRuntimeOverride;
    this.authProfileId = selection.authProfileId;
    this.authProfileIdSource = selection.authProfileIdSource;
  }
}

/**
 * Raised when a pending user-initiated `/model` switch cannot be committed
 * because the target provider/model could not be resolved into a candidate
 * chain (unknown provider, plugin/registry failure, secure-store read error).
 *
 * Carries the requested target so the reply is scoped to the model instead of a
 * generic "Something went wrong". Because it is raised before the pending flag
 * is cleared, `liveModelSwitchPending` survives and the switch is retried on the
 * next user turn.
 */
export class LiveModelSwitchUnresolvedError extends Error {
  provider: string;
  model: string;
  override cause?: unknown;

  constructor(target: { provider: string; model: string }, cause?: unknown) {
    super(
      `Could not switch to ${target.provider}/${target.model}` +
        (cause ? `: ${cause instanceof Error ? cause.message : String(cause)}` : ""),
    );
    this.name = "LiveModelSwitchUnresolvedError";
    this.provider = target.provider;
    this.model = target.model;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}
