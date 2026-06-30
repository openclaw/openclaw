/**
 * Phase 3 (03-03) local entity producer: extract conservative named entities from the
 * turns inside each non-noise span and link them to that span and its box, so a
 * recurring subject (a case, vendor, account, code) becomes a first-class recall key
 * across non-contiguous ranges.
 *
 * Deterministic light pass — lexical heuristics only, no model:
 *   - "code": all-caps/alphanumeric tokens with a digit or length >= 2 (NEBULA-73, API).
 *   - "proper_noun": runs of 2+ consecutive Title-Case words, after trimming leading/
 *     trailing function words (so sentence-initial words alone never qualify).
 * High precision is the goal; the dreaming slice can widen recall later. Entities are
 * local-only. Entity id is content-derived from (type, normalized label), and existing
 * entities are never re-upserted, so replaying unchanged turns writes no new rows and
 * does not bump memory_entities.updated_at. Suppressed/noise spans contribute nothing.
 */
import { createHash } from "node:crypto";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import {
  associateMemoryEntity,
  listMemoryEntities,
  upsertMemoryEntity,
} from "./associative-store.js";
import { isSuppressedMemoryNoise } from "./noise.js";
import type { SegmentationResult } from "./segment-spans.js";
import { getTurns } from "./turns-store.js";

export type EntityType = "code" | "proper_noun";
export type ExtractedEntity = { label: string; type: EntityType };

// Capitalized words that carry no entity meaning on their own; trimmed from the edges
// of a Title-Case run so "We Should Ship Memory" yields "Ship Memory", and a lone
// sentence-initial "The" never anchors an entity.
const CAP_FUNCTION_WORDS = new Set([
  "A",
  "An",
  "And",
  "Are",
  "As",
  "At",
  "Be",
  "Been",
  "But",
  "By",
  "Can",
  "Could",
  "Did",
  "Do",
  "Does",
  "For",
  "From",
  "He",
  "I",
  "If",
  "In",
  "Into",
  "Is",
  "It",
  "May",
  "Might",
  "Must",
  "My",
  "Nor",
  "Of",
  "On",
  "Or",
  "Our",
  "She",
  "Should",
  "So",
  "Than",
  "That",
  "The",
  "Their",
  "Then",
  "These",
  "They",
  "This",
  "Those",
  "To",
  "Was",
  "We",
  "Were",
  "When",
  "While",
  "Will",
  "With",
  "Would",
  "You",
  "Your",
]);

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Deterministic entity id for a (type, label) pair — stable across runs and sessions. */
export function entityIdFor(label: string, type: EntityType): string {
  const hash = createHash("sha256")
    .update(`${type}|${normalizeLabel(label)}`)
    .digest("hex");
  return `entity-${hash.slice(0, 16)}`;
}

function isCodeToken(word: string): boolean {
  if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(word)) {
    return false;
  }
  if (!/[A-Z]/.test(word)) {
    return false; // pure digits ("73") are not entities
  }
  return word.replace(/-/g, "").length >= 2;
}

function isTitleWord(word: string): boolean {
  // First letter upper, remainder lower/digits — excludes all-caps codes (handled above).
  return /^[A-Z][a-z0-9]*$/.test(word);
}

/** Extract conservative entities from one text, deduped by (type, normalized label). */
export function extractEntities(text: string): ExtractedEntity[] {
  const words = text
    .split(/\s+/)
    .map((word) => word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
    .filter(Boolean);

  const found = new Map<string, ExtractedEntity>();
  const add = (entity: ExtractedEntity) => {
    found.set(`${entity.type}|${normalizeLabel(entity.label)}`, entity);
  };

  // Title-Case runs → proper nouns; standalone codes anywhere → codes.
  let run: string[] = [];
  const flushRun = () => {
    let start = 0;
    let end = run.length;
    while (start < end && CAP_FUNCTION_WORDS.has(run[start])) {
      start += 1;
    }
    while (end > start && CAP_FUNCTION_WORDS.has(run[end - 1])) {
      end -= 1;
    }
    const trimmed = run.slice(start, end);
    if (trimmed.length >= 2) {
      add({ label: trimmed.join(" "), type: "proper_noun" });
    }
    run = [];
  };
  for (const word of words) {
    if (isCodeToken(word)) {
      add({ label: word, type: "code" });
      flushRun();
      continue;
    }
    if (isTitleWord(word)) {
      run.push(word);
      continue;
    }
    flushRun();
  }
  flushRun();

  return Array.from(found.values());
}

export type EntityAssociationResult = { entities: number; spanLinks: number; boxLinks: number };

/**
 * Extract entities from the turns of every non-noise span and associate them to the
 * span and its box. The same entity recurring in two spans links both (and both boxes),
 * which is how a subject becomes recallable across non-contiguous ranges.
 */
export function associateConversationEntities(options: {
  agentId: string;
  sessionKey: string;
  segmentation: SegmentationResult;
  env?: NodeJS.ProcessEnv;
}): EntityAssociationResult {
  const dbOpts: OpenClawAgentDatabaseOptions = options.env
    ? { agentId: options.agentId, env: options.env }
    : { agentId: options.agentId };
  const sessionKey = options.sessionKey;

  // getTurns is session-scoped; the associative writers key off the target's sessionKey.
  const turnBySeq = new Map(getTurns({ ...dbOpts, sessionKey }).map((turn) => [turn.seq, turn]));
  // Existing ids loaded once: only insert genuinely new entities so replay never bumps
  // updated_at (mirrors the 03-02 tag no-churn rule).
  const existing = new Set(listMemoryEntities(dbOpts).map((entity) => entity.entity_id));

  const distinctEntities = new Set<string>();
  const spanAssoc = new Set<string>();
  const boxAssoc = new Set<string>();

  for (const span of options.segmentation.spans) {
    if (span.topic == null || span.noiseClass === "suppressed") {
      continue;
    }
    const inSpan = new Map<string, ExtractedEntity>();
    for (let seq = span.startSeq; seq <= span.endSeq; seq += 1) {
      const turn = turnBySeq.get(seq);
      if (!turn || isSuppressedMemoryNoise(turn)) {
        continue;
      }
      for (const entity of extractEntities(turn.content)) {
        inSpan.set(entityIdFor(entity.label, entity.type), entity);
      }
    }
    for (const [entityId, entity] of inSpan) {
      if (!existing.has(entityId)) {
        upsertMemoryEntity({
          ...dbOpts,
          entity: { entityId, type: entity.type, label: entity.label },
        });
        existing.add(entityId);
      }
      distinctEntities.add(entityId);
      associateMemoryEntity({
        ...dbOpts,
        entityId,
        source: "agent",
        target: { type: "span", sessionKey, spanId: span.spanId },
      });
      spanAssoc.add(`${span.spanId}|${entityId}`);
      if (span.boxId != null) {
        associateMemoryEntity({
          ...dbOpts,
          entityId,
          source: "agent",
          target: { type: "box", sessionKey, boxId: span.boxId },
        });
        boxAssoc.add(`${span.boxId}|${entityId}`);
      }
    }
  }

  return { entities: distinctEntities.size, spanLinks: spanAssoc.size, boxLinks: boxAssoc.size };
}
