import { PluginInstanceUnavailableError } from "../plugins/plugin-instance-error.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

/** Reports unavailable owner facts, distinguishing admission refusal from a missing owner. */
export class PreparedModelRuntimeOwnerNotPublishedError extends Error {
  readonly admissionBlocked: boolean;

  constructor(message?: string, options?: ErrorOptions & { admissionBlocked?: boolean }) {
    super(message, options);
    this.admissionBlocked = options?.admissionBlocked === true;
  }
}

/** Only missing owners permit activation or catalog fallback; refused admission must settle work. */
export function isPreparedModelRuntimeMissingOwnerError(
  error: unknown,
): error is PreparedModelRuntimeOwnerNotPublishedError {
  return error instanceof PreparedModelRuntimeOwnerNotPublishedError && !error.admissionBlocked;
}

export class PreparedModelRuntimePublicationSupersededError extends PreparedModelRuntimeOwnerNotPublishedError {}

export class PreparedModelRuntimePluginGenerationRetiredError extends Error {}

export function isPreparedModelRuntimePluginLifecycleFailure(error: unknown): boolean {
  return (
    error instanceof PluginInstanceUnavailableError ||
    error instanceof PreparedModelRuntimePluginGenerationRetiredError ||
    error instanceof PreparedModelRuntimePublicationSupersededError
  );
}

export function assertPreparedModelRuntimeInputCurrent(
  input: PreparedModelRuntimeInput,
  isCurrent: (() => boolean) | undefined,
): void {
  if (isCurrent && !isCurrent()) {
    throw new PreparedModelRuntimePublicationSupersededError(
      `prepared model runtime publication was superseded for ${input.agentDir}`,
    );
  }
}

export function assertPreparedModelRuntimeCandidatesCurrent(
  candidates: readonly {
    input: PreparedModelRuntimeInput;
    isBuildCurrent?: () => boolean;
  }[],
): void {
  for (const candidate of candidates) {
    assertPreparedModelRuntimeInputCurrent(candidate.input, candidate.isBuildCurrent);
  }
}
