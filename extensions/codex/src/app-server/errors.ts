/** Typed control-flow errors thrown by the Codex app-server harness. */

export class CodexAppServerVersionError extends Error {
  readonly detectedVersion?: string;

  constructor(minimumVersion: string, detectedVersion: string | undefined) {
    const detected = detectedVersion
      ? `detected ${detectedVersion}`
      : "OpenClaw could not determine the running Codex version";
    super(
      `Codex app-server ${minimumVersion} or newer is required, but ${detected}. Update the configured Codex app-server binary, or remove custom command overrides to use the managed binary.`,
    );
    this.name = "CodexAppServerVersionError";
    this.detectedVersion = detectedVersion;
  }
}

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
