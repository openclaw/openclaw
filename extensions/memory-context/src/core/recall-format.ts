/**
 * Recall Format -- formats recalled content for injection into model context.
 *
 * Two blocks:
 * - <knowledge>: extracted facts (compact, low token)
 * - <detail>: raw message fragments (preserves code/formatting)
 *
 * Respects hardCapTokens via enforceHardCap from runtime.
 */

import type { KnowledgeFact } from "./knowledge-store.js";
import { estimateTokens, enforceHardCap } from "./runtime.js";
import type { ConversationSegment } from "./store.js";

export type RecallResult = {
  /** Formatted XML block ready for context injection. Empty string = nothing to inject. */
  block: string;
  /** Total estimated tokens of the injected block. */
  tokens: number;
  /** Number of knowledge facts included. */
  knowledgeCount: number;
  /** Number of raw detail segments included. */
  detailCount: number;
};

/**
 * Format knowledge facts into a <knowledge> block.
 * Groups by type, one fact per line.
 */
function formatKnowledgeBlock(facts: KnowledgeFact[]): string {
  if (facts.length === 0) {
    return "";
  }

  const lines = facts.map((f) => `- [${f.type}] ${f.content}`);
  return `<knowledge>\n${lines.join("\n")}\n</knowledge>`;
}

/**
 * Format raw detail segments into a <detail> block.
 * Preserves original formatting (no whitespace collapsing).
 */
function formatDetailBlock(
  segments: Array<{ segment: ConversationSegment; score: number }>,
): string {
  if (segments.length === 0) {
    return "";
  }

  // Sort by timestamp (oldest first) to preserve conversation flow
  const sorted = [...segments].toSorted((a, b) => a.segment.timestamp - b.segment.timestamp);

  const lines = sorted.map((s) => {
    const when = new Date(s.segment.timestamp).toISOString().slice(0, 16).replace("T", " ");
    // Preserve original content formatting -- do NOT collapse whitespace
    return `[${when} ${s.segment.role}] ${s.segment.content}`;
  });

  return `<detail>\n${lines.join("\n\n")}\n</detail>`;
}

/**
 * Build the complete recalled-context block for injection.
 *
 * @param knowledge - Matched knowledge facts (already filtered by query relevance)
 * @param details - Raw segments from hybrid search (already filtered by minScore)
 * @param hardCap - Maximum tokens for the entire block
 */
export function buildRecalledContextBlock(
  knowledge: KnowledgeFact[],
  details: Array<{ segment: ConversationSegment; score: number }>,
  hardCap: number,
): RecallResult {
  if (knowledge.length === 0 && details.length === 0) {
    return { block: "", tokens: 0, knowledgeCount: 0, detailCount: 0 };
  }

  // Budget: knowledge gets 30%, detail gets 70%
  const knowledgeBudget = Math.floor(hardCap * 0.3);
  const detailBudget = hardCap - knowledgeBudget;

  // Apply hard cap to knowledge facts
  const knowledgeWithScores = knowledge.map((f) => ({
    content: `- [${f.type}] ${f.content}`,
    score: 1.0, // knowledge facts are pre-filtered, treat as equally important
  }));
  const cappedKnowledge = enforceHardCap(knowledgeWithScores, knowledgeBudget);
  // Match back by content identity (not position, since enforceHardCap sorts by score)
  const cappedContents = new Set(cappedKnowledge.map((k) => k.content));
  const includedKnowledge = knowledge.filter((f) =>
    cappedContents.has(`- [${f.type}] ${f.content}`),
  );

  // Apply hard cap to detail segments
  const detailWithScores = details.map((d) => ({
    id: d.segment.id,
    content: d.segment.content,
    score: d.score,
  }));
  const cappedDetails = enforceHardCap(detailWithScores, detailBudget);
  // Map back to original segments by id (unique) instead of content (may duplicate)
  const includedDetails = cappedDetails
    .map((cd) => details.find((d) => d.segment.id === cd.id))
    .filter(Boolean) as typeof details;

  // Build blocks
  const knowledgeBlock = formatKnowledgeBlock(includedKnowledge);
  const detailBlock = formatDetailBlock(includedDetails);

  const parts: string[] = [];
  if (knowledgeBlock) {
    parts.push(knowledgeBlock);
  }
  if (detailBlock) {
    parts.push(detailBlock);
  }

  if (parts.length === 0) {
    return { block: "", tokens: 0, knowledgeCount: 0, detailCount: 0 };
  }

  const block = `<recalled-context source="memory-context">\n\n${parts.join("\n\n")}\n\n</recalled-context>`;
  const tokens = estimateTokens(block);

  // Final hard cap check: rebuild block after each pop until within budget
  if (tokens > hardCap) {
    while (includedDetails.length > 0) {
      includedDetails.pop();
      const rebuiltDetail = formatDetailBlock(includedDetails);
      const rebuiltParts: string[] = [];
      if (knowledgeBlock) {
        rebuiltParts.push(knowledgeBlock);
      }
      if (rebuiltDetail) {
        rebuiltParts.push(rebuiltDetail);
      }
      if (rebuiltParts.length === 0) {
        return { block: "", tokens: 0, knowledgeCount: 0, detailCount: 0 };
      }
      const rebuiltBlock = `<recalled-context source="memory-context">\n\n${rebuiltParts.join("\n\n")}\n\n</recalled-context>`;
      if (estimateTokens(rebuiltBlock) <= hardCap) {
        return {
          block: rebuiltBlock,
          tokens: estimateTokens(rebuiltBlock),
          knowledgeCount: includedKnowledge.length,
          detailCount: includedDetails.length,
        };
      }
    }
    // All details removed, try knowledge-only
    if (knowledgeBlock) {
      const knowledgeOnly = `<recalled-context source="memory-context">\n\n${knowledgeBlock}\n\n</recalled-context>`;
      if (estimateTokens(knowledgeOnly) <= hardCap) {
        return {
          block: knowledgeOnly,
          tokens: estimateTokens(knowledgeOnly),
          knowledgeCount: includedKnowledge.length,
          detailCount: 0,
        };
      }
    }
    return { block: "", tokens: 0, knowledgeCount: 0, detailCount: 0 };
  }

  return {
    block,
    tokens,
    knowledgeCount: includedKnowledge.length,
    detailCount: includedDetails.length,
  };
}
