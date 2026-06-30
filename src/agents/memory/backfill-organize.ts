/**
 * Offline organize stage (Phase 4, 04-02): turn the seeded `turns` history into navigable
 * spans/boxes/tags/entities by driving the EXISTING core producers — `segmentConversationTurns`
 * then `associateSegmentationTopics` + `associateConversationEntities` (D-05 reuse; no second
 * segmentation implementation). This required core step is what satisfies ROADMAP SC1
 * "searchable" for the backfill: after it runs, `listBoxes`/`listSpans` and the durable
 * tag/entity tables are populated for the historical session. All three producers upsert by
 * stable id, so re-running organize is idempotent (no duplicate spans/boxes).
 *
 * Dreaming is OPTIONAL/secondary (A2) and intentionally NOT wired here: the memory-core
 * dreaming sweep + retrieval indexing (RETR-01) lives in the `extensions/memory-core` plugin,
 * and core code must not import plugin internals (root AGENTS "Core/tests: no deep plugin
 * internals"). When that tier lands it owns its own checkpoint; this driver carries no flag
 * for it. Core segmentation + association alone makes history immediately navigable (SC1).
 */
import { normalizeAgentId } from "../../routing/session-key.js";
import { associateConversationEntities } from "./associate-entities.js";
import { associateSegmentationTopics } from "./associate-topics.js";
import { withEnv, writeOrganizeCursor } from "./backfill-cursor.js";
import { segmentConversationTurns } from "./segment-spans.js";

export type BackfillOrganizeResult = {
  sessionKey: string;
  segmented: boolean;
  spans: number;
  boxes: number;
};

/**
 * Organize the seeded history for the unified `agent:{agentId}:main` session. Idempotent:
 * safe to re-run after an interrupted backfill. Returns counts for progress reporting.
 */
export function runBackfillOrganize(options: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): BackfillOrganizeResult {
  const agentId = normalizeAgentId(options.agentId);
  const sessionKey = `agent:${agentId}:main`;
  const producerOpts = { agentId, sessionKey, ...withEnv(options.env) };

  const segmentation = segmentConversationTurns(producerOpts);
  associateSegmentationTopics({ ...producerOpts, segmentation });
  associateConversationEntities({ ...producerOpts, segmentation });

  writeOrganizeCursor({ agentId, sessionKey, ...withEnv(options.env), value: { segmented: true } });

  return {
    sessionKey,
    segmented: true,
    spans: segmentation.spans.length,
    boxes: segmentation.boxes.length,
  };
}
