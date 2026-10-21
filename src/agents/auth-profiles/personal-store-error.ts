import { formatErrorMessage } from "../../infra/errors.js";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";

const PERSONAL_AUTH_PROFILE_STORE_FAILURE_CODE = "personal_auth_profile_store";

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
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!(current instanceof Error) || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (
      current instanceof PersonalAuthProfileStoreError ||
      current instanceof SqliteWorkerError ||
      classifyGatewayStorageFailure(current) !== undefined
    ) {
      return current;
    }
    if (current instanceof AggregateError && current.errors.length > 0) {
      pending.push(current.errors[0]);
      continue;
    }
    const cause = Object.getOwnPropertyDescriptor(current, "cause")?.value;
    if (cause !== undefined) {
      pending.push(cause);
    }
  }
  return undefined;
}
