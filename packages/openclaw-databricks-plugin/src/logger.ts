import type { PluginLogger } from "openclaw/plugin-sdk/core";
import { sanitizeDatabricksText } from "./errors.js";

function redactToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.length <= 8) {
    return "***";
  }
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-3)}`;
}

function sanitizeString(value: string, token?: string): string {
  let sanitized = sanitizeDatabricksText(value);
  if (token) {
    sanitized = sanitized.split(token).join(redactToken(token));
  }
  return sanitized;
}

export function sanitizeLogValue(value: unknown, token?: string): unknown {
  if (typeof value === "string") {
    return sanitizeString(value, token);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeLogValue(entry, token));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes("token") ||
        lowerKey.includes("authorization") ||
        lowerKey.includes("api_key") ||
        lowerKey.includes("apikey") ||
        lowerKey.includes("secret")
      ) {
        result[key] = "***";
        continue;
      }
      if (lowerKey.includes("endpoint") || lowerKey.includes("host") || lowerKey.includes("url")) {
        result[key] = "[redacted-url]";
        continue;
      }
      result[key] = sanitizeLogValue(nested, token);
    }
    return result;
  }
  return value;
}

export function formatLogMessage(
  message: string,
  context?: Record<string, unknown>,
  token?: string,
): string {
  const safeMessage = sanitizeString(message, token);
  if (!context || Object.keys(context).length === 0) {
    return safeMessage;
  }
  return `${safeMessage} ${JSON.stringify(sanitizeLogValue(context, token))}`;
}

export function logDatabricks(
  logger: PluginLogger,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  context?: Record<string, unknown>,
  token?: string,
) {
  const payload = `[databricks] ${formatLogMessage(message, context, token)}`;
  if (level === "debug") {
    logger.debug?.(payload);
    return;
  }
  logger[level](payload);
}
