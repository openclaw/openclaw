/**
 * Accordion seq-walk (Phase 2, 02-02): pure function from live messages + collapsed-box
 * state to a kind-safe FoldPlan (consumed by accordion-blocks.applyFold). No I/O — the
 * caller (accordion-extension) resolves each message's box from the per-agent store.
 *
 * Rules (spec §6.6): walk messages in array order; for a message whose box is collapsed,
 * fold its body. Each collapsed box emits its summary EXACTLY ONCE (on the first folded
 * message encountered); later turns of the same box fold to a short marker so the whole
 * topic costs one summary + cheap stubs while every message (and tool pair) stays in place.
 */
import type { AgentMessage } from "../runtime/index.js";
import { blockId, isDurableId, messageAnchorId } from "./accordion-blocks.js";

/** Box state for one captured turn's anchor, as resolved from spans/boxes. */
export type AnchorBox = {
  boxId: string;
  state: "live" | "collapsed";
  summary: string | null;
};

/** Stub for the 2nd+ folded message of a collapsed box (summary is emitted once, first). */
export const FOLDED_MARKER = "[folded]";

function summaryDigest(box: AnchorBox): string {
  return box.summary && box.summary.trim() ? box.summary : `[folded topic ${box.boxId}]`;
}

/** Fold every foldable part of one message: first part carries `digest`, the rest a marker. */
function foldMessageInto(
  plan: Map<string, string>,
  message: AgentMessage,
  index: number,
  digest: string,
): void {
  const m = message as { role?: string; content?: unknown };
  if (m.role === "assistant" && Array.isArray(m.content)) {
    let emittedHead = false;
    m.content.forEach((part, partIndex) => {
      // tool_call parts are structural (folding one orphans its result) — skip.
      if ((part as { type?: string }).type === "toolCall") {
        return;
      }
      const id = blockId(message, index, partIndex);
      if (!isDurableId(id)) {
        return;
      }
      plan.set(id, emittedHead ? FOLDED_MARKER : digest);
      emittedHead = true;
    });
    return;
  }
  const id = blockId(message, index);
  if (isDurableId(id)) {
    plan.set(id, digest);
  }
}

/**
 * Build the fold plan for the current context. `anchorToBox` maps each captured turn's
 * per-message anchor (messageAnchorId) to its box; messages with no entry, or whose box
 * is live, are left verbatim.
 */
export function buildAccordionFoldPlan(
  messages: readonly AgentMessage[],
  anchorToBox: ReadonlyMap<string, AnchorBox>,
): Map<string, string> {
  const plan = new Map<string, string>();
  if (anchorToBox.size === 0) {
    return plan;
  }
  const emittedSummaries = new Set<string>();
  messages.forEach((message, index) => {
    const anchor = messageAnchorId(message);
    if (anchor == null) {
      return;
    }
    const box = anchorToBox.get(anchor);
    if (!box || box.state !== "collapsed") {
      return;
    }
    const first = !emittedSummaries.has(box.boxId);
    emittedSummaries.add(box.boxId);
    foldMessageInto(plan, message, index, first ? summaryDigest(box) : FOLDED_MARKER);
  });
  return plan;
}
