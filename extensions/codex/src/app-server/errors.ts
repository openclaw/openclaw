/**
 * Typed error classes for the Codex app-server harness.
 *
 * These replace ad-hoc Error.message prose matching (which is fragile under
 * rewording) with `instanceof` checks so the type system can verify that
 * control-flow branching remains correct.
 */

/** Thrown when the running Codex version is below the minimum required. */
export class CodexAppServerVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAppServerVersionError";
  }
}

/** Thrown when the Codex app-server startup timed out. */
export class CodexAppServerStartupTimeoutError extends Error {
  constructor() {
    super("codex app-server startup timed out");
    this.name = "CodexAppServerStartupTimeoutError";
  }
}

/** Thrown when the Codex app-server startup was aborted. */
export class CodexAppServerStartupAbortedError extends Error {
  constructor() {
    super("codex app-server startup aborted");
    this.name = "CodexAppServerStartupAbortedError";
  }
}
