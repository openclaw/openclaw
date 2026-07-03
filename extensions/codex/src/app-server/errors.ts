/** Typed control-flow errors thrown by the Codex app-server harness. */

export class CodexAppServerVersionError extends Error {}

export class CodexAppServerStartupTimeoutError extends Error {
  constructor() {
    super("codex app-server startup timed out");
  }
}

export class CodexAppServerStartupAbortedError extends Error {
  constructor() {
    super("codex app-server startup aborted");
  }
}
