/**
 * Read-only associative context (Phase 3, 03-04). A compact, plugin-facing view of the
 * per-agent associative store: each topic box with its summary/state plus the tag and
 * entity labels linked to it. This is the single read surface the memory-core extension
 * consumes (via the `memory-core-host-associative` SDK seam) to augment search ranking;
 * it never writes. Keeping it to one function + one shape keeps the public SDK surface
 * narrow — callers do not get the raw row/store APIs.
 */
import { listMemoryAssociations, listMemoryEntities, listMemoryTags } from "./associative-store.js";
import { listBoxes, type BoxState } from "./turns-store.js";

export type AssociativeBoxContext = {
  boxId: string;
  topic: string | null;
  summary: string | null;
  state: BoxState;
  tags: string[];
  entities: string[];
};

export type AssociativeContext = {
  boxes: AssociativeBoxContext[];
};

/**
 * Read the associative context for one agent session. Tolerant of an empty store
 * (conversational memory off, or nothing captured yet) — returns no boxes rather than
 * throwing, so callers can treat it as best-effort enrichment.
 */
export function readAssociativeContext(options: {
  agentId: string;
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
}): AssociativeContext {
  const scope = { agentId: options.agentId, sessionKey: options.sessionKey };
  const dbOpts = options.env ? { ...scope, env: options.env } : scope;

  const boxes = listBoxes(dbOpts);
  if (boxes.length === 0) {
    // Fresh object every call: this is a public read surface, so a caller mutating one
    // empty result must not leak into a later empty read.
    return { boxes: [] };
  }

  const tagLabelById = new Map(listMemoryTags(dbOpts).map((tag) => [tag.tag_id, tag.label]));
  const entityLabelById = new Map(
    listMemoryEntities(dbOpts).map((entity) => [entity.entity_id, entity.label]),
  );

  // Box-targeted associations only; tag/entity links to spans/turns are out of scope here.
  const tagsByBox = new Map<string, Set<string>>();
  const entitiesByBox = new Map<string, Set<string>>();
  for (const assoc of listMemoryAssociations(dbOpts)) {
    if (assoc.target_type !== "box") {
      continue;
    }
    if (assoc.tag_id != null) {
      const label = tagLabelById.get(assoc.tag_id);
      if (label != null) {
        (tagsByBox.get(assoc.target_id) ?? setInMap(tagsByBox, assoc.target_id)).add(label);
      }
    }
    if (assoc.entity_id != null) {
      const label = entityLabelById.get(assoc.entity_id);
      if (label != null) {
        (entitiesByBox.get(assoc.target_id) ?? setInMap(entitiesByBox, assoc.target_id)).add(label);
      }
    }
  }

  return {
    boxes: boxes.map((box) => ({
      boxId: box.box_id,
      topic: box.label,
      summary: box.summary,
      state: box.state === "collapsed" ? "collapsed" : "live",
      tags: sortedFrom(tagsByBox.get(box.box_id)),
      entities: sortedFrom(entitiesByBox.get(box.box_id)),
    })),
  };
}

function setInMap(map: Map<string, Set<string>>, key: string): Set<string> {
  const set = new Set<string>();
  map.set(key, set);
  return set;
}

function sortedFrom(set: Set<string> | undefined): string[] {
  return set ? Array.from(set).toSorted() : [];
}
