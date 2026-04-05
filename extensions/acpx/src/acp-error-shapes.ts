import type { OutputErrorAcpPayload } from "./runtime-types.js";

const RESOURCE_NOT_FOUND_ACP_CODES = new Set([-32001, -32002]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function toAcpErrorPayload(value: unknown): OutputErrorAcpPayload | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  if (typeof record.code !== "number" || !Number.isFinite(record.code)) {
    return undefined;
  }
  if (typeof record.message !== "string" || record.message.length === 0) {
    return undefined;
  }

  return {
    code: record.code,
    message: record.message,
    data: record.data,
  };
}

function extractAcpErrorInternal(value: unknown, depth: number): OutputErrorAcpPayload | undefined {
  if (depth > 5) {
    return undefined;
  }

  const direct = toAcpErrorPayload(value);
  if (direct) {
    return direct;
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  if ("error" in record) {
    const nested = extractAcpErrorInternal(record.error, depth + 1);
    if (nested) {
      return nested;
    }
  }

  if ("acp" in record) {
    const nested = extractAcpErrorInternal(record.acp, depth + 1);
    if (nested) {
      return nested;
    }
  }

  if ("cause" in record) {
    const nested = extractAcpErrorInternal(record.cause, depth + 1);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

export function formatUnknownErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === "object") {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === "string" && maybeMessage.length > 0) {
      return maybeMessage;
    }

    try {
      return JSON.stringify(error);
    } catch {
      // fall through
    }
  }

  return String(error);
}

// Matches "session" followed by optional ID (quoted or unquoted) followed by "not found"
// Examples: "Session \"abc\" not found", "Session abc-123 not found"
const SESSION_NOT_FOUND_PATTERN = /session\s+["'\w-]+\s+not found/i;

function isSessionNotFoundText(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.toLowerCase();
  return (
    normalized.includes("resource_not_found") ||
    normalized.includes("resource not found") ||
    normalized.includes("session not found") ||
    normalized.includes("unknown session") ||
    normalized.includes("invalid session identifier") ||
    SESSION_NOT_FOUND_PATTERN.test(value)
  );
}

function hasSessionNotFoundHint(value: unknown, depth = 0): boolean {
  if (depth > 4) {
    return false;
  }

  if (isSessionNotFoundText(value)) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => hasSessionNotFoundHint(entry, depth + 1));
  }

  const record = asRecord(value);
  if (!record) {
    return false;
  }

  return Object.values(record).some((entry) => hasSessionNotFoundHint(entry, depth + 1));
}

export function extractAcpError(error: unknown): OutputErrorAcpPayload | undefined {
  return extractAcpErrorInternal(error, 0);
}

export function isAcpResourceNotFoundError(error: unknown): boolean {
  const acp = extractAcpError(error);
  if (acp && RESOURCE_NOT_FOUND_ACP_CODES.has(acp.code)) {
    return true;
  }

  if (acp) {
    if (isSessionNotFoundText(acp.message)) {
      return true;
    }
    if (hasSessionNotFoundHint(acp.data)) {
      return true;
    }
  }

  return isSessionNotFoundText(formatUnknownErrorMessage(error));
}
