/**
 * Voice Call Logger
 * 
 * Provides consistent logging for the voice-call extension.
 * Replaces console.* calls with proper logging that can be controlled
 * via configuration.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

const LOG_PREFIX = "[voice-call]";

function formatMessage(level: LogLevel, message: string): string {
  const timestamp = new Date().toISOString();
  return `${timestamp} ${LOG_PREFIX} [${level.toUpperCase()}] ${message}`;
}

export function createLogger(config?: { level?: LogLevel; enabled?: boolean }): Logger {
  const enabled = config?.enabled !== false;
  const minLevel = config?.level ?? "info";
  
  const levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };
  
  const minLevelNum = levels[minLevel];
  
  return {
    debug: (message: string, ...args: unknown[]) => {
      if (enabled && levels.debug >= minLevelNum) {
        // eslint-disable-next-line no-console
        console.debug(formatMessage("debug", message), ...args);
      }
    },
    info: (message: string, ...args: unknown[]) => {
      if (enabled && levels.info >= minLevelNum) {
        // eslint-disable-next-line no-console
        console.log(formatMessage("info", message), ...args);
      }
    },
    warn: (message: string, ...args: unknown[]) => {
      if (enabled && levels.warn >= minLevelNum) {
        // eslint-disable-next-line no-console
        console.warn(formatMessage("warn", message), ...args);
      }
    },
    error: (message: string, ...args: unknown[]) => {
      if (enabled && levels.error >= minLevelNum) {
        // eslint-disable-next-line no-console
        console.error(formatMessage("error", message), ...args);
      }
    },
  };
}

// Default logger instance
export const logger = createLogger();

// Helper to format errors
export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}
