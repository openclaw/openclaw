/**
 * Accordion context extension (Phase 2, 02-02): the core "context" hook that folds
 * collapsed-topic turns out of the model's context. Registered by
 * buildEmbeddedExtensionFactories when conversationalMemory is enabled. Reads the
 * per-agent store fresh each context event (the box state is canonical and changes as
 * topics collapse/expand — this is live state, not freshness polling of static metadata).
 *
 * Mapping: each live message → its durable per-message anchor → captured turn (seq) →
 * span → box. Collapsed boxes drive the fold plan (accordion-seq-walk), applied in place
 * (accordion-blocks.applyFold). Returns undefined (passthrough) when nothing is collapsed.
 */
import type { AgentMessage } from "../runtime/index.js";
import type { ContextEvent, ExtensionAPI, ExtensionFactory } from "../sessions/index.js";
import { applyFold, messageAnchorId } from "./accordion-blocks.js";
import { type AnchorBox, buildAccordionFoldPlan } from "./accordion-seq-walk.js";
import { applyAutoCollapse } from "./active-tag-set.js";
import { turnIdempotencyKey } from "./turns-capture.js";
import { getTurns, listBoxes, listSpans } from "./turns-store.js";

/**
 * Resolve each live message's collapsed/live box. Returns null (skip everything) when no
 * box is collapsed, so the common case avoids the heavier turn/span reads.
 */
function resolveAnchorBoxes(
  agentId: string,
  sessionKey: string,
  messages: readonly AgentMessage[],
): Map<string, AnchorBox> | null {
  const boxes = listBoxes({ agentId, sessionKey });
  if (!boxes.some((box) => box.state === "collapsed")) {
    return null;
  }
  const boxById = new Map(boxes.map((box) => [box.box_id, box]));
  const spans = listSpans({ agentId, sessionKey });
  const seqToBoxId = (seq: number): string | null => {
    const span = spans.find((s) => s.start_seq <= seq && seq <= s.end_seq);
    return span?.box_id ?? null;
  };
  const keyToSeq = new Map(
    getTurns({ agentId, sessionKey }).map((turn) => [turn.idempotency_key, turn.seq]),
  );

  const anchorToBox = new Map<string, AnchorBox>();
  for (const message of messages) {
    const key = turnIdempotencyKey(sessionKey, message);
    if (key == null) {
      continue;
    }
    const seq = keyToSeq.get(key);
    if (seq == null) {
      continue;
    }
    const boxId = seqToBoxId(seq);
    if (boxId == null) {
      continue;
    }
    const box = boxById.get(boxId);
    const anchor = messageAnchorId(message);
    if (box == null || anchor == null) {
      continue;
    }
    anchorToBox.set(anchor, {
      boxId: box.box_id,
      state: box.state === "collapsed" ? "collapsed" : "live",
      summary: box.summary,
    });
  }
  return anchorToBox;
}

export function conversationalMemoryAccordionExtension(opts: {
  agentId: string;
  sessionKey: string;
}): ExtensionFactory {
  return (api: ExtensionAPI) => {
    api.on("context", (event: ContextEvent) => {
      let anchorToBox: Map<string, AnchorBox> | null;
      try {
        // Run the active-tag-set rule first (spec §16: collapse decision in the
        // context-pruning seam) so any newly-stale topic is folded out this turn.
        applyAutoCollapse({ agentId: opts.agentId, sessionKey: opts.sessionKey });
        anchorToBox = resolveAnchorBoxes(opts.agentId, opts.sessionKey, event.messages);
      } catch (err) {
        // Never break a model call over the accordion; fall through to verbatim context.
        console.warn(
          `[conversational-memory] accordion fold skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
      if (anchorToBox == null) {
        return undefined;
      }
      const plan = buildAccordionFoldPlan(event.messages, anchorToBox);
      if (plan.size === 0) {
        return undefined;
      }
      return { messages: applyFold(event.messages, plan) };
    });
  };
}
