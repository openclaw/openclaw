// Discord plugin module implements narrow inbound dispatch retry behavior.
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { DiscordRetryableInboundError } from "./inbound-dedupe.js";

const REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE = /^reply session initialization conflicted for \S+$/u;
const DISCORD_SESSION_INIT_CONFLICT_RETRY_DELAYS_MS = [250, 1_000, 2_500] as const;

function isReplySessionInitConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE.test(message);
}

export class DiscordReplySessionConflictExhaustedError extends DiscordRetryableInboundError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DiscordReplySessionConflictExhaustedError";
  }
}

export async function dispatchDiscordReplyWithSessionConflictRetry<T>(params: {
  dispatch: () => Promise<T>;
  abortSignal?: AbortSignal;
  onRetry?: (attempt: number, delayMs: number) => void;
}): Promise<T> {
  for (let retryIndex = 0; ; retryIndex += 1) {
    try {
      return await params.dispatch();
    } catch (error) {
      if (!isReplySessionInitConflictError(error)) {
        throw error;
      }
      const delayMs = DISCORD_SESSION_INIT_CONFLICT_RETRY_DELAYS_MS[retryIndex];
      if (delayMs === undefined) {
        const message = error instanceof Error ? error.message : String(error);
        // Let the caller either complete with a visible terminal notice or
        // reopen replay ownership when that notice cannot land.
        throw new DiscordReplySessionConflictExhaustedError(
          `discord: reply session init conflict persisted after shared and channel retries: ${message}`,
          { cause: error },
        );
      }
      params.onRetry?.(retryIndex + 1, delayMs);
      await sleepWithAbort(delayMs, params.abortSignal);
    }
  }
}
