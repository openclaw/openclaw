/**
 * Read-only tag co-occurrence traversal for agents. Given a tag id or label,
 * return neighboring tags ranked by shared durable targets, plus the target
 * refs at each intersection so callers can hop without knowing the SQL schema.
 */
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import { listMemoryAssociations, listMemoryTags } from "./associative-store.js";

export type TagGraphTargetRef = {
  targetId: string;
  targetType: "box" | "span" | "turn";
};

export type TagGraphNeighbor = {
  tagId: string;
  label: string;
  weight: number;
  targets: TagGraphTargetRef[];
};

export type TagGraphTraversal = {
  tag: { tagId: string; label: string } | null;
  neighbors: TagGraphNeighbor[];
};

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

function targetKey(target: TagGraphTargetRef): string {
  return `${target.targetType}:${target.targetId}`;
}

function compareTargets(a: TagGraphTargetRef, b: TagGraphTargetRef): number {
  return targetKey(a).localeCompare(targetKey(b));
}

function resolveTag(
  tags: ReturnType<typeof listMemoryTags>,
  tag: string,
): { tagId: string; label: string } | null {
  const trimmed = tag.trim();
  if (!trimmed) {
    return null;
  }
  const byId = tags.find((candidate) => candidate.tag_id === trimmed);
  if (byId) {
    return { tagId: byId.tag_id, label: byId.label };
  }
  const normalized = normalizeLabel(trimmed);
  const byLabel = tags.find((candidate) => candidate.normalized_label === normalized);
  return byLabel ? { tagId: byLabel.tag_id, label: byLabel.label } : null;
}

export function readTagCooccurrence(
  options: OpenClawAgentDatabaseOptions & {
    limit?: number;
    sessionKey: string;
    tag: string;
  },
): TagGraphTraversal {
  const tags = listMemoryTags(options);
  const center = resolveTag(tags, options.tag);
  if (center == null) {
    return { tag: null, neighbors: [] };
  }

  const labelByTagId = new Map(tags.map((tag) => [tag.tag_id, tag.label]));
  const targetKeysForCenter = new Set<string>();
  const targetByKey = new Map<string, TagGraphTargetRef>();
  const tagIdsByTargetKey = new Map<string, Set<string>>();

  for (const assoc of listMemoryAssociations(options)) {
    if (assoc.tag_id == null) {
      continue;
    }
    const target = {
      targetId: assoc.target_id,
      targetType: assoc.target_type as TagGraphTargetRef["targetType"],
    };
    const key = targetKey(target);
    targetByKey.set(key, target);
    const tagIds = tagIdsByTargetKey.get(key) ?? new Set<string>();
    tagIds.add(assoc.tag_id);
    tagIdsByTargetKey.set(key, tagIds);
    if (assoc.tag_id === center.tagId) {
      targetKeysForCenter.add(key);
    }
  }

  const targetsByNeighborTagId = new Map<string, Map<string, TagGraphTargetRef>>();
  for (const key of targetKeysForCenter) {
    const target = targetByKey.get(key);
    if (!target) {
      continue;
    }
    for (const tagId of tagIdsByTargetKey.get(key) ?? []) {
      if (tagId === center.tagId) {
        continue;
      }
      const targets = targetsByNeighborTagId.get(tagId) ?? new Map<string, TagGraphTargetRef>();
      targets.set(key, target);
      targetsByNeighborTagId.set(tagId, targets);
    }
  }

  const limit = options.limit == null ? undefined : Math.max(0, Math.floor(options.limit));
  const neighbors = Array.from(targetsByNeighborTagId.entries())
    .map(([tagId, targets]) => ({
      tagId,
      label: labelByTagId.get(tagId) ?? tagId,
      weight: targets.size,
      targets: Array.from(targets.values()).toSorted(compareTargets),
    }))
    .toSorted((a, b) => b.weight - a.weight || a.label.localeCompare(b.label));

  return { tag: center, neighbors: limit == null ? neighbors : neighbors.slice(0, limit) };
}
