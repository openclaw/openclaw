import type { FailoverReason } from "./pi-embedded-helpers.js";

export class FailoverError extends Error {
  readonly reason: FailoverReason;
  readonly provider?: string;
  readonly model?: string;
  readonly profileId?: string;
  readonly status?: number;
  readonly code?: string;

  constructor(
    message: string,
    params: {
      reason: FailoverReason;
      provider?: string;
      model?: string;
      profileId?: string;
      status?: number;
      code?: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: params.cause });
    this.name = "FailoverError";
    this.reason = params.reason;
    this.provider = params.provider;
    this.model = params.model;
    this.profileId = params.profileId;
    this.status = params.status;
    this.code = params.code;
  }
}

export function isFailoverError(err: unknown): err is FailoverError {
  return err instanceof FailoverError;
}

export function resolveFailoverStatus(
  reason: FailoverReason,
): number | undefined {
  switch (reason) {
    case "billing":
      return 402;
    case "rate_limit":
      return 429;
    case "auth":
      return 401;
    case "timeout":
      return 408;
    default:
      return undefined;
  }
}
