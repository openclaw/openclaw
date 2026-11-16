import type { StreamEvent } from "./mock-openai-contracts.js";
import { buildAssistantEvents, buildAssistantThenToolCallEvents } from "./mock-openai-events.js";

// Paced markdown reply for client UX harnesses (iOS `ios:behavior`). The prompt picks the
// shape: `UXSTREAM chunks=400 interval=50` streams 400 deltas, 50 ms apart. The token is one
// capitalized word because phone keyboards autocorrect lowercase phrases typed by UI drivers.
// `UXAGENT steps=4 chunks=150 interval=20` is an agent turn instead: `steps` rounds of commentary
// plus a tool call (progress card updates alternating with `exec`), then the same final reply.
// Plain replies never showed tool rows or a progress card, and the iOS transcript only went
// blank after a keyboard-up send in a turn shaped like this (#191478).
const QA_UX_STREAM_PROMPT_RE = /\bUXSTREAM\b/;
const QA_UX_AGENT_PROMPT_RE = /\bUXAGENT\b/;
const QA_UX_STREAM_END_MARKER = "UX-STREAM-END";
const MAX_AGENT_STEPS = 8;

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

/** `completedToolCalls`: tool results already in the current turn, so an agent turn knows its round. */
export function resolveQaUxStream(prompt: string, completedToolCalls = 0): QaUxStream | undefined {
  const agent = QA_UX_AGENT_PROMPT_RE.test(prompt);
  if (!agent && !QA_UX_STREAM_PROMPT_RE.test(prompt)) {
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
  const steps = agent ? readIntOption(prompt, "steps", 4, 1, MAX_AGENT_STEPS) : 0;
  if (completedToolCalls < steps) {
    return { events: buildAgentStepEvents(completedToolCalls, steps), deltaIntervalMs: 0 };
  }
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

function buildAgentStepEvents(step: number, steps: number) {
  const commentary = {
    id: `msg_mock_ux_agent_${step}`,
    phase: "commentary" as const,
    text: `Step ${step + 1} of ${steps}: checking the ${WORDS[step % WORDS.length]} before the next ${WORDS[(step + 5) % WORDS.length]}.`,
  };
  if (step % 2 === 1) {
    return buildAssistantThenToolCallEvents(commentary, "exec", {
      command: `echo ux-agent-step-${step + 1}`,
    });
  }
  const plan = Array.from({ length: steps }, (_, index) => ({
    step: `Check ${WORDS[index % WORDS.length]} ${index + 1}`,
    status: index < step ? "completed" : index === step ? "in_progress" : "pending",
  }));
  return buildAssistantThenToolCallEvents(commentary, "progress_card", { plan });
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
