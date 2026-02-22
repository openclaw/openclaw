/**
 * Media understanding debug logger.
 *
 * Extracted from src/media-understanding/apply.ts on the dev branch.
 * Adds structured console.error debug output for attachment/provider
 * diagnostics during media understanding pipeline.
 */

export type MediaDebugLogger = {
  logAttachments(attachments: { path?: string; mime?: string; index?: number }[]): void;
  logMediaConfig(mediaConfig: unknown): void;
  logProviderRegistry(keys: string[]): void;
};

/**
 * Create a debug logger for media understanding diagnostics.
 *
 * Prefix defaults to `[DEBUG-MU]`. All output goes to stderr to avoid
 * polluting stdout (which may carry JSON-RPC traffic).
 */
export function createMediaDebugLogger(prefix = "[DEBUG-MU]"): MediaDebugLogger {
  return {
    logAttachments(attachments) {
      console.error(
        `${prefix} applyMediaUnderstanding called, attachments:`,
        JSON.stringify(
          attachments.map((a) => ({
            path: a.path?.slice(-30),
            mime: a.mime,
            index: a.index,
          })),
        ),
      );
    },

    logMediaConfig(mediaConfig) {
      console.error(`${prefix} cfg.tools.media:`, JSON.stringify(mediaConfig));
    },

    logProviderRegistry(keys) {
      console.error(`${prefix} providerRegistry keys:`, keys);
    },
  };
}
