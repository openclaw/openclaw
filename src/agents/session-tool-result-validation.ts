import type { AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CORRUPTED_PLACEHOLDER = "[Tool output corrupted - original truncated]";
const CORRUPTED_DEBUG_DIR = path.join(os.homedir(), ".openclaw", "debug", "corrupted-tool-results");

export type ValidationResult = {
  valid: boolean;
  message: AgentMessage;
  error?: Error;
  sanitized?: boolean;
};

/**
 * Validates that a tool result message can be safely persisted.
 * Checks:
 * - JSON structure is valid (can be serialized/deserialized)
 * - UTF-8 encoding is valid
 */
export function validateToolResultForPersistence(message: AgentMessage): ValidationResult {
  try {
    // Validate JSON structure by round-tripping through serialization
    const serialized = JSON.stringify(message);
    JSON.parse(serialized);

    // Validate UTF-8 encoding
    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(encoder.encode(serialized));

    return { valid: true, message };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      valid: false,
      message,
      error: err,
    };
  }
}

/**
 * Sanitizes a corrupted tool result by replacing content with a placeholder.
 * Returns a valid message that can be safely persisted.
 */
export function sanitizeCorruptedToolResult(
  message: AgentMessage,
  meta: { toolCallId?: string; toolName?: string },
): AgentMessage {
  const baseFields = {
    role: "toolResult" as const,
    toolCallId: meta.toolCallId ?? (message as { toolCallId?: string }).toolCallId ?? "unknown",
    toolName: meta.toolName ?? (message as { toolName?: string }).toolName ?? "unknown",
    content: [{ type: "text" as const, text: CORRUPTED_PLACEHOLDER }],
    isError: true,
    timestamp: Date.now(),
  };

  return baseFields as Extract<AgentMessage, { role: "toolResult" }>;
}

/**
 * Logs corrupted tool result to a debug file for investigation.
 */
export function logCorruptedToolResult(
  originalMessage: AgentMessage,
  error: Error,
  meta: { toolCallId?: string; toolName?: string; sessionKey?: string },
): string | null {
  try {
    fs.mkdirSync(CORRUPTED_DEBUG_DIR, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const filename = `corrupted-${meta.sessionKey ?? "unknown"}-${timestamp}-${suffix}.json`;
    const filepath = path.join(CORRUPTED_DEBUG_DIR, filename);

    // Attempt to serialize safely, fallback to string representation
    let originalContent: string;
    try {
      originalContent = JSON.stringify(originalMessage, null, 2);
    } catch {
      originalContent = String(originalMessage);
    }

    const debugLog = {
      timestamp: new Date().toISOString(),
      sessionKey: meta.sessionKey,
      toolCallId: meta.toolCallId,
      toolName: meta.toolName,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      originalContent,
    };

    fs.writeFileSync(filepath, JSON.stringify(debugLog, null, 2), "utf-8");
    return filepath;
  } catch {
    // If we can't even log the corruption, just continue silently
    return null;
  }
}

export type ValidateAndSanitizeResult = {
  message: AgentMessage;
  wasCorrupted: boolean;
  error?: Error;
  debugLogPath?: string | null;
};

/**
 * Validates a tool result message and sanitizes it if corrupted.
 * This is the main entry point for pre-persist validation.
 */
export function validateAndSanitizeToolResult(
  message: AgentMessage,
  meta: {
    toolCallId?: string;
    toolName?: string;
    sessionKey?: string;
    warn?: (message: string) => void;
  },
): ValidateAndSanitizeResult {
  const validation = validateToolResultForPersistence(message);

  if (validation.valid) {
    return { message: validation.message, wasCorrupted: false };
  }

  // Validation failed - sanitize and log
  const sanitized = sanitizeCorruptedToolResult(message, meta);
  const debugLogPath = logCorruptedToolResult(message, validation.error!, meta);

  meta.warn?.(
    `Tool result for ${meta.toolName ?? "unknown"} (${meta.toolCallId ?? "?"}) was corrupted and sanitized. ` +
      `Error: ${validation.error!.message}` +
      (debugLogPath ? ` Debug log: ${debugLogPath}` : ""),
  );

  return {
    message: sanitized,
    wasCorrupted: true,
    error: validation.error,
    debugLogPath,
  };
}
