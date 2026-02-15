/**
 * Structured logging for WeCom plugin
 */
const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function getEnvLogLevel() {
  const raw = (process.env.WECOM_LOG_LEVEL || process.env.LOG_LEVEL || "info").toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, raw) ? raw : "info";
}

export class Logger {
  prefix;
  level;
  constructor(prefix = "[wecom]", level = getEnvLogLevel()) {
    this.prefix = prefix;
    this.level = level;
  }
  log(level, message, context) {
    if (LEVELS[level] < LEVELS[this.level]) {
      return;
    }
    const timestamp = new Date().toISOString();
    const contextStr = context ? ` ${JSON.stringify(context)}` : "";
    const logMessage = `${timestamp} ${level.toUpperCase()} ${this.prefix} ${message}${contextStr}`;
    switch (level) {
      case "debug":
        console.debug(logMessage);
        break;
      case "info":
        console.info(logMessage);
        break;
      case "warn":
        console.warn(logMessage);
        break;
      case "error":
        console.error(logMessage);
        break;
    }
  }
  debug(message, context) {
    this.log("debug", message, context);
  }
  info(message, context) {
    this.log("info", message, context);
  }
  warn(message, context) {
    this.log("warn", message, context);
  }
  error(message, context) {
    this.log("error", message, context);
  }
  child(subPrefix) {
    return new Logger(`${this.prefix}:${subPrefix}`, this.level);
  }
}
// Default logger instance
export const logger = new Logger();
