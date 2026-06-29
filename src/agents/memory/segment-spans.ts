/**
 * Phase 3 light segmentation producer: turns -> topic spans + recurring boxes.
 * This is deterministic and local; model rollups, tags/entities, embeddings, and
 * historical backfill are later Phase 3/4 slices.
 */
import { createHash } from "node:crypto";
import {
  SEGMENT_TOPIC_SIMILARITY_CUTOFF,
  SEGMENT_TOPIC_TOKEN_LIMIT,
} from "./accordion-constants.js";
import { isSuppressedMemoryNoise } from "./noise.js";
import {
  getTurns,
  listBoxes,
  type BoxRow,
  type TurnRow,
  upsertBox,
  upsertSpan,
} from "./turns-store.js";

type SegmentTurnLike = Pick<TurnRow, "seq" | "content" | "noise_class" | "channel" | "session_key">;

export type SegmentedSpan = {
  spanId: string;
  sessionKey: string;
  startSeq: number;
  endSeq: number;
  topic: string | null;
  boxId: string | null;
  noiseClass: string | null;
};

export type SegmentedBox = {
  boxId: string;
  sessionKey: string;
  label: string;
  summary: string;
  lastActiveSeq: number;
};

export type SegmentationResult = {
  spans: SegmentedSpan[];
  boxes: SegmentedBox[];
};

const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "but",
  "can",
  "for",
  "from",
  "have",
  "into",
  "just",
  "let",
  "now",
  "that",
  "the",
  "then",
  "this",
  "with",
  "you",
  "your",
]);

function stableId(prefix: string, parts: readonly (number | string | null)[]): string {
  const hash = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
  return `${prefix}-${hash}`;
}

function tokenize(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g);
  if (!tokens) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokens) {
    if (STOPWORDS.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    result.push(token);
  }
  return result;
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const bSet = new Set(b);
  let intersection = 0;
  for (const token of new Set(a)) {
    if (bSet.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function labelFromTokens(tokens: readonly string[]): string | null {
  if (tokens.length === 0) {
    return null;
  }
  return tokens.slice(0, SEGMENT_TOPIC_TOKEN_LIMIT).join("-");
}

function summarizeBox(label: string, turns: readonly SegmentTurnLike[]): string {
  const firstLine = turns
    .find((turn) => !isSuppressedMemoryNoise(turn))
    ?.content.trim()
    .split(/\r?\n/, 1)[0]
    ?.slice(0, 120);
  const suffix = turns.length === 1 ? "1 turn" : `${turns.length} turns`;
  return firstLine ? `${label}: ${firstLine} (${suffix})` : `${label}: ${suffix}`;
}

function spanId(sessionKey: string, startSeq: number, topic: string | null): string {
  return stableId("span", [sessionKey, startSeq, topic ?? "noise"]);
}

function boxId(sessionKey: string, topic: string): string {
  return stableId("box", [sessionKey, topic]);
}

export function segmentTurns(turns: readonly SegmentTurnLike[]): SegmentationResult {
  if (turns.length === 0) {
    return { spans: [], boxes: [] };
  }
  const orderedTurns = turns.toSorted((a, b) => a.seq - b.seq);
  const sessionKey = orderedTurns[0]?.session_key ?? "";
  const spans: SegmentedSpan[] = [];
  const boxTurns = new Map<string, SegmentTurnLike[]>();

  let current:
    | {
        startSeq: number;
        endSeq: number;
        topic: string | null;
        boxId: string | null;
        noiseClass: string | null;
        tokens: string[];
      }
    | undefined;

  const flush = () => {
    if (!current) {
      return;
    }
    spans.push({
      spanId: spanId(sessionKey, current.startSeq, current.topic),
      sessionKey,
      startSeq: current.startSeq,
      endSeq: current.endSeq,
      topic: current.topic,
      boxId: current.boxId,
      noiseClass: current.noiseClass,
    });
  };

  for (const turn of orderedTurns) {
    const suppressed = isSuppressedMemoryNoise(turn);
    const tokens = suppressed ? [] : tokenize(turn.content);
    const topic = suppressed ? null : labelFromTokens(tokens);
    const nextBoxId = topic ? boxId(sessionKey, topic) : null;
    const noiseClass = suppressed ? "suppressed" : null;
    const sameNoiseClass = current?.noiseClass === noiseClass;
    const sameTopic = current?.topic === topic;
    const similar =
      current != null &&
      topic != null &&
      current.topic != null &&
      jaccard(current.tokens, tokens) >= SEGMENT_TOPIC_SIMILARITY_CUTOFF;
    const continues = current != null && sameNoiseClass && (sameTopic || similar);
    if (!continues) {
      flush();
      current = {
        startSeq: turn.seq,
        endSeq: turn.seq,
        topic,
        boxId: nextBoxId,
        noiseClass,
        tokens,
      };
    } else if (current != null) {
      current.endSeq = turn.seq;
      current.tokens = Array.from(new Set([...current.tokens, ...tokens]));
    }
    if (topic && nextBoxId) {
      const turnsForBox = boxTurns.get(nextBoxId) ?? [];
      turnsForBox.push(turn);
      boxTurns.set(nextBoxId, turnsForBox);
    }
  }
  flush();

  const boxes = Array.from(boxTurns.entries()).map(([id, turnsForBox]) => {
    const label = spans.find((span) => span.boxId === id)?.topic ?? id;
    return {
      boxId: id,
      sessionKey,
      label,
      summary: summarizeBox(label, turnsForBox),
      lastActiveSeq: Math.max(...turnsForBox.map((turn) => turn.seq)),
    };
  });
  return { spans, boxes };
}

export function segmentConversationTurns(options: {
  agentId: string;
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
}): SegmentationResult {
  const dbOpts = options.env
    ? { agentId: options.agentId, sessionKey: options.sessionKey, env: options.env }
    : { agentId: options.agentId, sessionKey: options.sessionKey };
  const turns = getTurns(dbOpts);
  const result = segmentTurns(turns);
  const existingBoxes = new Set(listBoxes(dbOpts).map((box: BoxRow) => box.box_id));
  for (const box of result.boxes) {
    if (existingBoxes.has(box.boxId)) {
      continue;
    }
    upsertBox({
      ...dbOpts,
      box: {
        boxId: box.boxId,
        sessionKey: box.sessionKey,
        label: box.label,
        state: "live",
        summary: box.summary,
        lastActiveSeq: box.lastActiveSeq,
      },
    });
  }
  for (const span of result.spans) {
    upsertSpan({
      ...dbOpts,
      span: {
        spanId: span.spanId,
        sessionKey: span.sessionKey,
        startSeq: span.startSeq,
        endSeq: span.endSeq,
        topic: span.topic,
        boxId: span.boxId,
        noiseClass: span.noiseClass,
      },
    });
  }
  return result;
}
