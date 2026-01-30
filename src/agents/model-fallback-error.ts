import type { FailoverReason } from "./pi-embedded-helpers/types.js";

export class AllModelsFailedError extends Error {
  readonly attempts: Array<{
    provider: string;
    model: string;
    error: string;
    reason?: FailoverReason;
    status?: number;
    code?: string;
  }>;
  readonly allInCooldown: boolean;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    params: {
      attempts: AllModelsFailedError["attempts"];
      allInCooldown: boolean;
      retryAfterMs?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: params.cause });
    this.name = "AllModelsFailedError";
    this.attempts = params.attempts;
    this.allInCooldown = params.allInCooldown;
    this.retryAfterMs = params.retryAfterMs;
  }

  isCooldownOnly(): boolean {
    return this.allInCooldown && this.attempts.length > 0;
  }
}

export function isAllModelsFailedError(err: unknown): err is AllModelsFailedError {
  return err instanceof AllModelsFailedError;
}
