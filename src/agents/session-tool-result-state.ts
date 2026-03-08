export type PendingToolCall = { id: string; name?: string };

/**
 * Extract tool name from a toolCallId by removing common prefixes and separators.
 * Handles formats like:
 * - functions.read:0 -> read
 * - functions.read0 -> read
 * - functionsread3 -> read
 * - functions.write1 -> write
 * - functionswrite4 -> write
 * - toolCall_abc123 -> abc123
 */
export function extractToolNameFromId(id: string): string | undefined {
  if (!id || typeof id !== "string") {
    return undefined;
  }

  // Trim whitespace and check if empty
  const trimmed = id.trim();
  if (!trimmed) {
    return undefined;
  }

  // Remove common prefixes: "functions.", "toolCall_", "toolUse_", "functionCall_"
  // Also handles cases where "functions" is directly concatenated without separator (e.g., "functionsread")
  let normalized = trimmed
    .replace(/^(functions\.|toolCall_|toolUse_|functionCall_)/i, "")
    // Handle "functions" prefix without separator (e.g., "functionsread" -> "read")
    .replace(/^functions/i, "")
    // Remove index suffix after ":" or "_" or numeric suffix
    .replace(/:\d+$/, "")
    .replace(/_\d+$/, "")
    // Remove trailing digits only (e.g., "read1" -> "read")
    .replace(/(\D+)\d+$/, "$1");

  // If we extracted something meaningful, return it
  if (normalized && normalized.length > 0 && normalized.length < 64) {
    return normalized;
  }

  return undefined;
}

export type PendingToolCallState = {
  size: () => number;
  entries: () => IterableIterator<[string, string | undefined]>;
  getToolName: (id: string) => string | undefined;
  delete: (id: string) => void;
  clear: () => void;
  trackToolCalls: (calls: PendingToolCall[]) => void;
  getPendingIds: () => string[];
  shouldFlushForSanitizedDrop: () => boolean;
  shouldFlushBeforeNonToolResult: (nextRole: unknown, toolCallCount: number) => boolean;
  shouldFlushBeforeNewToolCalls: (toolCallCount: number) => boolean;
};

export function createPendingToolCallState(): PendingToolCallState {
  const pending = new Map<string, string | undefined>();

  return {
    size: () => pending.size,
    entries: () => pending.entries(),
    getToolName: (id: string) => {
      // First try exact match
      const exactMatch = pending.get(id);
      if (exactMatch) {
        return exactMatch;
      }

      // Try fuzzy matching: check if the incoming ID contains or is contained by any stored ID
      // This handles formats like "functionsread3" vs "functions.read:0"
      const lowerId = id.toLowerCase();
      for (const [storedId, storedName] of pending.entries()) {
        const lowerStoredId = storedId.toLowerCase();

        // Check if stored ID is contained in the incoming ID (e.g., "functions.read:0" in "functionsread3")
        if (lowerId.includes(lowerStoredId) || lowerStoredId.includes(lowerId)) {
          return storedName;
        }

        // Also check if the tool name (from stored name or extracted from stored ID) matches
        const storedToolName =
          storedName?.toLowerCase() || extractToolNameFromId(storedId)?.toLowerCase();
        if (storedToolName) {
          const extractedIdName = extractToolNameFromId(id)?.toLowerCase();
          if (
            extractedIdName &&
            (extractedIdName === storedToolName || lowerId.includes(storedToolName))
          ) {
            return storedName;
          }
        }
      }

      return undefined;
    },
    delete: (id: string) => {
      // First try exact match
      if (pending.has(id)) {
        pending.delete(id);
        return;
      }

      // Try fuzzy matching: same logic as getToolName
      const lowerId = id.toLowerCase();
      for (const [storedId, storedName] of pending.entries()) {
        const lowerStoredId = storedId.toLowerCase();

        if (lowerId.includes(lowerStoredId) || lowerStoredId.includes(lowerId)) {
          pending.delete(storedId);
          return;
        }

        const storedToolName =
          storedName?.toLowerCase() || extractToolNameFromId(storedId)?.toLowerCase();
        if (storedToolName) {
          const extractedIdName = extractToolNameFromId(id)?.toLowerCase();
          if (
            extractedIdName &&
            (extractedIdName === storedToolName || lowerId.includes(storedToolName))
          ) {
            pending.delete(storedId);
            return;
          }
        }
      }
    },
    clear: () => {
      pending.clear();
    },
    trackToolCalls: (calls: PendingToolCall[]) => {
      for (const call of calls) {
        pending.set(call.id, call.name);
      }
    },
    getPendingIds: () => Array.from(pending.keys()),
    shouldFlushForSanitizedDrop: () => pending.size > 0,
    shouldFlushBeforeNonToolResult: (nextRole: unknown, toolCallCount: number) =>
      pending.size > 0 && (toolCallCount === 0 || nextRole !== "assistant"),
    shouldFlushBeforeNewToolCalls: (toolCallCount: number) => pending.size > 0 && toolCallCount > 0,
  };
}
