/**
 * Tool-call block type check: covers Anthropic (toolUse), OpenAI (functionCall),
 * and internal (toolCall) representations.
 */
export function isToolCallBlockType(type: unknown): boolean {
  return type === "toolCall" || type === "toolUse" || type === "functionCall";
}

/**
 * Ensure every tool-call block in a message has a unique, non-empty ID.
 *
 * - Empty/whitespace-only IDs are replaced with auto-generated fallbacks.
 * - Duplicate IDs (e.g. two blocks with "edit:22") are deduplicated: the first
 *   occurrence keeps the original, subsequent duplicates get a fresh ID.
 *
 * This prevents HTTP 400 errors from OpenAI-compatible backends that require
 * unique tool_call_id values within a single request.
 */
export function normalizeToolCallIdsInMessage(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }

  // First pass: collect all existing non-empty IDs so fallback generation
  // can avoid collisions with any ID already present in the message.
  const usedIds = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; id?: unknown };
    if (!isToolCallBlockType(typedBlock.type) || typeof typedBlock.id !== "string") {
      continue;
    }
    const trimmedId = typedBlock.id.trim();
    if (!trimmedId) {
      continue;
    }
    usedIds.add(trimmedId);
  }

  // Second pass: assign unique IDs. The first occurrence of a non-empty ID
  // keeps it; subsequent duplicates (e.g. two "edit:22" blocks) get a fresh
  // auto-generated ID so that every tool_call_id in the message is unique.
  const assignedIds = new Set<string>();
  let fallbackIndex = 1;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; id?: unknown };
    if (!isToolCallBlockType(typedBlock.type)) {
      continue;
    }
    if (typeof typedBlock.id === "string") {
      const trimmedId = typedBlock.id.trim();
      if (trimmedId && !assignedIds.has(trimmedId)) {
        if (typedBlock.id !== trimmedId) {
          typedBlock.id = trimmedId;
        }
        assignedIds.add(trimmedId);
        continue;
      }
    }

    let fallbackId = "";
    while (!fallbackId || usedIds.has(fallbackId)) {
      fallbackId = `call_auto_${fallbackIndex++}`;
    }
    typedBlock.id = fallbackId;
    assignedIds.add(fallbackId);
    usedIds.add(fallbackId);
  }
}
