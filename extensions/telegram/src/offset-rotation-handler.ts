import {
  deleteTelegramUpdateOffset,
  type TelegramUpdateOffsetRotationInfo,
} from "./update-offset-store.js";

export type TelegramOffsetRotationLogger = (line: string) => void;
export type TelegramOffsetRotationErrorLogger = (line: string) => void;

export type TelegramOffsetRotationHandlerOptions = {
  accountId: string;
  log: TelegramOffsetRotationLogger;
  logError?: TelegramOffsetRotationErrorLogger;
  env?: NodeJS.ProcessEnv;
};

/**
 * Produces the user-visible warning line we log when a persisted Telegram
 * update offset is discarded because the bot identity or token rotated.
 *
 * Exposed as a pure function so call sites (monitor, doctor, diagnostics)
 * stay consistent without duplicating the wording.
 */
export function formatTelegramOffsetRotationMessage(
  accountId: string,
  info: TelegramUpdateOffsetRotationInfo,
): string {
  const previousLabel = info.previousBotId ?? "(legacy unscoped offset)";
  const reasonLabel = describeTelegramOffsetRotationReason(info.reason);
  return `[telegram] Detected ${reasonLabel} for account "${accountId}" (was ${previousLabel}, now ${info.currentBotId}); discarding stale update offset ${info.staleLastUpdateId} and starting fresh.`;
}

/**
 * Maps the typed rotation reason to a short human-readable label used in
 * log lines.
 */
export function describeTelegramOffsetRotationReason(
  reason: TelegramUpdateOffsetRotationInfo["reason"],
): string {
  switch (reason) {
    case "bot-id-changed":
      return "bot identity change";
    case "token-rotated":
      return "token rotation";
    case "legacy-state":
      return "legacy update offset";
  }
}

/**
 * Encapsulates the side effects performed when `readTelegramUpdateOffset`
 * reports rotation: log a single warning line and remove the stale offset
 * file so disk state and in-memory state agree. Centralising this keeps
 * monitor startup and any future callers (e.g. `openclaw doctor`) honest.
 */
export class TelegramOffsetRotationHandler {
  readonly #accountId: string;
  readonly #log: TelegramOffsetRotationLogger;
  readonly #logError: TelegramOffsetRotationErrorLogger;
  readonly #env: NodeJS.ProcessEnv | undefined;

  constructor(opts: TelegramOffsetRotationHandlerOptions) {
    this.#accountId = opts.accountId;
    this.#log = opts.log;
    this.#logError = opts.logError ?? opts.log;
    this.#env = opts.env;
  }

  /** Account id the handler was constructed for. */
  get accountId(): string {
    return this.#accountId;
  }

  /**
   * Builds the warning line without emitting it. Useful for tests and for
   * surfacing the same wording through non-log surfaces.
   */
  formatMessage(info: TelegramUpdateOffsetRotationInfo): string {
    return formatTelegramOffsetRotationMessage(this.#accountId, info);
  }

  /**
   * Handle a rotation report from `readTelegramUpdateOffset`. Logs the
   * warning synchronously and removes the stale file in the background;
   * failures are reported through `logError`.
   */
  handle(info: TelegramUpdateOffsetRotationInfo): void {
    this.#log(this.formatMessage(info));
    void this.#deleteStaleOffset();
  }

  async #deleteStaleOffset(): Promise<void> {
    try {
      await deleteTelegramUpdateOffset({
        accountId: this.#accountId,
        ...(this.#env ? { env: this.#env } : {}),
      });
    } catch (err) {
      this.#logError(
        `telegram: failed to delete stale update offset after rotation: ${String(err)}`,
      );
    }
  }
}

/**
 * Convenience factory mirroring the rest of the SDK's `createXxx` style.
 */
export function createTelegramOffsetRotationHandler(
  opts: TelegramOffsetRotationHandlerOptions,
): TelegramOffsetRotationHandler {
  return new TelegramOffsetRotationHandler(opts);
}
