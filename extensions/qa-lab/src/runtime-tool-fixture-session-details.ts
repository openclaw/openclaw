import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { QaSuiteInfraError } from "./errors.js";

const RUNTIME_PARITY_SESSION_KEY_DETAIL_PREFIX = "RUNTIME_PARITY_SESSION_KEY=";

export function runtimeParitySessionKeyDetails(...sessionKeys: string[]) {
  return sessionKeys.map(
    (sessionKey) => `${RUNTIME_PARITY_SESSION_KEY_DETAIL_PREFIX}${sessionKey}`,
  );
}

export function runtimeToolFixtureError(error: unknown, ...sessionKeys: string[]) {
  const message = [
    ...runtimeParitySessionKeyDetails(...sessionKeys),
    formatErrorMessage(error),
  ].join("\n");
  return error instanceof QaSuiteInfraError
    ? new QaSuiteInfraError(error.code, message, { cause: error })
    : new Error(message, { cause: error });
}
