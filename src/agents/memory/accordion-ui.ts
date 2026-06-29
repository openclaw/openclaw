/**
 * Accordion UI projection (Phase 2, 02-03-5): the read side that surfaces the durable
 * topic boxes (and their span seq-ranges) to the Control UI through chat.startup /
 * chat.history. The UI renders a per-topic collapse/expand control from `boxes` and
 * round-trips a toggle through the `accordion.toggle` gateway method. `spans` carry the
 * box → seq-range mapping for a later inline-fold consumer; both are read-only views of
 * the canonical store — the UI never mutates turns, only flips state via the gateway.
 */
import { listBoxes, listSpans } from "./turns-store.js";

export type AccordionBoxView = {
  id: string;
  label: string | null;
  state: "live" | "collapsed";
  summary: string | null;
};

export type AccordionSpanView = {
  boxId: string | null;
  startSeq: number;
  endSeq: number;
  topic: string | null;
};

export type AccordionView = {
  boxes: AccordionBoxView[];
  spans: AccordionSpanView[];
};

/** Project the per-agent store's boxes/spans into the UI-facing accordion shape. */
export function readAccordionView(scope: { agentId: string; sessionKey: string }): AccordionView {
  const boxes = listBoxes(scope).map((box) => ({
    id: box.box_id,
    label: box.label,
    state: box.state === "collapsed" ? ("collapsed" as const) : ("live" as const),
    summary: box.summary,
  }));
  const spans = listSpans(scope).map((span) => ({
    boxId: span.box_id,
    startSeq: span.start_seq,
    endSeq: span.end_seq,
    topic: span.topic,
  }));
  return { boxes, spans };
}
