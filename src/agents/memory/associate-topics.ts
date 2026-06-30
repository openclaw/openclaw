/**
 * Phase 3 (03-02) tag/association producer: map light-segmentation topic labels to
 * durable `memory_tags` and link them to the non-noise spans/boxes that own them.
 *
 * Deterministic and idempotent by construction: the tag id is content-derived from the
 * normalized topic, and the association id (in associative-store) is derived from the
 * target + tag, so re-running over unchanged segmentation output upserts the same rows
 * with no churn. Suppressed/noise spans carry no topic and are skipped.
 *
 * Tag DAG parent edges are intentionally NOT written here. Segmentation makes one box
 * per topic, so the only co-occurrence signal is cross-box and would over-connect the
 * graph; durable DAG normalization belongs to the later dreaming slice. Entities,
 * model rollups, and memory-core indexing are also later slices.
 */
import { createHash } from "node:crypto";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import { associateMemoryTag, listMemoryTags, upsertMemoryTag } from "./associative-store.js";
import type { SegmentationResult } from "./segment-spans.js";

function normalizeTopic(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Deterministic tag id for a topic label — stable across runs and sessions. */
export function topicTagId(label: string): string {
  const hash = createHash("sha256").update(normalizeTopic(label)).digest("hex").slice(0, 16);
  return `topic-${hash}`;
}

export type TopicAssociationResult = { tags: number; spanLinks: number; boxLinks: number };

/**
 * Upsert one durable tag per distinct non-noise topic in the segmentation result, then
 * associate that tag to every owning span and box. Pure I/O over the associative store;
 * the decision of what a topic is was already made by segmentation.
 */
export function associateSegmentationTopics(options: {
  agentId: string;
  sessionKey: string;
  segmentation: SegmentationResult;
  env?: NodeJS.ProcessEnv;
}): TopicAssociationResult {
  const dbOpts: OpenClawAgentDatabaseOptions = options.env
    ? { agentId: options.agentId, env: options.env }
    : { agentId: options.agentId };
  const sessionKey = options.sessionKey;

  // Load existing tag ids once: only insert genuinely new tags so a replay of unchanged
  // segmentation never bumps memory_tags.updated_at (no-churn). `existing` doubles as
  // the dedupe set for tags created earlier in this same pass.
  const existing = new Set(listMemoryTags(dbOpts).map((tag) => tag.tag_id));
  const tagIdByTopic = new Map<string, string>();
  const ensureTag = (label: string): string => {
    const cached = tagIdByTopic.get(label);
    if (cached) {
      return cached;
    }
    const tagId = topicTagId(label);
    if (!existing.has(tagId)) {
      upsertMemoryTag({ ...dbOpts, tag: { tagId, label } });
      existing.add(tagId);
    }
    tagIdByTopic.set(label, tagId);
    return tagId;
  };

  let spanLinks = 0;
  for (const span of options.segmentation.spans) {
    if (span.topic == null || span.noiseClass === "suppressed") {
      continue;
    }
    associateMemoryTag({
      ...dbOpts,
      tagId: ensureTag(span.topic),
      source: "agent",
      target: { type: "span", sessionKey, spanId: span.spanId },
    });
    spanLinks += 1;
  }

  let boxLinks = 0;
  for (const box of options.segmentation.boxes) {
    associateMemoryTag({
      ...dbOpts,
      tagId: ensureTag(box.label),
      source: "agent",
      target: { type: "box", sessionKey, boxId: box.boxId },
    });
    boxLinks += 1;
  }

  return { tags: tagIdByTopic.size, spanLinks, boxLinks };
}
