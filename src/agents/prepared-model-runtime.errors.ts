import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { PluginInstanceUnavailableError } from "../plugins/plugin-instance-error.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "./prepared-model-runtime-admission-errors.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

export { PreparedModelRuntimeOwnerNotPublishedError };

const refreshErrorSnapshots = new WeakMap<Error, Error>();

function refreshErrorText(error: Error, field: "name" | "message" | "stack", fallback: string) {
  try {
    return String(error[field]);
  } catch {
    return fallback;
  }
}

/** Keep recovery identity without retaining the rejected error's generation or cause graph. */
export function capturePreparedModelRuntimeRefreshError(value: unknown): Error {
  const error = toStringifiedError(value);
  const existing = refreshErrorSnapshots.get(error);
  if (existing) {
    return existing;
  }
  // Never copy a plugin-defined prototype or capture another lazy stack of this build.
  const kind = [
    PreparedModelRuntimeInitialRunAdmissionError,
    PreparedModelRuntimePublicationSupersededError,
    PreparedModelRuntimeOwnerNotPublishedError,
    PreparedModelRuntimePluginGenerationRetiredError,
    PluginInstanceUnavailableError,
  ].find((ErrorType) => error instanceof ErrorType);
  const snapshot = {
    name: refreshErrorText(error, "name", "Error"),
    message: refreshErrorText(error, "message", "Error message unavailable"),
    stack: refreshErrorText(error, "stack", "Stack trace unavailable: custom formatter failed"),
  };
  Object.setPrototypeOf(snapshot, kind?.prototype ?? Error.prototype);
  if (error instanceof PreparedModelRuntimeOwnerNotPublishedError) {
    const admissionBlocked: unknown = Reflect.get(error, "admissionBlocked");
    Object.assign(snapshot, { admissionBlocked: admissionBlocked === true });
  }
  try {
    const code: unknown = Reflect.get(error, "code");
    if (typeof code === "string" || typeof code === "number") {
      Object.assign(snapshot, { code });
    }
  } catch {
    // An opaque diagnostic property must not block publication settlement.
  }
  refreshErrorSnapshots.set(error, snapshot);
  refreshErrorSnapshots.set(snapshot, snapshot);
  return snapshot;
}

/** The embedded runner refused its initial admission before executing a generation. */
export class PreparedModelRuntimeInitialRunAdmissionError extends PreparedModelRuntimeOwnerNotPublishedError {
  constructor(error: PreparedModelRuntimeOwnerNotPublishedError) {
    super(error.message, { cause: error, admissionBlocked: true });
  }
}

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
