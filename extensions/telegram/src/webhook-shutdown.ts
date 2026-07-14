// Ordered Telegram webhook teardown phases.
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";

export interface TelegramWebhookShutdownPhases {
  abortShutdown: () => void;
  clearDrainTimer: () => void;
  closeServer: () => void;
  stopBot: () => Promise<void>;
  closeTransport: () => Promise<void>;
  noteStop: () => void;
  stopDiagnostics?: () => void;
  onError: (message: string) => void;
}

/**
 * Run webhook shutdown phases independently.
 * A sync or async failure in one phase must not skip later owned cleanup
 * (bot stop, transport close, status, diagnostics). Never rejects: abort
 * listeners fire-and-forget this path and must not leak unhandled rejections.
 */
export async function runTelegramWebhookShutdownPhases(
  phases: TelegramWebhookShutdownPhases,
): Promise<void> {
  try {
    phases.abortShutdown();
    phases.clearDrainTimer();
    try {
      phases.closeServer();
    } catch (err) {
      phases.onError(`webhook server close failed: ${formatErrorMessage(err)}`);
    }
    try {
      await phases.stopBot();
    } catch (err) {
      phases.onError(`webhook shutdown failed: ${formatErrorMessage(err)}`);
    }
    try {
      // Owned undici transport: close once on all exit paths.
      await phases.closeTransport();
    } catch (err) {
      phases.onError(`webhook transport close failed: ${formatErrorMessage(err)}`);
    }
    phases.noteStop();
    phases.stopDiagnostics?.();
  } catch (err) {
    phases.onError(`webhook shutdown unexpected error: ${formatErrorMessage(err)}`);
  }
}
