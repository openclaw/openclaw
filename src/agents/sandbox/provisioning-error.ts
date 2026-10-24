import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  isTrustedSecretSurfaceUnavailableError,
  SECRET_DEGRADATION_RETRY_HINT,
} from "../../secrets/runtime-degraded-state.js";

const SANDBOX_PROVISIONING_ERROR_CODE = "sandbox_provisioning";

/** A provider has confirmed that this exact runtime can never be resumed. */
export class SandboxRuntimeRetiredError extends Error {
  constructor(readonly runtimeId: string) {
    super(`Sandbox runtime "${runtimeId}" has been permanently released.`);
    this.name = "SandboxRuntimeRetiredError";
  }
}

/** Model-independent sandbox setup failure that must not consume model fallbacks. */
class SandboxProvisioningError extends Error {
  readonly code = SANDBOX_PROVISIONING_ERROR_CODE;
  readonly backendId: string;

  constructor(message: string, params: { backendId: string; cause?: unknown }) {
    super(message, { cause: params.cause });
    this.name = "SandboxProvisioningError";
    this.backendId = params.backendId;
  }
}

/** Preserve an existing typed failure or attach sandbox ownership to a backend setup error. */
export function toSandboxProvisioningError(error: unknown, backendId: string) {
  if (error instanceof SandboxProvisioningError) {
    return error;
  }
  const detail = formatErrorMessage(error) || `Sandbox backend "${backendId}" provisioning failed.`;
  const message = isTrustedSecretSurfaceUnavailableError(error)
    ? `${detail} Fix the referenced secret, run \`${SECRET_DEGRADATION_RETRY_HINT}\`, then retry.`
    : detail;
  return new SandboxProvisioningError(message, { backendId, cause: error });
}

/** Recognize the provisioning marker through the shared error-wrapper graph. */
export function isSandboxProvisioningError(error: unknown): boolean {
  return collectNestedErrorCandidates(error).some((candidate) => {
    try {
      return (
        candidate instanceof SandboxProvisioningError ||
        (candidate !== null &&
          typeof candidate === "object" &&
          "name" in candidate &&
          candidate.name === "SandboxProvisioningError" &&
          "code" in candidate &&
          candidate.code === SANDBOX_PROVISIONING_ERROR_CODE)
      );
    } catch {
      // Opaque marker fields must not hide an accessible sibling error.
      return false;
    }
  });
}
