import {
  AgentHarnessPreflightError,
  formatErrorMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
export class CodexThreadStartRequestError extends Error {
  constructor(cause: unknown) {
    super(`thread/start: ${formatErrorMessage(cause)}`, { cause });
    this.name = "CodexThreadStartRequestError";
  }
}

export class CodexThreadClientReplacementError extends AgentHarnessPreflightError {
  constructor() {
    super(
      "Codex did not confirm unloading its previous configuration after a settled failure; a fresh client is required.",
    );
    this.name = "CodexThreadClientReplacementError";
  }
}

export class CodexThreadBindingConflictError extends Error {
  constructor(threadId: string, operation: string) {
    super(`Codex thread binding changed while ${operation}: ${threadId}`);
    this.name = "CodexThreadBindingConflictError";
  }
}

export class CodexAdoptedThreadActiveError extends AgentHarnessPreflightError {
  constructor(
    message = "Codex session became active in another runner; wait for it to finish before continuing",
  ) {
    super(message);
    this.name = "CodexAdoptedThreadActiveError";
  }
}

/** Closed branch labels only; never persist fingerprints, native error data or config. */
export type CodexRetainedThreadRefusalReason =
  | "missing binding"
  | "binding replacement"
  | "native skill isolation"
  | "ring-zero policy"
  | "runtime identity"
  | "model collaboration policy"
  | "host tool policy"
  | "transient tool policy"
  | "configured MCP ownership"
  | "native tool mode"
  | "unattested restricted binding"
  | "MCP config"
  | "web search config"
  | "delegation policy"
  | "context-engine binding"
  | "user MCP config"
  | "network proxy config"
  | "plugin app config"
  | "dynamic tool loading"
  | "dynamic tool catalog"
  | "transient dynamic tools"
  | "ephemeral binding unavailable"
  | "restricted resume configuration"
  | "native resume failed";

export class CodexRetainedThreadResumeRefusedError extends Error {
  readonly code = "CODEX_RETAINED_THREAD_RESUME_REFUSED";

  constructor(readonly reason: CodexRetainedThreadRefusalReason) {
    // Existing worker error projection preserves messages, not custom Error fields.
    super(
      "Retained Codex thread cannot be resumed under its current policy or native state; " +
        `no input was submitted and a fresh thread is refused (reason=${reason})`,
    );
    this.name = "CodexRetainedThreadResumeRefusedError";
  }
}
