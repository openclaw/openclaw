/**
 * Typed error classes for the Codex app-server harness.
 *
 * These replace ad-hoc Error.message prose matching (which is fragile under
 * rewording) with `instanceof` checks so the type system can verify that
 * control-flow branching remains correct.
 *
 * `this.name` is intentionally NOT overridden so that `error.toString()`
 * stays compatible with existing message-based assertions and logging.
 */

/** Thrown when the running Codex version is below the minimum required. */
export class CodexAppServerVersionError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** Thrown when the Codex app-server startup timed out. */
export class CodexAppServerStartupTimeoutError extends Error {
  constructor() {
    super("codex app-server startup timed out");
  }
}

/** Thrown when the Codex app-server startup was aborted. */
export class CodexAppServerStartupAbortedError extends Error {
  constructor() {
    super("codex app-server startup aborted");
  }
}
