import type { StreamEvent } from "./mock-openai-contracts.js";
import { buildAssistantEvents } from "./mock-openai-events.js";

// Paced markdown reply for client UX harnesses (iOS `ios:behavior`). The prompt picks the
// shape: `UXSTREAM chunks=400 interval=50` streams 400 deltas, 50 ms apart. The token is one
// capitalized word because phone keyboards autocorrect lowercase phrases typed by UI drivers.
const QA_UX_STREAM_PROMPT_RE = /\bUXSTREAM\b/;
export const QA_UX_STREAM_END_MARKER = "UX-STREAM-END";

const DEFAULT_CHUNKS = 200;
const MAX_CHUNKS = 2_000;
const DEFAULT_INTERVAL_MS = 50;
const MAX_INTERVAL_MS = 2_000;
const CHARS_PER_CHUNK = 24;

const WORDS = [
  "gateway",
  "session",
  "transcript",
  "streams",
  "steady",
  "rows",
  "anchor",
  "composer",
  "reader",
  "scroll",
  "layout",
  "frame",
  "token",
  "message",
  "agent",
  "reply",
];

export type QaUxStream = {
  events: StreamEvent[];
  deltaIntervalMs: number;
};

export function resolveQaUxStream(prompt: string): QaUxStream | undefined {
  if (!QA_UX_STREAM_PROMPT_RE.test(prompt)) {
    return undefined;
  }
  const chunkCount = readIntOption(prompt, "chunks", DEFAULT_CHUNKS, 1, MAX_CHUNKS);
  const deltaIntervalMs = readIntOption(
    prompt,
    "interval",
    DEFAULT_INTERVAL_MS,
    0,
    MAX_INTERVAL_MS,
  );
  const text = buildUxStreamText(chunkCount * CHARS_PER_CHUNK);
  return {
    events: buildAssistantEvents([
      {
        id: "msg_mock_ux_stream",
        phase: "final_answer",
        streamDeltas: splitIntoChunks(text, chunkCount),
        text,
      },
    ]),
    deltaIntervalMs,
  };
}

function readIntOption(prompt: string, name: string, fallback: number, min: number, max: number) {
  const raw = new RegExp(`\\b${name}=(\\d+)`, "i").exec(prompt)?.[1];
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10);
  return Math.min(max, Math.max(min, value));
}

// Mixed markdown (headings, paragraphs, lists, fenced code) so streaming exercises the block
// shapes that change height when they close.
function buildUxStreamText(targetLength: number) {
  const blocks: string[] = [];
  let length = 0;
  let wordIndex = 0;
  const words = (count: number) =>
    Array.from({ length: count }, () => WORDS[wordIndex++ % WORDS.length]).join(" ");
  for (let section = 1; length < targetLength; section += 1) {
    const sectionBlocks = [
      `## Section ${section}`,
      `${words(14)}. ${words(11)}. ${words(9)}.`,
      [`- ${words(5)}`, `- ${words(7)}`, `- ${words(4)}`].join("\n"),
      ...(section % 2 === 0
        ? [["```swift", `let ${WORDS[section % WORDS.length]} = ${section}`, "```"].join("\n")]
        : []),
    ];
    blocks.push(...sectionBlocks);
    length += sectionBlocks.join("\n\n").length + 2;
  }
  return `${blocks.join("\n\n")}\n\n${QA_UX_STREAM_END_MARKER}`;
}

function splitIntoChunks(text: string, chunkCount: number) {
  const size = Math.max(1, Math.ceil(text.length / chunkCount));
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}
