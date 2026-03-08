import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "./types.js";

// Creates a file-backed logger that appends timestamped entries.
// Parent directories are created on first write.
export const createFileLogger = (filePath: string): Logger => {
  let dirEnsured = false;

  const write = (level: string, message: string): void => {
    try {
      // Ensure parent directory exists on first write
      if (!dirEnsured) {
        mkdirSync(dirname(filePath), { recursive: true });
        dirEnsured = true;
      }
      const timestamp = new Date().toISOString();
      appendFileSync(filePath, `[${timestamp}] [${level}] ${message}\n`);
    } catch {
      // File logging must never crash the plugin
    }
  };

  return {
    info: (message) => write("INFO", message),
    warn: (message) => write("WARN", message),
    error: (message) => write("ERROR", message),
  };
};

// Composes two loggers — all calls go to both.
export const composeLoggers = (a: Logger, b: Logger): Logger => ({
  info: (msg) => {
    a.info(msg);
    b.info(msg);
  },
  warn: (msg) => {
    a.warn(msg);
    b.warn(msg);
  },
  error: (msg) => {
    a.error(msg);
    b.error(msg);
  },
});
