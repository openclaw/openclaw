import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { QaSuiteArtifactError, QaSuiteInfraError } from "./errors.js";

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
    const record = asOptionalObjectRecord(current);
    if (!record) {
      return false;
    }
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

export function isQaSuiteInfraRetryableError(error: unknown) {
  if (error instanceof QaSuiteArtifactError || error instanceof QaSuiteInfraError) {
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
