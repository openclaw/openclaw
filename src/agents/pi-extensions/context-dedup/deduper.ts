import { createHash } from "node:crypto";

export type RefTagFormat = "unicode" | "angle";

/** Message structure from context event */
export interface DedupMessage {
  role: "user" | "assistant" | "system" | "tool" | "toolResult";
  content: string | { type: string; text?: string; content?: string }[];
}

export interface DedupConfig {
  mode: "off" | "on";
  debugDump?: boolean;
  minContentSize: number;
  refTagFormat: RefTagFormat;
}

export interface EffectiveDedupSettings {
  mode: "off" | "on";
  debugDump?: boolean;
  minContentSize: number;
  refTagFormat: RefTagFormat;
}

export interface RefTable {
  [refId: string]: string; // refId -> content
}

export interface DedupResult {
  messages: any[];
  refTable: RefTable;
  refTagSize: number;
}

function refSuffix(refId: string): string {
  return refId.startsWith("REF_") ? refId.slice(4) : refId;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Get reference tag delimiters.
 *
 * NOTE:
 * We intentionally emit the same canonical format for both config variants:
 *   tag:   <¯REF_XXXX¯>
 *   table: <¯REF_XXXX= [content] END_REF¯>
 * This keeps behavior stable even when existing configs still say "angle".
 */
export function getRefDelimiters(_format: RefTagFormat): {
  start: string;
  end: string;
  full: (id: string) => string;
} {
  const start = "<¯REF_";
  const end = "¯>";
  return {
    start,
    end,
    full: (id: string) => `<¯REF_${id}¯>`,
  };
}

/**
 * Generate a short hash for content (8 hex chars).
 */
export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

function messageRole(msg: any): string {
  return String(msg?.role ?? "").toLowerCase();
}

/**
 * Dedup target scope:
 * - Only tool/toolResult message bodies (where file-read outputs typically land)
 * - No sub-line/LCS chunking; exact full-string matches only
 */
function isDedupEligibleMessage(msg: any): boolean {
  const role = messageRole(msg);
  return role === "tool" || role === "toolresult";
}

type TextLikeBlock = string | { type?: string; text?: string; content?: string; [key: string]: unknown };

function getBlockText(block: TextLikeBlock): string | undefined {
  if (typeof block === "string") {
    return block;
  }

  if (!block || typeof block !== "object") {
    return undefined;
  }

  const blockType = typeof block.type === "string" ? block.type.toLowerCase() : undefined;
  if (blockType && blockType !== "text") {
    return undefined;
  }

  if (typeof block.text === "string") {
    return block.text;
  }

  if (typeof block.content === "string") {
    return block.content;
  }

  return undefined;
}

function replaceBlockText(block: TextLikeBlock, nextText: string): TextLikeBlock {
  if (typeof block === "string") {
    return nextText;
  }

  if (!block || typeof block !== "object") {
    return block;
  }

  if (typeof block.text === "string") {
    return { ...block, text: nextText };
  }

  if (typeof block.content === "string") {
    return { ...block, content: nextText };
  }

  return block;
}

/**
 * Get the full reference tag string.
 */
export function makeRefTag(refId: string, config: DedupConfig): string {
  const { full } = getRefDelimiters(config.refTagFormat);
  return full(refSuffix(refId));
}

/**
 * Get the reference tag size in characters.
 */
export function getRefTagSize(config: DedupConfig): number {
  const { start, end } = getRefDelimiters(config.refTagFormat);
  // Format: <¯REF_XXXXXXXX¯>
  return start.length + 8 + end.length;
}

/**
 * Build reference table explanation text for the LLM.
 */
export function buildRefTableExplanation(config: DedupConfig): string {
  const { full } = getRefDelimiters(config.refTagFormat);
  const exampleRef = full("EXAMPLE");

  return `[REFERENCES]
Use reference tags in this format: ${exampleRef}
Resolve each tag with the table entries below.
Each entry uses: <¯REF_XXXX= [content] END_REF¯>
`;
}

/**
 * Deduplicate content in messages.
 *
 * Algorithm:
 * 1. Scan tool/toolResult message text blocks for exact duplicate strings
 * 2. Build ref table for content appearing >1 time AND larger than ref tag
 * 3. Replace matching full blocks in eligible messages with refs
 * 4. Return modified messages + ref table
 */
export function deduplicateMessages(messages: any[], config: DedupConfig): DedupResult {
  if (config.mode === "off") {
    return {
      messages,
      refTable: {},
      refTagSize: getRefTagSize(config),
    };
  }

  // Step 1: Count content occurrences and store unique content
  const contentCounts = new Map<string, number>();
  const hashToContent = new Map<string, string>(); // hash -> content

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];

    // Only dedup tool/toolResult payloads (e.g., repeated file-read results).
    if (!isDedupEligibleMessage(msg)) {
      continue;
    }

    // Handle different content structures
    const contents = Array.isArray(msg.content) ? msg.content : [msg.content];

    for (let blockIdx = 0; blockIdx < contents.length; blockIdx++) {
      const block = contents[blockIdx] as TextLikeBlock;
      const text = getBlockText(block);

      // Skip non-text content
      if (typeof text !== "string") {
        continue;
      }

      // Ignore whitespace-only blocks, but keep exact-content matching otherwise.
      if (!text.trim()) {
        continue;
      }

      const hash = contentHash(text);
      const count = (contentCounts.get(hash) || 0) + 1;
      contentCounts.set(hash, count);

      if (!hashToContent.has(hash)) {
        hashToContent.set(hash, text);
      }
    }
  }

  // Step 2: Build ref table for content that appears >1 time AND is larger than ref tag
  const refTagSize = getRefTagSize(config);
  const refMap = new Map<string, string>(); // hash -> refId
  const refTable: RefTable = {};

  for (const [hash, count] of contentCounts) {
    if (count <= 1) {
      continue; // Only deduplicate content that appears multiple times
    }

    const content = hashToContent.get(hash);
    if (!content || content.length < config.minContentSize) {
      continue; // Skip if content is too small
    }

    if (content.length <= refTagSize) {
      continue; // No space savings
    }

    // Add to ref table
    const refId = `REF_${hash}`;
    refMap.set(hash, refId);
    refTable[refId] = content;
  }

  // Step 3: Replace content with refs where applicable
  const newMessages: any[] = messages.map((msg) => {
    if (!isDedupEligibleMessage(msg)) {
      return msg;
    }

    const isArrayContent = Array.isArray(msg.content);
    const contents = isArrayContent ? msg.content : [msg.content];

    const newContents = contents.map((block: TextLikeBlock) => {
      const text = getBlockText(block);
      if (typeof text !== "string") {
        return block;
      }

      if (!text.trim()) {
        return block;
      }

      const hash = contentHash(text);

      if (refMap.has(hash)) {
        const refId = refMap.get(hash)!;
        return replaceBlockText(block, makeRefTag(refId, config));
      }

      return block;
    });

    return {
      ...msg,
      content: isArrayContent ? newContents : newContents[0],
    };
  });

  return {
    messages: newMessages,
    refTable,
    refTagSize,
  };
}

