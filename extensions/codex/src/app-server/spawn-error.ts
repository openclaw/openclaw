import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";

// Keep failed launch facts across plugin module replacement and config reload.
const failures = resolveGlobalSingleton<{
  commands: Map<string, CodexAppServerSpawnError>;
  errors: WeakMap<Error, CodexAppServerSpawnError>;
  reported: Set<string>;
}>(Symbol.for("openclaw.codexSpawnFailures"), () => ({
  commands: new Map(),
  errors: new WeakMap(),
  reported: new Set(),
}));

/** Also accepts the command runner's sanitized launch code (without syscall/errno). */
function codexSpawnFailureReason(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const failure: NodeJS.ErrnoException = error;
  if (failure.syscall === undefined || failure.syscall.startsWith("spawn")) {
    if (
      failure.code === "EBADARCH" ||
      failure.errno === -86 ||
      failure.code === "Unknown system error -86"
    ) {
      return "is not runnable on this CPU";
    }
    if (failure.code === "ENOENT") {
      return "or its working directory was not found";
    }
    if (failure.code === "EACCES") {
      return "is not executable or its working directory is inaccessible";
    }
  }
  return undefined;
}

export class CodexAppServerSpawnError extends Error {
  constructor(
    readonly command: string,
    reason: string,
    cause: unknown,
  ) {
    super(
      `Codex catalog updater cannot run: ${command} ${reason}. Repair the executable or working directory and restart the Gateway.`,
      { cause },
    );
    this.name = "CodexAppServerSpawnError";
    failures.errors.set(this, this);
  }
}

export function findCodexAppServerSpawnError(error: unknown): CodexAppServerSpawnError | undefined {
  let current = error;
  const seen = new Set<Error>();
  while (current instanceof Error && !seen.has(current)) {
    const failure = failures.errors.get(current);
    if (failure) {
      return failure;
    }
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}

export function describeCodexSpawnError(error: unknown, command: string): unknown {
  const reason = codexSpawnFailureReason(error);
  return reason ? new CodexAppServerSpawnError(command, reason, error) : error;
}

export function getCodexAppServerSpawnFailure(
  command: string,
): CodexAppServerSpawnError | undefined {
  return failures.commands.get(command);
}

export function recordCodexAppServerSpawnFailure(
  error: unknown,
  command: string,
  launchKey: string,
): unknown {
  const described = describeCodexSpawnError(error, command);
  const failure = findCodexAppServerSpawnError(described);
  if (failure) {
    failures.commands.set(launchKey, failure);
  }
  return described;
}

export function reportCodexCatalogSpawnFailure(failure: CodexAppServerSpawnError): void {
  if (!failures.reported.has(failure.command)) {
    failures.reported.add(failure.command);
    embeddedAgentLog.warn(failure.message);
  }
}
