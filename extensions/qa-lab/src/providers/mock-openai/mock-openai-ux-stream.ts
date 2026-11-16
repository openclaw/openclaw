import type { MockToolCallItem, ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { hasToolErrorOutput } from "./mock-openai-directives.js";
import { buildAssistantEvents } from "./mock-openai-events.js";
import {
  countCurrentToolOutputs,
  extractToolOutput,
  extractToolOutputStructuredError,
  parseToolOutputJson,
} from "./mock-openai-input.js";
import { MockResponseStream } from "./mock-openai-stream.js";
import {
  buildScenarioToolCallEvents,
  resolveCodeModeExecSurface,
} from "./mock-openai-tool-routing.js";

// Paced markdown reply for client UX harnesses (iOS `ios:behavior`). The prompt picks the
// shape: `UXSTREAM chunks=400 interval=50` streams 400 deltas, 50 ms apart. The token is one
// capitalized word because phone keyboards autocorrect lowercase phrases typed by UI drivers.
// `UXAGENT steps=4 chunks=150 interval=20` is an agent turn instead: `steps` rounds of commentary
// plus a tool call (progress card updates alternating with `exec`), then the same final reply.
// Plain replies never showed tool rows or a progress card, and the iOS transcript only went
// blank after a keyboard-up send in a turn shaped like this (#191478). Tool calls go through the
// request's declared tool surface (direct, dispatcher or code mode), and a failed step ends the
// turn with `UX-AGENT-TOOL-FAILED` instead of the reply, so a harness never passes on error rows.
const QA_UX_AGENT_TOOL_FAILED = "UX-AGENT-TOOL-FAILED";
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

/**
 * `input`: the request's items, for how far the current agent turn has got and whether its last
 * tool step failed. `toolBody`: the request's tool declaration surface, to route tool calls.
 */
export function resolveQaUxStream(
  prompt: string,
  input: ResponsesInputItem[],
  toolBody: Record<string, unknown>,
): QaUxStream | undefined {
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
  const completed = agent ? countCurrentToolOutputs(input) : 0;
  if (completed > 0) {
    const output = extractToolOutput(input);
    const failed =
      extractToolOutputStructuredError(input) ??
      hasToolErrorOutput(parseToolOutputJson(output), output);
    if (failed) {
      return { events: buildAssistantEvents(QA_UX_AGENT_TOOL_FAILED), deltaIntervalMs: 0 };
    }
  }
  if (completed < steps) {
    return { events: buildAgentStepEvents(completed, steps, toolBody), deltaIntervalMs: 0 };
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

function buildAgentStepEvents(step: number, steps: number, toolBody: Record<string, unknown>) {
  const commentary = {
    id: `msg_mock_ux_agent_${step}`,
    phase: "commentary" as const,
    text: `Step ${step + 1} of ${steps}: checking the ${WORDS[step % WORDS.length]} before the next ${WORDS[(step + 5) % WORDS.length]}.`,
  };
  const plan = Array.from({ length: steps }, (_, index) => ({
    step: `Check ${WORDS[index % WORDS.length]} ${index + 1}`,
    status: index < step ? "completed" : index === step ? "in_progress" : "pending",
  }));
  const marker = `ux-agent-step-${step + 1}`;
  // Code mode's `exec` runs a script, not a shell command.
  const surface = resolveCodeModeExecSurface(toolBody);
  const execArgs =
    surface === "native"
      ? { input: `text(${JSON.stringify(marker)});` }
      : surface === "guest"
        ? { code: `return ${JSON.stringify(marker)};` }
        : { command: `echo ${marker}` };
  const toolEvents =
    step % 2 === 1
      ? buildScenarioToolCallEvents(toolBody, "exec", execArgs)
      : buildScenarioToolCallEvents(toolBody, "progress_card", { plan });
  // The routed call, after the step's commentary in the same response.
  const stream = new MockResponseStream(`resp_mock_ux_agent_${step}`);
  stream.message(commentary);
  for (const event of toolEvents) {
    if (
      event.type === "response.output_item.done" &&
      (event.item.type === "function_call" || event.item.type === "custom_tool_call")
    ) {
      stream.tool(event.item as MockToolCallItem);
    }
  }
  return stream.complete(32);
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