/**
 * Clean orphaned refs from table - remove entries no longer referenced in messages.
 * Used during context compaction when old content is pruned.
 */
export function cleanOrphanedRefs(messages: any[], refTable: RefTable, config: DedupConfig): RefTable {
  // Find all ref IDs used in messages
  const usedRefs = new Set<string>();
  const { start, end } = getRefDelimiters(config.refTagFormat);
  const regex = new RegExp(`${escapeRegExp(start)}(\\w+)(?:${escapeRegExp(end)}|=)`, "g");

  for (const msg of messages) {
    const contents = Array.isArray(msg.content) ? msg.content : [msg.content];

    for (const block of contents) {
      const text = getBlockText(block as TextLikeBlock);
      if (typeof text !== "string") {
        continue;
      }

      // Find refs in this block (both inline tags and table rows)
      let match;
      while ((match = regex.exec(text)) !== null) {
        usedRefs.add(`REF_${match[1]}`);
      }
    }
  }

  // Filter ref table to only include used refs
  const cleanedRefTable: RefTable = {};
  for (const refId of Object.keys(refTable)) {
    if (usedRefs.has(refId)) {
      cleanedRefTable[refId] = refTable[refId];
    }
  }

  return cleanedRefTable;
}

/**
 * Serialize ref table to string for injection into context.
 */
export function serializeRefTable(refTable: RefTable, _config: DedupConfig): string {
  const lines: string[] = [];

  for (const [refId, content] of Object.entries(refTable)) {
    lines.push(`<¯REF_${refSuffix(refId)}= [${content}] END_REF¯>`);
  }

  return lines.join("\n");
}
