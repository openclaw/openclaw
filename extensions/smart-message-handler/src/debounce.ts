import { isIncomplete, isComplete } from "./classifier.ts";
import type { SmartHandlerConfig, SessionState } from "./types.ts";

export interface DebugLogger {
  debug?: (message: string) => void;
}

export function logDebug(
  config: SmartHandlerConfig,
  message: string,
  data?: unknown,
  logger?: DebugLogger,
): void {
  if (!config.debug) {
    return;
  }
  const formatted =
    data !== undefined
      ? `[smart-message-handler] ${message} ${typeof data === "string" ? data : JSON.stringify(data)}`
      : `[smart-message-handler] ${message}`;
  if (logger?.debug) {
    logger.debug(formatted);
  } else {
    console.log(formatted);
  }
}

export function calculateDebounceMultiplier(
  message: string,
  sessionState: SessionState | undefined,
  config: SmartHandlerConfig,
): number {
  const trimmed = message.trim();
  let multiplier = 1.0;

  if (isIncomplete(trimmed, config)) {
    multiplier *= config.baseDebounceMultiplier;
    logDebug(config, `Message appears incomplete, multiplier: ${multiplier}`);
  } else if (isComplete(trimmed, config)) {
    multiplier *= 0.7;
    logDebug(config, `Message appears complete, multiplier: ${multiplier}`);
  }

  if (sessionState && sessionState.messageCount > 2) {
    const historyMultiplier = Math.min(1 + sessionState.messageCount / 10, 1.5);
    multiplier *= historyMultiplier;
    logDebug(config, `User has history of multi-message input, multiplier: ${multiplier}`);
  }

  return Math.min(multiplier, config.maxDebounceMultiplier);
}
