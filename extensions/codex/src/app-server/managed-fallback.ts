/** Managed start candidates: the selected command followed by its fallbacks. */
import { readErrorName } from "openclaw/plugin-sdk/error-runtime";
import type { CodexAppServerStartOptions } from "./config-contracts.js";

/** Only a current caller can replace the installed binary after a startup failure. */
export function canFallbackFromInstalledCodex(
  error: unknown,
  signal: AbortSignal,
  assertCurrent?: () => void,
): boolean {
  // The spawn path can wrap caller cancellation with stderr.
  if (
    signal.aborted ||
    readErrorName(error) === "AbortError" ||
    (error instanceof Error && readErrorName(error.cause) === "AbortError")
  ) {
    return false;
  }
  try {
    assertCurrent?.();
    return true;
  } catch {
    return false;
  }
}

export function isCodexComputerUseCandidateArtifactsUnavailableError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "CODEX_COMPUTER_USE_CANDIDATE_ARTIFACTS_UNAVAILABLE"
  );
}

export function resolveManagedFallbackStartOptions(
  startOptions: CodexAppServerStartOptions,
): CodexAppServerStartOptions[] {
  const commands = [startOptions.command, ...(startOptions.managedFallbackCommandPaths ?? [])];
  const candidates: CodexAppServerStartOptions[] = [];
  for (const [index, command] of commands.entries()) {
    const managedFallbackCommandPaths = commands.slice(index + 1);
    const candidate = {
      ...startOptions,
      command,
    };
    if (managedFallbackCommandPaths.length === 0) {
      delete candidate.managedFallbackCommandPaths;
    } else {
      candidate.managedFallbackCommandPaths = managedFallbackCommandPaths;
    }
    candidates.push(candidate);
  }
  return candidates;
}
