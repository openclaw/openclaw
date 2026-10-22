import { formatErrorMessage } from "../../infra/errors.js";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";

const PERSONAL_AUTH_PROFILE_STORE_FAILURE_CODE = "personal_auth_profile_store";

function isStorageFailureNode(error: Error): boolean {
  const record = error as Error & Record<string, unknown>;
  return (
    classifyGatewayStorageFailure({
      code: record.code,
      errcode: record.errcode,
      errstr: record.errstr,
      errorCode: record.errorCode,
      errorMessage: record.errorMessage,
      message: error.message,
    }) !== undefined
  );
}

/** A personal credential read or write failed; this is not a provider credential rejection. */
export class PersonalAuthProfileStoreError extends Error {
  readonly code = PERSONAL_AUTH_PROFILE_STORE_FAILURE_CODE;

  constructor(action: "read" | "update", cause: unknown) {
    super(`Failed to ${action} the personal model account store: ${formatErrorMessage(cause)}`, {
      cause,
    });
    this.name = "PersonalAuthProfileStoreError";
  }
}

/** Find only the primary failure so cleanup errors cannot mask a provider rejection. */
export function findPersonalAuthProfileStoreFailure(error: unknown): Error | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current instanceof PersonalAuthProfileStoreError || current instanceof SqliteWorkerError) {
      return current;
    }
    if (current instanceof AggregateError) {
      current = current.errors[0];
      continue;
    }
    if (isStorageFailureNode(current)) {
      return current;
    }
    const cause = Object.getOwnPropertyDescriptor(current, "cause")?.value;
    current = cause;
  }
  return undefined;
}
