import { recordModelFallbackStop } from "../model-fallback-stop.js";

export const MODEL_REQUEST_POLICY_DENIED_TEXT =
  "The deployment rejected this model request. Ask the administrator to check the model access policy and request settings.";

/** A native transport confirmed a deployment gate refusal, rather than a provider login failure. */
export class AgentHarnessModelRequestPolicyError extends Error {
  // The code is diagnostic; only this host-created Error owns the terminal decision.
  readonly code = "model_request_policy_denied";
  readonly status = 403;

  constructor() {
    super(MODEL_REQUEST_POLICY_DENIED_TEXT);
    this.name = "AgentHarnessModelRequestPolicyError";
    recordModelFallbackStop(this);
  }
}

export class MissingAgentHarnessError extends Error {
  constructor(harnessId: string) {
    super(`Requested agent harness "${harnessId}" is not registered.`);
    this.name = "MissingAgentHarnessError";
  }
}

export function isMissingAgentHarnessError(err: unknown): err is MissingAgentHarnessError {
  return err instanceof MissingAgentHarnessError;
}

/** A harness lost ownership of the session generation before the attempt could start. */
export class AgentHarnessSessionSupersededError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentHarnessSessionSupersededError";
  }
}

/** Required native cleanup failed; the host must preserve the current session generation. */
export class AgentHarnessSessionCleanupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentHarnessSessionCleanupError";
  }
}

/** A model-independent harness preflight failed before an attempt could start. */
export class AgentHarnessPreflightError extends Error {
  /** Stable machine-readable reason when the owner provides one. */
  readonly code?: string;
  /** Opts fallback into skipping only candidates owned by the selected harness. */
  readonly scope?: "harness";
  /** Owner-authored public explanation; message and cause remain diagnostic. */
  readonly userMessage?: string;
  /** Optional public detail for desktop chat viewers, never channel replies. */
  readonly desktopMessage?: string;

  constructor(
    message: string,
    options?: ErrorOptions & { scope?: "harness"; userMessage?: string; desktopMessage?: string },
  ) {
    super(message, options);
    this.name = "AgentHarnessPreflightError";
    this.scope = options?.scope;
    this.userMessage = options?.userMessage;
    this.desktopMessage = options?.desktopMessage;
  }
}

/** A native session registration attempted to bypass the host's turn admission. */
export class SessionControllerAdmissionRequiredError extends AgentHarnessPreflightError {
  override readonly code = "SESSION_CONTROLLER_ADMISSION_REQUIRED";

  constructor() {
    const message =
      "Session-keyed native runs require a host-admitted harness turn. Register this run from the host-provided runAttempt callback; use detached execution only for sessionless work.";
    super(message, { userMessage: message });
    this.name = "SessionControllerAdmissionRequiredError";
  }
}

// The host records the selected harness where the attempt runs. Plugins can opt
// into harness-local fallback, but cannot suppress candidates by naming an owner.
const agentHarnessPreflightOwners = new WeakMap<AgentHarnessPreflightError, string>();

export function recordAgentHarnessPreflightOwner(error: unknown, harnessId: string): void {
  if (isAgentHarnessPreflightError(error) && error.scope === "harness") {
    agentHarnessPreflightOwners.set(error, harnessId);
  }
}

export function resolveAgentHarnessPreflightOwner(error: unknown): string | undefined {
  return isAgentHarnessPreflightError(error) ? agentHarnessPreflightOwners.get(error) : undefined;
}

/** Returns whether fallback would only repeat the same harness preflight failure. */
export function isAgentHarnessPreflightError(err: unknown): err is AgentHarnessPreflightError {
  return err instanceof AgentHarnessPreflightError;
}
