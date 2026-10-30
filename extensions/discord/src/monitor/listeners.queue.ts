import { createSubsystemLogger, formatDurationSeconds } from "openclaw/plugin-sdk/runtime-env";

export type DiscordListenerLogger = ReturnType<
  typeof import("openclaw/plugin-sdk/runtime-env").createSubsystemLogger
>;

const DISCORD_SLOW_LISTENER_THRESHOLD_MS = 30_000;

export const discordEventQueueLog = createSubsystemLogger("discord/event-queue");

export async function runDiscordListenerWithSlowLog(params: {
  logger: DiscordListenerLogger | undefined;
  listener: string;
  event: string;
  run: () => Promise<void>;
  onError?: (err: unknown) => void;
}) {
  // Listener duration is measured, not wall-clock read: a system-clock step during the
  // run must not fabricate or hide a slow-listener warning.
  const startedAt = performance.now();
  try {
    await params.run();
  } catch (err) {
    if (params.onError) {
      params.onError(err);
      return;
    }
    throw err;
  } finally {
    const { logger, listener, event } = params;
    const durationMs = performance.now() - startedAt;
    if (!(durationMs < DISCORD_SLOW_LISTENER_THRESHOLD_MS)) {
      const duration = formatDurationSeconds(durationMs, {
        decimals: 1,
        unit: "seconds",
      });
      const message = `Slow listener detected: ${listener} took ${duration} for event ${event}`;
      (logger ?? discordEventQueueLog).warn("Slow listener detected", {
        listener,
        event,
        durationMs,
        duration,
        consoleMessage: message,
      });
    }
  }
}
