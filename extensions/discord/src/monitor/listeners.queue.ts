import { createSubsystemLogger, formatDurationSeconds } from "openclaw/plugin-sdk/runtime-env";

export type DiscordListenerLogger = ReturnType<
  typeof import("openclaw/plugin-sdk/runtime-env").createSubsystemLogger
>;

const DISCORD_SLOW_LISTENER_THRESHOLD_MS = 30_000;

export const discordEventQueueLog = createSubsystemLogger("discord/event-queue");

function logSlowDiscordListener(params: {
  logger: DiscordListenerLogger | undefined;
  listener: string;
  event: string;
  durationMs: number;
}) {
  if (params.durationMs < DISCORD_SLOW_LISTENER_THRESHOLD_MS) {
    return;
  }
  const duration = formatDurationSeconds(params.durationMs, {
    decimals: 1,
    unit: "seconds",
  });
  const message = `Slow listener detected: ${params.listener} took ${duration} for event ${params.event}`;
  const logger = params.logger ?? discordEventQueueLog;
  logger.warn("Slow listener detected", {
    listener: params.listener,
    event: params.event,
    durationMs: params.durationMs,
    duration,
    consoleMessage: message,
  });
}

export async function runDiscordListenerWithSlowLog(params: {
  logger: DiscordListenerLogger | undefined;
  listener: string;
  event: string;
  run: () => Promise<void>;
  onError?: (err: unknown) => void;
}) {
  const startedAt = Date.now();
  try {
    await params.run();
  } catch (err) {
    if (params.onError) {
      params.onError(err);
      return;
    }
    throw err;
  } finally {
    logSlowDiscordListener({
      ...params,
      durationMs: Date.now() - startedAt,
    });
  }
}
