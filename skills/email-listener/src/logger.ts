/**
 * Email Listener Skill - Logger Module
 *
 * Simple logger that outputs to console with structured logging.
 */

import type { Logger } from "./types.js";

/**
 * Create a logger instance with the given prefix
 */
export function createLogger(prefix: string = "email-listener"): Logger {
  const formatMessage = (level: string, message: string, meta?: Record<string, unknown>): string => {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
    return `[${timestamp}] [${prefix}] [${level}] ${message}${metaStr}`;
  };

  return {
    info(message: string, meta?: Record<string, unknown>): void {
      console.log(formatMessage("INFO", message, meta));
    },

    warn(message: string, meta?: Record<string, unknown>): void {
      console.warn(formatMessage("WARN", message, meta));
    },

    error(message: string, meta?: Record<string, unknown>): void {
      console.error(formatMessage("ERROR", message, meta));
    },

    debug(message: string, meta?: Record<string, unknown>): void {
      if (process.env.DEBUG === "true" || process.env.DEBUG?.includes("email-listener")) {
        console.debug(formatMessage("DEBUG", message, meta));
      }
    },
  };
}

/**
 * Default logger instance
 */
export const logger = createLogger();
