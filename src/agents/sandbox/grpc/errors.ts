/**
 * gRPC error mapping for the Firecracker sandbox provider.
 *
 * Translates gRPC status codes from the vm-runner into domain-specific
 * SandboxProviderError instances with retry semantics.
 */

// @ts-expect-error -- Optional gRPC dependency for Firecracker support
import { Status, ClientError } from "nice-grpc";

export interface SandboxProviderErrorOptions {
  operation: string;
  grpcCode?: number;
  isRetryable: boolean;
}

/**
 * Domain error for sandbox provider operations.
 * Carries gRPC context (status code, operation name) and retry semantics.
 */
export class SandboxProviderError extends Error {
  readonly operation: string;
  readonly grpcCode?: number;
  readonly isRetryable: boolean;

  constructor(message: string, opts: SandboxProviderErrorOptions) {
    super(message);
    this.name = "SandboxProviderError";
    this.operation = opts.operation;
    this.grpcCode = opts.grpcCode;
    this.isRetryable = opts.isRetryable;
  }
}

interface StatusMapping {
  message: string;
  isRetryable: boolean;
}

const STATUS_MAP: Record<number, StatusMapping> = {
  [Status.NOT_FOUND]: {
    message: "VM not found",
    isRetryable: false,
  },
  [Status.UNAVAILABLE]: {
    message: "vm-runner unavailable",
    isRetryable: true,
  },
  [Status.DEADLINE_EXCEEDED]: {
    message: "operation timed out",
    isRetryable: true,
  },
  [Status.ALREADY_EXISTS]: {
    message: "VM already exists",
    isRetryable: false,
  },
  [Status.RESOURCE_EXHAUSTED]: {
    message: "resources exhausted",
    isRetryable: false,
  },
  [Status.INTERNAL]: {
    message: "internal vm-runner error",
    isRetryable: false,
  },
  [Status.PERMISSION_DENIED]: {
    message: "permission denied",
    isRetryable: false,
  },
  [Status.INVALID_ARGUMENT]: {
    message: "invalid argument",
    isRetryable: false,
  },
  [Status.FAILED_PRECONDITION]: {
    message: "failed precondition",
    isRetryable: false,
  },
  [Status.UNIMPLEMENTED]: {
    message: "operation not implemented",
    isRetryable: false,
  },
};

/**
 * Map a gRPC error (or any error) into a SandboxProviderError.
 *
 * - If the error is already a SandboxProviderError, it is returned as-is.
 * - If it is a nice-grpc ClientError, the status code is mapped to
 *   a domain error with appropriate retry semantics.
 * - Otherwise, the error is wrapped as a non-retryable unknown error.
 */
export function mapGrpcError(err: unknown, operation: string): SandboxProviderError {
  // Pass-through existing SandboxProviderError
  if (err instanceof SandboxProviderError) {
    return err;
  }

  // Map nice-grpc ClientError using status code
  if (err instanceof ClientError) {
    const clientErr: { code: number; message: string } = err;
    const mapping = STATUS_MAP[clientErr.code];
    if (mapping) {
      return new SandboxProviderError(`${operation}: ${mapping.message} - ${clientErr.message}`, {
        operation,
        grpcCode: clientErr.code,
        isRetryable: mapping.isRetryable,
      });
    }

    // Unknown gRPC status code
    return new SandboxProviderError(
      `${operation}: gRPC error (code ${clientErr.code}) - ${clientErr.message}`,
      {
        operation,
        grpcCode: clientErr.code,
        isRetryable: false,
      },
    );
  }

  // Unknown non-gRPC error
  const message = err instanceof Error ? err.message : String(err);
  return new SandboxProviderError(`${operation}: unexpected error - ${message}`, {
    operation,
    isRetryable: false,
  });
}
