import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  QaSuiteArtifactError,
  QaSuiteCleanupError,
  QaSuiteInfraError,
  QaSuiteRunError,
} from "./errors.js";

export const QA_SUITE_INFRA_RETRY_LIMIT = 1;
const QA_SUITE_INFRA_RETRY_NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
]);

function hasQaSuiteRetryableNetworkCode(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current !== "object") {
      return false;
    }
    // SAFETY: current is a non-null object; code and cause remain unknown until checked.
    const record = current as { cause?: unknown; code?: unknown };
    if (
      typeof record.code === "string" &&
      QA_SUITE_INFRA_RETRY_NETWORK_ERROR_CODES.has(record.code.toUpperCase())
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

export function isQaSuiteInfraRetryableError(error: unknown): boolean {
  if (error instanceof QaSuiteRunError) {
    return isQaSuiteInfraRetryableError(error.cause);
  }
  if (error instanceof QaSuiteCleanupError) {
    return false;
  }
  if (error instanceof QaSuiteArtifactError) {
    return error.code !== "publication_failed";
  }
  if (error instanceof QaSuiteInfraError) {
    return true;
  }
  return hasQaSuiteRetryableNetworkCode(error);
}

export async function runQaSuiteWithInfraRetry<Result>(
  run: (attempt: number) => Promise<Result>,
  maxRetries = QA_SUITE_INFRA_RETRY_LIMIT,
) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      if (!isQaSuiteInfraRetryableError(error) || attempt >= maxRetries) {
        throw error;
      }
      process.stderr.write(
        `[qa-suite] infra retry ${attempt + 1}/${maxRetries}: ${formatErrorMessage(error)}\n`,
      );
    }
  }
  throw new Error("unreachable qa suite retry state");
}
