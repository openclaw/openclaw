import { postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { buildSlackProgressCommentaryRun } from "../../live-transports/slack/slack-live.scenario-fixtures.js";
import { readQaMockRequestCursor } from "../shared/debug-request-cursor.js";
import { adaptAnthropicToolCallIds } from "./mock-anthropic-wire.js";
import type { StreamEvent } from "./mock-openai-contracts.js";
import { QA_TOOL_SEARCH_SECONDARY_TARGET, readTargetFromPrompt } from "./mock-openai-tooling.js";
import {
  expectIncludes,
  expectExcludes,
  expectSlots,
  anthropicCall,
  completedResult,
  functionCall,
  postPlain,
  postStream,
  respond,
  respondOpenAi,
  readResponse,
  responseOpenAi,
  streamOpenAi,
  streamOpenAiText,
  streamResponse,
  streamText,
  textBlock,
  userInputs,
} from "./server.fixtures.test-support.js";
import {
  type MockServer,
  type AnthropicResponse,
  ANTHROPIC_GUEST_CODE_MODE_TOOLS,
  expectAnthropicMessagesJson,
  readDebugRequest,
  makeAnthropicUserText,
  makeAnthropicToolResult,
  QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
  createMockServerTestHarness,
  requireRecord,
  postJson,
  expectOk,
  fetchOk,
  fetchOkJson,
  getJson,
  postResponses,
  expectResponsesJson,
  expectNonStreamingResponsesJson,
  expectOpenAiNonStreamingResponsesJson,
  requireArray,
  outputItem,
  outputItems,
  outputToolArgs,
  outputToolArgsFromItem,
  outputToolCall,
  outputToolCallId,
  outputContentItem,
  outputText,
  makeUserInput,
  makeToolOutputWithCallId,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();
const QA_FANOUT_PROMPT =
  "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.";

const QA_IMAGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3RQQkAMAzAwPg33Wnos+wgBo40dboAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANYADwAAAAAAAAAAAAAAAAAAAAAAAAAAAAC+Azy47PDiI4pA2wAAAABJRU5ErkJggg==";
const QA_IMAGE_INPUT = {
  type: "input_image",
  source: { type: "base64", mime_type: "image/png", data: QA_IMAGE_PNG_BASE64 },
} as const;
const QA_IMAGE_MEDIA_CONTEXT = textBlock(
  "[media attached: media://inbound/red-top-blue-bottom.png (image/png)]",
);
const QA_IMAGE_DESCRIPTION_PROMPT =
  "Image understanding check: describe the top and bottom colors.";
const QA_REASONING_ONLY_RECOVERY_PROMPT =
  "Reasoning-only continuation QA check: read QA_KICKOFF_TASK.md, then answer with exactly REASONING-RECOVERED-OK.";
const QA_REASONING_ONLY_SIDE_EFFECT_PROMPT =
  "Reasoning-only after write safety check: write reasoning-only-side-effect.txt, then answer with exactly SIDE-EFFECT-GUARD-OK.";
const QA_MIXED_REASONING_BLANK_FALLBACK_PROMPT =
  "Mixed reasoning blank fallback QA check: recover through the alternate model.";
const QA_THINKING_VISIBILITY_OFF_PROMPT =
  "QA thinking visibility check off: answer exactly THINKING-OFF-OK.";
const QA_THINKING_VISIBILITY_MAX_PROMPT =
  "QA thinking visibility check max: verify 17+24=41 internally, then answer exactly THINKING-MAX-OK.";
const QA_EMPTY_RESPONSE_RECOVERY_PROMPT =
  "Empty response continuation QA check: read QA_KICKOFF_TASK.md, then answer with exactly EMPTY-RECOVERED-OK.";
const QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT =
  "Empty response after write recovery QA check: write qa-empty-response-side-effect.txt, then reply with exact marker: `TELEGRAM-EMPTY-WRITE-RECOVERED-OK`.";
const QA_EMPTY_RESPONSE_SIDE_EFFECT_EXHAUSTION_PROMPT =
  "Empty response after write exhaustion QA check: write qa-empty-response-side-effect.txt, then reply with exact marker: `WRITE-EXHAUSTED-OK`.";
const QA_ANTHROPIC_THINKING_ERROR_RECOVERY_PROMPT =
  "Anthropic thinking error QA check: read QA_KICKOFF_TASK.md, then answer with exactly ANTHROPIC-THINKING-ERROR-RECOVERED-OK.";
const QA_REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";
const QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT = {
  status: "completed",
  value: {
    changed: true,
    created: true,
    patch: [
      "--- compaction-retry-summary.txt",
      "+++ compaction-retry-summary.txt",
      "@@ -0,0 +1,1 @@",
      "+Replay safety: unsafe after write.",
      "",
    ].join("\n"),
    firstChangedLine: 1,
  },
  replaySafe: false,
} as const;
const QA_COMPACTION_RETRY_PROMPT =
  "Compaction retry mutating tool check. Current durable context marker: QA-COMPACTION-DURABLE-MARKER. Create compaction-retry-summary.txt.";
const QA_COMPACTION_RETRY_OVERFLOW_PADDING = "x".repeat(300_000);
const QA_COMPACTION_RETRY_HISTORICAL_PHRASE = "post-marker historical user block";
const QA_COMPACTION_EMPTY_RECOVERY_SUMMARY_MARKER = "QA-COMPACTION-EMPTY-RECOVERED-SUMMARY";
const QA_COMPACTION_REASONING_RECOVERY_SUMMARY_MARKER = "QA-COMPACTION-REASONING-RECOVERED-SUMMARY";
const QA_COMPACTION_SUMMARY_HEADINGS = [
  "## Decisions",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  "## Exact identifiers",
] as const;
const QA_COMPACTION_SUMMARY_INSTRUCTIONS = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

function expectCurrentCompactionSummaryHeadings(summary: string) {
  expect(summary.match(/^## .+$/gmu)).toEqual(QA_COMPACTION_SUMMARY_HEADINGS);
  expect(summary).not.toContain("## Goal");
}

function postAnthropicMessages(
  server: MockServer,
  body: Record<string, unknown>,
  sessionId?: string,
) {
  return postJson(
    server,
    "/v1/messages",
    { model: "claude-opus-4-8", max_tokens: 256, ...body },
    sessionId ? { "x-session-affinity": sessionId } : undefined,
  );
}

function expectAnthropicMessages(server: MockServer, body: Record<string, unknown>) {
  return expectOk(postAnthropicMessages(server, body));
}

function makeImageUserInput(...content: unknown[]) {
  return { role: "user" as const, content };
}

async function readMockImageResponseText(server: MockServer, input: unknown[]) {
  return outputText(await respond(server, input, { model: "mock-openai/gpt-5.6-luna" }));
}

async function reply(server: MockServer, input: unknown, options?: Record<string, unknown>) {
  return outputText(await respond(server, input, options));
}

async function openAiReply(server: MockServer, input: unknown, options?: Record<string, unknown>) {
  return outputText(await respondOpenAi(server, input, options));
}

function readOpenAiPromptResponseText(server: MockServer, prompt: string, ...input: unknown[]) {
  return streamOpenAiText(server, [makeUserInput(prompt), ...input]);
}

function makeToolOutput(output: unknown) {
  return { type: "function_call_output" as const, output };
}

function expectNoTool(response: unknown, name?: string) {
  expect(
    outputItems(response).some(
      (item) => item.type === "function_call" && (name === undefined || item.name === name),
    ),
  ).toBe(false);
}

function expectFields(value: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, expected] of Object.entries(fields)) {
    expect(value[key], key).toBe(expected);
  }
}

function sseEvents(body: string) {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => requireRecord(JSON.parse(line.slice(6)), "SSE event"));
}

async function completeSideEffectScenario(server: MockServer, kind: "recovery" | "exhaustion") {
  const kickoff = makeUserInput(
    kind === "recovery"
      ? QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT
      : QA_EMPTY_RESPONSE_SIDE_EFFECT_EXHAUSTION_PROMPT,
  );
  const plan = await respondOpenAi(server, [kickoff]);
  const write = outputToolCall(plan, "write");
  const input = [
    kickoff,
    ...outputItems(plan),
    makeToolOutputWithCallId(
      outputToolCallId(write, "previous-write"),
      "Successfully wrote 27 bytes to qa-empty-response-side-effect.txt",
    ),
    makeUserInput(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION),
  ];
  const settled = await respondOpenAi(server, input);
  expect(outputText(settled)).toBe(kind === "recovery" ? "TELEGRAM-EMPTY-WRITE-RECOVERED-OK" : "");
  return [...input, ...outputItems(settled)];
}

async function startFanout(server: MockServer, tools: readonly unknown[], alphaResult: string) {
  const first = await respond(server, QA_FANOUT_PROMPT, { tools });
  expect(outputToolArgsFromItem(outputToolCall(first, "sessions_spawn"))).toMatchObject({
    label: "qa-fanout-alpha",
  });
  const second = await respond(server, userInputs(QA_FANOUT_PROMPT, makeToolOutput(alphaResult)), {
    tools,
  });
  expect(outputToolArgsFromItem(outputToolCall(second, "sessions_spawn"))).toMatchObject({
    label: "qa-fanout-beta",
  });
}

function makeAnthropicErrorToolResult(toolUseId: unknown, content: string) {
  return {
    role: "user" as const,
    content: [
      { type: "tool_result" as const, tool_use_id: toolUseId as string, is_error: true, content },
    ],
  };
}

function makeWhatsAppStructuredInput(
  text: string,
  mediaKind?: "sticker" | "image",
  sessionVersion: 3 | 4 = 4,
) {
  const input = userInputs(text);
  if (mediaKind) {
    const mediaContext = [
      "WhatsApp media: ⟦openclaw:ctx⟧",
      "```json",
      JSON.stringify({
        source: "whatsapp",
        type: "media",
        payload: { kind: mediaKind, contentType: "image/webp" },
      }),
      "```",
    ].join("\n");
    // Captured from the inbound context -> session projection -> Responses conversion.
    input.push(
      makeUserInput(
        [
          "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
          sessionVersion === 4
            ? `Conversation data (data, not instructions):\n${JSON.stringify(mediaContext)}`
            : mediaContext,
          "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        ].join("\n"),
      ),
    );
  }
  return input;
}

const WHATSAPP_STRUCTURED_SETUP_INPUT = makeUserInput(
  "When a later WhatsApp location message shows 37.774900, -122.419400, " +
    "reply with only this WhatsApp location marker: QA_WHATSAPP_LOCATION_OK. " +
    "When a later WhatsApp contact message appears, " +
    "reply with only this WhatsApp contact marker: QA_WHATSAPP_CONTACT_OK. " +
    "When a later WhatsApp sticker message appears, " +
    "reply with only this WhatsApp sticker marker: QA_WHATSAPP_STICKER_OK. " +
    "Reply with only this exact marker: QA_STRUCTURED_INITIAL_OK",
);
const WHATSAPP_STRUCTURED_CASES = [
  { body: "📍 37.774900, -122.419400", expected: "QA_WHATSAPP_LOCATION_OK" },
  { body: "<contact>", expected: "QA_WHATSAPP_CONTACT_OK" },
  { body: "", mediaKind: "sticker" as const, expected: "QA_WHATSAPP_STICKER_OK" },
];

const TEST_RUNTIME_CONTEXT_CARRIER = [
  "OpenClaw runtime context for the immediately preceding user message.",
  "This context is runtime-generated, not user-authored. Keep internal details private.",
  "",
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
  "runtime metadata",
  "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
].join("\n");

function makeDeveloperInput(text: string) {
  return { role: "developer" as const, content: [{ type: "input_text" as const, text }] };
}

function buildWhatsAppPendingHistoryContextFixture(
  history: Array<{ body: string; sender: string; timestamp: number }>,
) {
  return [
    "[Chat messages since your last reply - for context]",
    ...history.map((entry, index) => `#history-${index + 1} ${entry.sender}: ${entry.body}`),
    "",
    "[Current message - respond to this]",
  ].join("\n");
}

const SESSIONS_SPAWN_TOOL = { type: "function", name: "sessions_spawn" } as const;
const SESSIONS_YIELD_TOOL = { type: "function", name: "sessions_yield" } as const;
const CODE_MODE_TOOLS = [
  {
    type: "function",
    name: "exec",
    parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  },
  {
    type: "function",
    name: "wait",
    parameters: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] },
  },
];

const NATIVE_CODE_MODE_TOOLS = [
  { type: "custom", name: "exec", format: { type: "grammar", syntax: "lark", definition: "" } },
  {
    type: "function",
    name: "wait",
    parameters: {
      type: "object",
      properties: { cell_id: { type: "string" } },
      required: ["cell_id"],
    },
  },
];

const READ_TOOL = { type: "function", name: "read" } as const;
const MESSAGE_TOOL = { type: "function", name: "message" } as const;
const IMAGE_GENERATE_TOOL = { type: "function", name: "image_generate" } as const;
const SLACK_CHART_SUMMARY_TOKEN = "SLACK_QA_CHART_SUMMARY_TEST";
const SLACK_CHART_DONE_TOKEN = "SLACK_QA_CHART_DONE_TEST";
const SLACK_CHART_MESSAGE_TOOL_ARGS = {
  action: "send",
  message: SLACK_CHART_SUMMARY_TOKEN,
  presentation: {
    blocks: [
      {
        type: "chart",
        chartType: "line",
        title: "QA latency trend",
        categories: ["P50", "P95"],
        series: [{ name: "Latency", values: [120, 240] }],
        xLabel: "Percentile",
        yLabel: "Milliseconds",
      },
    ],
  },
};
const SLACK_CHART_PROMPT = [
  `Slack native chart QA check ${SLACK_CHART_SUMMARY_TOKEN}.`,
  `Call the message tool exactly once with these exact arguments: ${JSON.stringify(SLACK_CHART_MESSAGE_TOOL_ARGS)}.`,
  `After the chart send succeeds, reply with only this exact marker: ${SLACK_CHART_DONE_TOKEN}`,
].join(" ");
const MESSAGE_DECISION_SUPPRESSION_PROMPT = "Message delivery decision suppression QA check.";
const MESSAGE_DECISION_SEND_PROMPT = "Message delivery decision send QA check.";
const MESSAGE_DECISION_SUPPRESSION_TEXT =
  "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.";
const WHATSAPP_AGENT_REACT_PROMPT =
  "React to this WhatsApp message with thumbs up for QA action check WHATSAPP_QA_AGENT_REACT_TEST.";
const WHATSAPP_GROUP_AGENT_REACT_PROMPT =
  "openclawqa react to this WhatsApp group message with thumbs up for QA action check WHATSAPP_QA_GROUP_AGENT_REACT_TEST.";
const WHATSAPP_PENDING_HISTORY_QUIET_MARKER = "WHATSAPP_QA_PENDING_HISTORY_QUIET_TEST";
const WHATSAPP_PENDING_HISTORY_CONTEXT_SENTINEL = "WHATSAPP_QA_PENDING_HISTORY_CONTEXT_ONLY_TEST";
const WHATSAPP_PENDING_HISTORY_TRIGGER_MARKER = "WHATSAPP_QA_PENDING_HISTORY_TRIGGER_TEST";
const WHATSAPP_PENDING_HISTORY_OK_MARKER = "WHATSAPP_QA_PENDING_HISTORY_OK_TEST";
const WHATSAPP_PENDING_HISTORY_TRIGGER_PROMPT = [
  "openclawqa pending history context check",
  WHATSAPP_PENDING_HISTORY_TRIGGER_MARKER,
  `Return ${WHATSAPP_PENDING_HISTORY_OK_MARKER} only if prior group context contains ${WHATSAPP_PENDING_HISTORY_CONTEXT_SENTINEL}.`,
].join(" ");
const WHATSAPP_BROADCAST_TOKEN = "WHATSAPP_QA_BROADCAST_TOKEN_TEST";
const WHATSAPP_BROADCAST_PROMPT = `openclawqa broadcast fanout check ${WHATSAPP_BROADCAST_TOKEN}`;
const WHATSAPP_ACTIVATION_ALWAYS_MARKER = "WHATSAPP_QA_ACTIVATION_ALWAYS_TEST";
const WHATSAPP_ACTIVATION_ALWAYS_PROMPT = `Group activation visible behavior marker ${WHATSAPP_ACTIVATION_ALWAYS_MARKER}`;
const WHATSAPP_REPLY_TO_BOT_SEED_MARKER = "WHATSAPP_QA_REPLY_TO_BOT_SEED_TEST";
const WHATSAPP_REPLY_TO_BOT_SEED_PROMPT = `Mentioned group seed marker ${WHATSAPP_REPLY_TO_BOT_SEED_MARKER}`;
const WHATSAPP_REPLY_TO_BOT_TRIGGER_MARKER = "WHATSAPP_QA_REPLY_TO_BOT_TRIGGER_TEST";
const WHATSAPP_REPLY_TO_BOT_TRIGGER_PROMPT = `Quoted implicit reply trigger marker ${WHATSAPP_REPLY_TO_BOT_TRIGGER_MARKER}`;
const THREAD_SUBAGENT_CHILD_ERROR_TOKEN = "QA_SUBAGENT_CHILD_ERROR";
const THREAD_SUBAGENT_TOOL_ERROR =
  "thread=true requested but thread delivery is unavailable in this test harness.";

function threadSubagentTask(token: string) {
  return `Finish with exactly ${token}.`;
}

function explicitSessionsSpawnPrompt(token: string) {
  return [
    "Use sessions_spawn for this QA check.",
    `task="${threadSubagentTask(token)}"`,
    "label=qa-thread-subagent thread=true mode=session",
  ].join(" ");
}

describe("qa mock openai server", () => {
  it("returns HTTP 503 only after the provider failure fixture receives tool output", async () => {
    const server = await startMockServer();
    const prompt = "Provider HTTP 503 after tool QA check: read QA_KICKOFF_TASK.md, then reply.";

    const toolPlan = await responseOpenAi(server, prompt, { tools: [READ_TOOL] });
    expect(outputItem(await toolPlan.json()).name).toBe("read");

    const failure = await postPlain(
      server,
      userInputs(prompt, makeToolOutputWithCallId("call_mock_provider_503", "QA mission loaded")),
      { model: "gpt-5.6-luna", tools: [READ_TOOL] },
    );

    expect(failure.status).toBe(503);
    expect(failure.headers.get("retry-after")).toBe("120");
    expect(await failure.json()).toEqual({
      error: { type: "server_error", message: "Service Unavailable" },
    });
  });

  it("serves health and streamed responses", async () => {
    const server = await startMockServer();

    expect(await getJson(server, "/healthz")).toEqual({ ok: true, status: "live" });

    const response = await streamResponse(server, "Inspect the repo docs and kickoff task.");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expectIncludes(body, '"type":"response.output_item.added"', '"name":"read"');
  });

  it("recovers the stranded-final fixture by calling the message tool on the retry prompt", async () => {
    const server = await startMockServer();

    const initialBody = await respondOpenAi(
      server,
      "qa stranded final recovery check. Include `QA-STRANDED-85714` in a thorough multi-sentence answer, but do not call any tool yet.",
      { tools: [MESSAGE_TOOL] },
    );

    const initialText = outputText(initialBody);
    expectIncludes(initialText, "QA-STRANDED-85714", "近 7 日營收較前期增加");
    expect(initialText).toHaveLength(167);
    expect(initialText.match(/[.!?]+(?:\s|$)/g) ?? []).toHaveLength(0);
    expectNoTool(initialBody);

    const retryBody = await respondOpenAi(
      server,
      [
        "qa stranded final recovery check.",
        "Your previous reply was not delivered to the conversation because you did not call message(action=send).",
        initialText,
      ].join(" "),
      { tools: [MESSAGE_TOOL] },
    );

    const toolCall = outputToolCall(retryBody, "message");
    expect(outputToolArgsFromItem(toolCall)).toEqual({ action: "send", message: initialText });
  });

  it.each([
    {
      name: "private warning",
      prompt:
        "qa private final reply warning check. Reply to me directly in two complete sentences with `QA-STRANDED-85714` in the first sentence and a short explanation in the second sentence. Do NOT call any tool. Do NOT use the message tool.",
      marker: "QA-STRANDED-85714",
      tools: undefined,
    },
    {
      name: "retry failure",
      prompt:
        "Your previous reply was not delivered to the conversation because you did not call message(action=send). Include `QA-STRANDED-RETRY-FAIL-RAW` in a thorough multi-sentence answer, but do not call any tool.",
      marker: "QA-STRANDED-RETRY-FAIL-RAW",
      tools: [MESSAGE_TOOL],
    },
  ])("returns the substantive stranded-final $name fixture", async ({ prompt, marker, tools }) => {
    const body = await respondOpenAi(
      await startMockServer(),
      userInputs(prompt),
      tools ? { tools } : {},
    );
    const text = outputText(body);
    expect(text).toContain(marker);
    expect(text.length).toBeGreaterThanOrEqual(120);
    if (tools) {
      expectNoTool(body);
    } else {
      expect(text.match(/[.!?]+(?:\s|$)/g)).toHaveLength(2);
    }
  });

  it.each([
    {
      name: "Teams final dedupe",
      prompt:
        "qa msteams thread message-tool final dedupe. msteams message target: `conversation:19:other@thread.tacv2;messageid=other-root`. exact marker: `QA-MSTEAMS-THREAD-DEDUPE-OK`",
      args: {
        action: "send",
        message: "QA-MSTEAMS-THREAD-DEDUPE-OK",
        target: "conversation:19:other@thread.tacv2;messageid=other-root",
      },
      final: "QA-MSTEAMS-THREAD-DEDUPE-OK",
      continuation: [],
    },
    {
      name: "native thread receipt",
      prompt:
        "qa thread reply receipt check. Use the native reply path. channel id: `qa-room`; thread id: `thread-1`; exact marker: `QA-THREAD-RECEIPT-OK`",
      args: {
        action: "thread-reply",
        channelId: "qa-room",
        threadId: "thread-1",
        message: "QA-THREAD-RECEIPT-OK",
      },
      final: "QA-THREAD-RECEIPT-OK",
      continuation: [],
    },
    {
      name: "divergent automatic final",
      prompt:
        "qa thread reply receipt check. channel id: `qa-room`; thread id: `thread-1`; exact marker: `QA-THREAD-TOOL-OK`; divergent final: `QA-THREAD-FINAL-OK`",
      args: {
        action: "thread-reply",
        channelId: "qa-room",
        threadId: "thread-1",
        message: "QA-THREAD-TOOL-OK",
      },
      final: "QA-THREAD-FINAL-OK",
      continuation: userInputs("Continue from the tool result."),
    },
  ])(
    "completes the message-tool reply with $name",
    async ({ prompt, args, final, continuation }) => {
      const server = await startMockServer();
      const request = {
        stream: false,
        model: "gpt-5.6-luna",
        tools: [MESSAGE_TOOL],
        input: userInputs(prompt),
      };
      const initial = await expectResponsesJson(server, request);
      expect(outputItem(initial)).toMatchObject({ type: "function_call", name: "message" });
      const call = outputToolCall(initial, "message");
      expect(outputToolArgsFromItem(call)).toEqual(args);
      const completed = await expectResponsesJson(server, {
        ...request,
        input: [
          ...request.input,
          makeToolOutputWithCallId(outputToolCallId(call, "message"), JSON.stringify({ ok: true })),
          ...continuation,
        ],
      });
      expect(outputText(completed)).toBe(final);
      expectNoTool(completed);
    },
  );

  it("emits deterministic text deltas for generic streaming QA prompts", async () => {
    const server = await startMockServer();
    const cases: Array<[unknown, string, boolean?, number?, string?]> = [
      ["Quiet streaming QA check: reply exactly `QA_STREAMING_OK`.", "QA_STREAMING_OK", true],
      ["Partial streaming QA check: reply exactly `QA_PARTIAL_OK`.", "QA_PARTIAL_OK"],
      [
        userInputs(
          "Telegram reply-chain marker QA. Reply exactly: QA-TELEGRAM-REPLY-CHAIN-OK",
          "Quiet streaming QA check. Reply exactly: QA-TELEGRAM-STREAM-SINGLE-OK",
        ),
        "QA-TELEGRAM-STREAM-SINGLE-OK",
        false,
        undefined,
        "QA-TELEGRAM-REPLY-CHAIN-OK",
      ],
      ["Telegram long final QA check.", "TELEGRAM-LONG-FINAL", true, 4_500],
      ["WhatsApp long final QA check.", "WHATSAPP-LONG-FINAL", true, 6_000],
      ["Telegram long final three chunk QA check.", "TELEGRAM-LONG-FINAL-3CHUNK", true, 8_000],
    ];
    for (const [input, marker, phase, minimum, absent] of cases) {
      const body = await streamText(server, input);
      expect(body).toContain('"type":"response.output_text.delta"');
      if (phase) {
        expect(body).toContain('"phase":"final_answer"');
      }
      if (minimum) {
        expectIncludes(body, `${marker}-BEGIN`, `${marker}-END`);
        expect(body.length).toBeGreaterThan(minimum);
      } else {
        expect(body).toContain(marker);
      }
      if (absent) {
        expect(body).not.toContain(absent);
      }
    }
    const prompt =
      "Block streaming QA check: first exact marker: `BLOCK_ONE_OK`; read `QA_KICKOFF_TASK.md`; second exact marker: `BLOCK_TWO_OK`.";
    const first = await streamText(server, prompt);
    expectIncludes(
      first,
      '"item_id":"msg_mock_block_1"',
      '"name":"read"',
      "QA_KICKOFF_TASK.md",
      "BLOCK_ONE_OK",
    );
    expect(first).not.toContain('"item_id":"msg_mock_block_2"');
    const final = await streamText(
      server,
      userInputs(
        prompt,
        makeToolOutputWithCallId("call_mock_read_fixture", "QA kickoff task read"),
      ),
    );
    expectIncludes(final, '"item_id":"msg_mock_block_2"', "BLOCK_TWO_OK");
    expect(final).not.toContain('"item_id":"msg_mock_block_1"');
  });

  it("dispatches structured Slack commentary, exec, and final phases", async () => {
    const server = await startMockServer();
    const run = buildSlackProgressCommentaryRun("U_SUT", {
      commentary: "standalone",
      toolProgress: "absent",
    });
    const suffix = run.matchText.slice("SLACK-QA-COMMENTARY-DONE-".length);
    const commentary = `SLACK-QA-COMMENTARY-${suffix}`;
    const command = `printf '%s' 'SLACK-QA-TOOL-${suffix}' >/dev/null; sleep 5; printf '%s\\n' 'SLACK-QA-OUTPUT-${suffix}'`;
    const stale =
      "SLACK-QA-COMMENTARY-11112222 printf '%s' 'SLACK-QA-TOOL-11112222' >/dev/null; sleep 5; printf '%s\\n' 'SLACK-QA-OUTPUT-11112222' SLACK-QA-COMMENTARY-DONE-11112222";
    const input = userInputs(
      stale,
      makeToolOutputWithCallId("call_stale_slack_progress", ""),
      `${stale}\n${run.input.replaceAll(">", "&gt;")}`,
    );
    const options = { tools: [{ type: "function", name: "exec" }] };
    const events = sseEvents(await streamText(server, input, options));
    const items = events
      .filter((event) => event.type === "response.output_item.done")
      .map((event) => requireRecord(event.item, "completed item"));
    expect(items).toMatchObject([
      {
        type: "message",
        phase: "commentary",
        content: [{ type: "output_text", text: commentary }],
      },
      { type: "function_call", name: "exec" },
    ]);
    expect(items).toHaveLength(2);
    const exec = requireRecord(items[1], "exec output item");
    expect(outputToolArgsFromItem(exec)).toEqual({ command });
    expectSlots(events, ["msg_mock_slack_progress_commentary", exec.id]);
    expect(events.find((event) => event.type === "response.function_call_arguments.delta")).toEqual(
      {
        type: "response.function_call_arguments.delta",
        item_id: exec.id,
        output_index: 1,
        delta: JSON.stringify({ command }),
      },
    );
    expect(JSON.stringify(events)).not.toContain(run.matchText);
    const final = await respond(
      server,
      [...input, exec, makeToolOutputWithCallId(outputToolCallId(exec, "call_slack_progress"), "")],
      options,
    );
    expect(outputItems(final)).toMatchObject([{ type: "message", phase: "final_answer" }]);
    expect(outputItems(final)).toHaveLength(1);
    expect(outputText(final)).toBe(run.matchText);
    expect(JSON.stringify(final)).not.toContain(commentary);
  });
  it("does not dispatch Slack progress when structured marker suffixes disagree", async () => {
    const server = await startMockServer();
    const payload = await respond(
      server,
      "SLACK-QA-COMMENTARY-A1B2C3D4 printf '%s' 'SLACK-QA-TOOL-11112222' >/dev/null; sleep 5; printf '%s\\n' 'SLACK-QA-OUTPUT-A1B2C3D4' SLACK-QA-COMMENTARY-DONE-A1B2C3D4",
      { tools: [{ type: "function", name: "exec" }] },
    );

    expect(outputItems(payload)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "exec" })]),
    );
  });

  it("does not use stale exact replies from instructions after QA reads", async () => {
    const server = await startMockServer();
    const evidencePrefix = "x".repeat(210);

    const text = await reply(
      server,
      userInputs(
        "Read QA_KICKOFF_TASK.md, then summarize what you found.",
        makeToolOutputWithCallId(
          "call_mock_read_1",
          JSON.stringify({ text: `${evidencePrefix}😀tail` }),
        ),
      ),
      { instructions: "If this is a heartbeat check, reply exactly: HEARTBEAT_OK" },
    );
    expect(text).toBe(
      `Protocol note: I reviewed the requested material. Evidence snippet: {"text":"${evidencePrefix}`,
    );
    expect(text).not.toContain("HEARTBEAT_OK");
  });

  it.each<
    [name: string, input: readonly unknown[], expected: string | RegExp, tools?: readonly unknown[]]
  >([
    [
      "classifies a completion event before the child task text it quotes",
      userInputs(
        "Subagent terminal reply QA check: empty.",
        "[Internal task completion event]\nTask: qa-terminal-empty\nChild task: Subagent terminal reply QA worker: empty.\nResult: (no output)",
      ),
      "",
    ],
    [
      "lets child subagent prompts finish with an exact token",
      userInputs(threadSubagentTask("QA_SUBAGENT_CHILD_DIRECT")),
      "QA_SUBAGENT_CHILD_DIRECT",
    ],
    [
      "keeps QA tool-search result summaries ahead of generic worked/failed/blocked summaries",
      userInputs(
        {
          role: "system",
          content: [
            textBlock("Answer in worked/failed/blocked format with source and docs notes."),
          ],
        },
        "tool search qa check target=fake_plugin_tool_17. Call exactly that tool once and then summarize.",
        makeToolOutputWithCallId(
          "call_tool_call_1",
          JSON.stringify({
            tool: { name: "fake_plugin_tool_17" },
            result: { content: [{ type: "text", text: "FAKE_PLUGIN_OK fake_plugin_tool_17" }] },
          }),
        ),
      ),
      "FAKE_PLUGIN_OK fake_plugin_tool_17",
    ],
    [
      "derives ask_user QA summaries from the returned answers",
      userInputs(
        {
          role: "system",
          content: [textBlock("Nothing to say: entire reply exactly NO_REPLY")],
        },
        "QA routing marker: tool search qa check target=ask_user. Ask structured questions, then summarize their actual answers.",
        makeToolOutputWithCallId(
          "call_ask_user_1",
          JSON.stringify({
            content: [
              {
                type: "text",
                text: 'Deploy: Canary\nChecks: Lint, Unit (Recommended)\nNote: weekend-only\n\n{"status":"answered"}',
              },
            ],
          }),
        ),
      ),
      "ASK-USER-ROUNDTRIP-OK | deploy=Canary | checks=Lint,Unit | note=weekend-only",
    ],
    [
      "returns NO_REPLY for unmentioned group chatter",
      userInputs(
        'Conversation info: ⟦openclaw:ctx⟧\n{"is_group_chat": true}\n\nhello team, no bot ping here',
      ),
      "NO_REPLY",
    ],
    [
      "prefers the current direct-fallback worker turn over an earlier parent kickoff",
      userInputs(
        "Subagent direct fallback QA check: spawn one worker and yield.",
        "Subagent direct fallback worker: finish with exactly QA-SUBAGENT-DIRECT-FALLBACK-OK.",
      ),
      "QA-SUBAGENT-DIRECT-FALLBACK-OK",
      [SESSIONS_SPAWN_TOOL, SESSIONS_YIELD_TOOL],
    ],
    [
      "returns the silent terminal worker result",
      userInputs("Subagent terminal reply QA worker: silent."),
      "NO_REPLY",
    ],
    [
      "returns the fallback terminal worker result",
      userInputs("Subagent terminal reply QA worker: fallback."),
      [
        "QA-SUBAGENT-TERMINAL-FALLBACK-OK",
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
        "QA-SUBAGENT-TERMINAL-INTERNAL-MUST-NOT-LEAK",
        "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      ].join("\n"),
    ],
    [
      "returns the private completion worker result",
      userInputs("Subagent private completion QA worker: first."),
      /^QA-PARENT-PRIVATE-CHILD1-[A-F0-9]{32}\nMEDIA:\.\/qa-private-result\.png$/u,
    ],
    [
      "answers automation heartbeat without spawning extra subagents",
      userInputs(
        "System: Gateway restart config-apply ok\n\nFollow the heartbeat monitor scratch context when provided. If nothing needs attention, reply NO_REPLY.",
      ),
      "NO_REPLY",
    ],
    [
      "returns the visible skill marker",
      userInputs("Visible skill marker: give me the visible skill marker exactly."),
      "VISIBLE-SKILL-OK",
    ],
    [
      "returns the hot-installed skill marker",
      userInputs("Hot install marker: give me the hot install marker exactly."),
      "HOT-INSTALL-OK",
    ],
  ])("%s", async (_name, input, expected, tools) => {
    const payload = await respond(await startMockServer(), input, tools ? { tools } : {});
    if (typeof expected === "string") {
      expect(outputText(payload)).toBe(expected);
    } else {
      expect(outputText(payload)).toMatch(expected);
    }
    expectNoTool(payload);
  });

  it("selects the latest block-streaming markers and target in one user envelope", async () => {
    const server = await startMockServer();
    const envelope = [
      "Block streaming QA check: first exact marker: `STALE_ONE`; read `stale-block.txt`; second exact marker: `STALE_TWO`.",
      "Block streaming QA check: first exact marker: `CURRENT_ONE`; read `current-block.txt`; second exact marker: `CURRENT_TWO`.",
    ].join("\n");
    const payload = await respond(server, envelope);

    expect(outputText(payload)).toBe("CURRENT_ONE");
    const toolCall = outputToolCall(payload, "read");
    expect(outputToolArgsFromItem(toolCall)).toEqual({ path: "current-block.txt" });
    expect(JSON.stringify(payload)).not.toContain("STALE_ONE");
    expect(JSON.stringify(payload)).not.toContain("stale-block.txt");
  });

  it("keeps unformatted Matrix mention-shaped filenames intact", () => {
    expect(
      readTargetFromPrompt(
        "Read the missing workspace file matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt before answering.",
      ),
    ).toBe("matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt");
    expect(readTargetFromPrompt("Read _fixture.json before answering.")).toBe("_fixture.json");
  });

  it("drives the Lobster Invaders write flow and memory recall responses", async () => {
    const server = await startMockServer();

    const lobsterBody = await readOpenAiPromptResponseText(
      server,
      "Please build Lobster Invaders after reading context.",
      makeToolOutput("QA mission: read source and docs first."),
    );
    expectIncludes(lobsterBody, '"name":"write"', "lobster-invaders.html");

    expect(
      await reply(
        server,
        userInputs(
          "Please remember this fact for later: the QA canary code is ALPHA-7.",
          "What was the QA canary code I asked you to remember earlier?",
        ),
        { model: "gpt-5.6-luna-alt" },
      ),
    ).toContain("ALPHA-7");

    const requestLog = requireArray(await getJson(server, "/debug/requests"), "debug requests");
    expect(requireRecord(requestLog[0], "debug request 0").model).toBe("gpt-5.6-luna");
    expect(requireRecord(requestLog[1], "debug request 1").model).toBe("gpt-5.6-luna-alt");
  });

  it("requires retained bot history in the Slack MPIM thread-history prelude", async () => {
    const server = await startMockServer();
    const seedMarker = "SLACK_QA_MPIM_SEED_A1B2C3D4";
    const recallMarker = "SLACK_QA_MPIM_RECALL_A1B2C3D4";
    const missingMarker = "SLACK_QA_MPIM_MISSING_A1B2C3D4";
    const seedPrompt =
      `Slack MPIM assistant-history seed check. Reply with only a marker in this exact format: ${seedMarker}_BOT_<NONCE>. ` +
      "Replace <NONCE> with 8 to 32 new uppercase letters or digits. " +
      "Do not include angle brackets, spaces, Markdown, or punctuation.";
    const read = (...input: Parameters<typeof userInputs>) =>
      openAiReply(server, userInputs(...input));
    const botReplyMarker = await read(seedPrompt);
    const seedPattern = new RegExp(`^${seedMarker}_BOT_[A-Z0-9]+$`, "u");
    expect(botReplyMarker).toMatch(seedPattern);
    const botNonce = botReplyMarker.slice(`${seedMarker}_BOT_`.length);
    const recallPrompt = [
      "Slack MPIM assistant-history recall check.",
      `Recall the nonce from your immediately previous reply beginning with ${seedMarker}_BOT_.`,
      `Reply with only this exact format: ${recallMarker}_<NONCE>, using that same nonce.`,
      `Otherwise reply with only: ${missingMarker}`,
    ].join(" ");
    expectExcludes(recallPrompt, botReplyMarker, botNonce);
    const history = (author: string, seed = "") =>
      [
        "[Thread history - for context]",
        ...(seed
          ? [
              `[Slack Driver (user) Fri 2026-07-31 10:00 UTC] ${seed}`,
              "[slack message id: 1.000000 channel: C123]",
              "",
            ]
          : []),
        `[Slack ${author} Fri 2026-07-31 ${seed ? "10:01" : "10:00"} UTC] ${botReplyMarker}`,
        `[slack message id: ${seed ? "1.500000" : "1.000000"} channel: C123]`,
        "",
        `[Slack Driver (user) Fri 2026-07-31 10:02 UTC] ${recallPrompt}`,
      ].join("\n");
    await expect(read(history("OpenClaw (this assistant) (assistant)", seedPrompt))).resolves.toBe(
      `${recallMarker}_${botNonce}`,
    );
    await expect(
      read(
        seedPrompt,
        { role: "assistant", content: [{ type: "output_text", text: botReplyMarker }] },
        recallPrompt,
      ),
    ).resolves.toBe(missingMarker);
    await expect(read(history("Alice (user)"))).resolves.toBe(missingMarker);
    for (const prefix of [
      "Please remember this fact for later: ORBIT-22. ",
      "Reply exactly `SHADOWED-EXACT-REPLY`. ",
    ]) {
      await expect(read(prefix + seedPrompt)).resolves.toMatch(seedPattern);
      await expect(read(prefix + recallPrompt)).resolves.toBe(missingMarker);
    }
  });

  it("emits the Slack native chart presentation through the declared message tool", async () => {
    const server = await startMockServer();

    const undeclaredPayload = await respondOpenAi(server, SLACK_CHART_PROMPT);
    expectNoTool(undeclaredPayload, "message");

    const declaredPayload = await respondOpenAi(server, SLACK_CHART_PROMPT, {
      tools: [MESSAGE_TOOL],
    });
    const toolCall = outputToolCall(declaredPayload, "message");
    expect(outputToolArgsFromItem(toolCall)).toEqual(SLACK_CHART_MESSAGE_TOOL_ARGS);

    const afterToolPayload = await respondOpenAi(
      server,
      userInputs(
        SLACK_CHART_PROMPT,
        makeToolOutputWithCallId(
          outputToolCallId(toolCall, "call_mock_message_chart"),
          "message sent",
        ),
      ),
      { tools: [MESSAGE_TOOL] },
    );
    expectNoTool(afterToolPayload, "message");
    expect(outputText(afterToolPayload)).toBe(SLACK_CHART_DONE_TOKEN);
  });

  it.each([
    {
      name: "suppression",
      prompt: MESSAGE_DECISION_SUPPRESSION_PROMPT,
      args: { action: "send", message: MESSAGE_DECISION_SUPPRESSION_TEXT },
      result: '{"status":"suppressed"}',
    },
    {
      name: "durable send",
      prompt: MESSAGE_DECISION_SEND_PROMPT,
      args: {
        action: "send",
        message: "QA-MESSAGE-DELIVERY-OK",
        final: true,
        presentation: { blocks: [{ type: "text", text: "QA-MESSAGE-DELIVERY-OK" }] },
      },
      result: undefined,
    },
  ])("emits the deterministic message-decision $name fixture", async ({ prompt, args, result }) => {
    const server = await startMockServer();
    const request = { tools: [MESSAGE_TOOL], input: userInputs(prompt) };
    const initial = await expectOpenAiNonStreamingResponsesJson(server, request);
    const call = outputToolCall(initial, "message");
    expect(outputToolArgsFromItem(call)).toEqual(args);
    if (result) {
      expect(
        await openAiReply(
          server,
          [...request.input, makeToolOutputWithCallId(outputToolCallId(call, "message"), result)],
          { ...request },
        ),
      ).toBe("NO_REPLY");
    }
  });

  it("emits WhatsApp reactions only when the message tool is declared", async () => {
    const server = await startMockServer();
    for (const tools of [undefined, [READ_TOOL]]) {
      const undeclared = await respondOpenAi(
        server,
        userInputs(WHATSAPP_AGENT_REACT_PROMPT),
        tools ? { tools } : {},
      );
      expectNoTool(undeclared, "message");
    }
    for (const input of [WHATSAPP_AGENT_REACT_PROMPT, WHATSAPP_GROUP_AGENT_REACT_PROMPT]) {
      const declared = await respondOpenAi(server, input, { tools: [MESSAGE_TOOL] });
      const call = outputToolCall(declared, "message");
      expect(call).toMatchObject({ type: "function_call", name: "message" });
      expect(outputToolArgsFromItem(call)).toEqual({ action: "react", emoji: "👍", final: true });
    }
  });

  it("answers WhatsApp pending-history prompts only with injected prior group context", async () => {
    const server = await startMockServer();
    const trigger = [
      "openclawqa pending history context check",
      WHATSAPP_PENDING_HISTORY_TRIGGER_MARKER,
      `Return ${WHATSAPP_PENDING_HISTORY_OK_MARKER} only if prior group context contains the context-only sentinel.`,
    ].join(" ");
    const prior = (body: string) =>
      buildWhatsAppPendingHistoryContextFixture([
        { sender: "Alice", timestamp: 1_786_000_000_000, body },
      ]);
    const history = prior(
      `quiet context ${WHATSAPP_PENDING_HISTORY_QUIET_MARKER} ${WHATSAPP_PENDING_HISTORY_CONTEXT_SENTINEL}`,
    );
    const read = (...input: Parameters<typeof userInputs>) =>
      openAiReply(server, userInputs(...input));
    await expect(
      read(trigger, TEST_RUNTIME_CONTEXT_CARRIER.replace("runtime metadata", history)),
    ).resolves.toBe(WHATSAPP_PENDING_HISTORY_OK_MARKER);
    for (const input of [
      userInputs(trigger),
      userInputs(
        makeDeveloperInput(prior("unrelated prior context")),
        `${WHATSAPP_PENDING_HISTORY_TRIGGER_PROMPT}\nCurrent request: ${WHATSAPP_PENDING_HISTORY_QUIET_MARKER}`,
      ),
      userInputs(
        `${WHATSAPP_PENDING_HISTORY_QUIET_MARKER} ${WHATSAPP_PENDING_HISTORY_CONTEXT_SENTINEL}`,
        trigger,
      ),
      userInputs(`${history}\nopenclawqa pending history context check without current trigger`),
    ]) {
      await expect(openAiReply(server, input)).resolves.not.toBe(
        WHATSAPP_PENDING_HISTORY_OK_MARKER,
      );
    }
  });

  it("uses the WhatsApp broadcast runtime agent id context for distinct markers", async () => {
    const server = await startMockServer();
    for (const [identity, suffix] of [
      ["agent=main | ", "MAIN"],
      ["agent=qa-second | ", "SECOND"],
      ["", undefined],
    ] as const) {
      const payload = await respondOpenAi(
        server,
        userInputs(
          makeDeveloperInput(
            `Runtime: ${identity}channel=whatsapp | channel_capabilities=messageactions`,
          ),
          WHATSAPP_BROADCAST_PROMPT,
        ),
      );
      if (suffix) {
        expect(outputText(payload)).toBe(`${WHATSAPP_BROADCAST_TOKEN}_${suffix}`);
      } else {
        expect(outputText(payload)).not.toMatch(
          new RegExp(`${WHATSAPP_BROADCAST_TOKEN}_(?:MAIN|SECOND)`, "u"),
        );
      }
    }
  });

  it("matches WhatsApp group dispatch markers without answering unrelated prompts", async () => {
    const server = await startMockServer();
    for (const [prompt, marker, unrelated] of [
      [
        WHATSAPP_ACTIVATION_ALWAYS_PROMPT,
        WHATSAPP_ACTIVATION_ALWAYS_MARKER,
        "Group activation visible behavior marker WHATSAPP_QA_UNRELATED_TEST",
      ],
      [WHATSAPP_REPLY_TO_BOT_SEED_PROMPT, WHATSAPP_REPLY_TO_BOT_SEED_MARKER, undefined],
      [
        WHATSAPP_REPLY_TO_BOT_TRIGGER_PROMPT,
        WHATSAPP_REPLY_TO_BOT_TRIGGER_MARKER,
        "Quoted implicit reply trigger marker WHATSAPP_QA_UNRELATED_TEST",
      ],
    ] as const) {
      expect(await openAiReply(server, prompt)).toBe(marker);
      if (unrelated) {
        expect(await openAiReply(server, unrelated)).not.toBe(marker);
      }
    }
  });

  it("advances repo-contract followthrough when transcript text is newer than extracted tool output", async () => {
    const server = await startMockServer();

    const prompt =
      "Repo contract followthrough check. Read AGENT.md, SOUL.md, and FOLLOWTHROUGH_INPUT.md first. Then follow the repo contract exactly, write ./repo-contract-summary.txt, and reply with three labeled lines: Read, Wrote, Status.";

    const response = await streamOpenAi(
      server,
      userInputs(
        prompt,
        makeToolOutput(
          "# Repo contract\n\nStep order:\n1. Read AGENT.md.\n2. Read SOUL.md.\n3. Read FOLLOWTHROUGH_INPUT.md.\n4. Write ./repo-contract-summary.txt.\n",
        ),
        "# Execution style\n\nStay brief, honest, and action-first.\n",
      ),
    );

    expect(await response.text()).toContain(
      '"arguments":"{\\"path\\":\\"FOLLOWTHROUGH_INPUT.md\\"}"',
    );
  });

  it("advances personal task followthrough when transcript text is newer than extracted tool output", async () => {
    const server = await startMockServer();

    const prompt =
      "Personal task followthrough check. Read PERSONAL_TASK_LEDGER.md and FOLLOWTHROUGH_NOTE.md first. Then write ./personal-task-status.txt and reply with three labeled lines: Pending, Blocked, Done.";

    const firstBody = await readOpenAiPromptResponseText(server, prompt);
    expect(firstBody).toContain('"arguments":"{\\"path\\":\\"PERSONAL_TASK_LEDGER.md\\"}"');
    expect(firstBody).not.toContain("repo/package.json");

    const response = await streamOpenAi(
      server,
      userInputs(
        prompt,
        makeToolOutput(
          "# Personal task ledger\n\nRequired status contract:\n1. Read PERSONAL_TASK_LEDGER.md.\n2. Read FOLLOWTHROUGH_NOTE.md.\n3. Write ./personal-task-status.txt.\n",
        ),
        "Task: prepare a local OpenClaw PR readiness note.\nPending: wait for maintainer feedback before publishing.\nBlocked: publishing needs explicit user approval.\nDone: local evidence captured in personal-task-status.txt.\n",
      ),
    );

    const body = await response.text();
    expectIncludes(body, '"name":"write"', "personal-task-status.txt");
  });

  it("reports personal failure recovery with a retry boundary", async () => {
    const server = await startMockServer();

    const prompt =
      "Personal failure recovery check. Read FAILURE_RECOVERY_REQUEST.md and FAILURE_RECOVERY_EVIDENCE.md first. Then write ./personal-failure-recovery.txt with Completed, Failed step, Retry boundary, and Next step.";

    const firstBody = await readOpenAiPromptResponseText(server, prompt);
    expect(firstBody).toContain('"arguments":"{\\"path\\":\\"FAILURE_RECOVERY_REQUEST.md\\"}"');
    expect(firstBody).not.toContain("fully complete");

    const writeBody = await readOpenAiPromptResponseText(
      server,
      prompt,
      makeToolOutput(
        "# Failure recovery request\n\nRequired contract:\n1. Read FAILURE_RECOVERY_REQUEST.md.\n2. Read FAILURE_RECOVERY_EVIDENCE.md.\n3. Write ./personal-failure-recovery.txt.\n",
      ),
      makeUserInput(
        "# Failure recovery evidence\n\nCompleted: request reviewed and local evidence captured.\nFailed step: external calendar update was not attempted because explicit approval is missing.\nRetry boundary: do not retry the external step until approval is given.\nNext step: ask for approval before any external update.\n",
      ),
    );
    expectIncludes(
      writeBody,
      '"name":"write"',
      "personal-failure-recovery.txt",
      "Retry boundary: do not retry",
    );
    expect(writeBody).not.toContain("retry succeeded");

    const finalBody = await readOpenAiPromptResponseText(
      server,
      prompt,
      makeToolOutput(
        "Successfully wrote personal-failure-recovery.txt with the failed step and retry boundary.",
      ),
    );
    expectIncludes(finalBody, "PERSONAL-FAILURE-RECOVERY-OK", "Retry boundary: do not retry");
    expect(finalBody).not.toContain("fully complete");
  });

  it("injects one Anthropic overflow per session before planning the logical write", async () => {
    const server = await startMockServer();
    const body = {
      tools: CODE_MODE_TOOLS.map(({ name, parameters }) => ({ name, input_schema: parameters })),
      messages: [
        makeAnthropicUserText(
          `${QA_COMPACTION_RETRY_PROMPT}\n${QA_COMPACTION_RETRY_OVERFLOW_PADDING}`,
        ),
      ],
    };

    const first = await postAnthropicMessages(server, body, "anthropic-overflow-a");
    expect(first.status).toBe(400);
    expect(await first.json()).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "context_length_exceeded",
        message: "This model's maximum context length was exceeded.",
      },
    });

    const second = await postAnthropicMessages(server, body, "anthropic-overflow-a");
    expect(second.status).toBe(200);
    const content = requireArray(
      requireRecord(await second.json(), "Anthropic response").content,
      "content",
    );
    expect(content).toContainEqual(expect.objectContaining({ type: "tool_use", name: "exec" }));
    expect(await getJson(server, "/debug/last-request")).toMatchObject({
      plannedToolName: "write",
      plannedWireToolName: "exec",
    });

    const independent = await postAnthropicMessages(server, body, "anthropic-overflow-b");
    expect(independent.status).toBe(400);
  });

  it("excludes compaction summary requests from overflow injection", async () => {
    const server = await startMockServer();
    const initial = await postPlain(
      server,
      `${QA_COMPACTION_RETRY_PROMPT}\n${QA_COMPACTION_RETRY_OVERFLOW_PADDING}`,
      { model: "gpt-5.6-luna", client_metadata: { session_id: "compaction-summary" } },
    );
    expect(initial.status).toBe(400);

    const response = await postResponses(server, {
      stream: false,
      model: "gpt-5.6-luna",
      instructions: QA_COMPACTION_SUMMARY_INSTRUCTIONS,
      input: `<conversation>\n[Chunk 1 - oldest messages]\nQA-COMPACTION-BULKY-HISTORICAL-MARKER\n${QA_COMPACTION_RETRY_OVERFLOW_PADDING}\n</conversation>\n\nAdditional focus: preserve exact identifiers and current work.`,
    });

    expect(response.status).toBe(200);
    const summary = outputText(await response.json());
    expectCurrentCompactionSummaryHeadings(summary);
    expectExcludes(
      summary,
      "QA-COMPACTION-DURABLE-MARKER",
      "QA-COMPACTION-BULKY-HISTORICAL-MARKER",
    );
  });

  it.each([
    {
      faultMode: "empty-output-once",
      markerPrefix: "QA-COMPACTION-EMPTY-OUTPUT-ONCE",
      recoveredMarker: QA_COMPACTION_EMPTY_RECOVERY_SUMMARY_MARKER,
      reasoningOnly: false,
    },
    {
      faultMode: "reasoning-only-output-once",
      markerPrefix: "QA-COMPACTION-REASONING-ONLY-OUTPUT-ONCE",
      recoveredMarker: QA_COMPACTION_REASONING_RECOVERY_SUMMARY_MARKER,
      reasoningOnly: true,
    },
  ] as const)(
    "scopes $faultMode compaction faults to one scenario session",
    async ({ faultMode, markerPrefix, recoveredMarker, reasoningOnly }) => {
      const server = await startMockServer();
      const requestFor = (session: string) => ({
        model: "gpt-5.6-luna",
        instructions: QA_COMPACTION_SUMMARY_INSTRUCTIONS,
        input: `<conversation>\n${markerPrefix}-${session}\nretain current work\n</conversation>\n\nCreate a structured summary.`,
      });

      const first = await expectOpenAiNonStreamingResponsesJson(server, requestFor("session-a"));
      if (reasoningOnly) {
        expect(JSON.stringify(first)).toContain("reasoning_compaction_summary_fault");
        expect(JSON.stringify(first)).not.toContain(recoveredMarker);
      } else {
        expect(outputText(first)).toBe("");
      }
      const recovered = await expectOpenAiNonStreamingResponsesJson(
        server,
        requestFor("session-a"),
      );
      const recoveredText = outputText(recovered);
      expectIncludes(
        recoveredText,
        recoveredMarker,
        `${markerPrefix}-session-a`,
        "## Decisions",
        "## Open TODOs",
        "## Constraints/Rules",
        "## Pending user asks",
        "## Exact identifiers",
      );
      const independent = await expectOpenAiNonStreamingResponsesJson(
        server,
        requestFor("session-b"),
      );
      if (reasoningOnly) {
        expect(JSON.stringify(independent)).toContain("reasoning_compaction_summary_fault");
        expect(JSON.stringify(independent)).not.toContain(recoveredMarker);
      } else {
        expect(outputText(independent)).toBe("");
      }

      const requests = requireArray(
        await getJson(server, "/debug/requests"),
        "compaction output fault requests",
      ).map((request) => requireRecord(request, "compaction output fault request"));
      expect(requests.map((request) => request.compactionSummaryFaultMode)).toEqual([
        faultMode,
        "none",
        faultMode,
      ]);
      expect(requests.every((request) => request.requestKind === "compaction-summary")).toBe(true);
    },
  );

  it("keeps historical, durable, and unrelated compaction summaries separate", async () => {
    const server = await startMockServer();
    const summarize = async (conversation: string) => {
      const payload = await expectOpenAiNonStreamingResponsesJson(server, {
        instructions: QA_COMPACTION_SUMMARY_INSTRUCTIONS,
        input: `<conversation>\n${conversation}\n</conversation>\n\nAdditional focus: preserve exact identifiers.`,
      });
      const summary = outputText(payload);
      expectCurrentCompactionSummaryHeadings(summary);
      expect(summary).not.toContain("QA-COMPACTION-BULKY-HISTORICAL-MARKER");
      return summary;
    };
    const historical = await summarize(
      `QA-COMPACTION-BULKY-HISTORICAL-MARKER ${QA_COMPACTION_RETRY_HISTORICAL_PHRASE} 10`,
    );
    expect(historical).toContain(QA_COMPACTION_RETRY_HISTORICAL_PHRASE);
    expect(historical).not.toContain("QA-COMPACTION-DURABLE-MARKER");
    const durable = await summarize("Retain QA-COMPACTION-DURABLE-MARKER for the active task.");
    expect(durable).toContain("QA-COMPACTION-DURABLE-MARKER");
    const merged = await summarize(`${historical}\n${durable}`);
    expect(merged).toContain("QA-COMPACTION-DURABLE-MARKER");
    const unrelated = await summarize("A later unrelated scenario.");
    expect(unrelated).not.toContain("QA-COMPACTION-DURABLE-MARKER");
  });

  it("rejects Anthropic Code Mode compaction retry result with content added under another target", async () => {
    const result = {
      ...QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT,
      value: {
        ...QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT.value,
        patch: [
          "--- compaction-retry-summary.txt",
          "+++ compaction-retry-summary.txt",
          "@@ -0,0 +1 @@",
          "+Unrelated content.",
          "--- other.txt",
          "+++ other.txt",
          "@@ -0,0 +1 @@",
          "+Replay safety: unsafe after write.",
        ].join("\n"),
      },
    };

    const server = await startMockServer();
    const callId = "toolu_compaction_retry_invalid";
    const body = requireRecord(
      await expectAnthropicMessagesJson(server, {
        messages: [
          makeAnthropicUserText(
            "Compaction retry mutating tool check: read COMPACTION_RETRY_CONTEXT.md, then create compaction-retry-summary.txt and keep replay safety explicit.",
          ),
          anthropicCall("exec", {}, callId),
          makeAnthropicToolResult(callId, JSON.stringify(result)),
        ],
      }),
      "Anthropic compaction retry response",
    );
    expect(requireArray(body.content, "Anthropic response content")).not.toContainEqual({
      type: "text",
      text: "Protocol note: replay unsafe after write.",
    });
  });

  it("keeps compaction retry planning across continuation prompts", async () => {
    const server = await startMockServer();

    const writePlan = await streamOpenAi(
      server,
      userInputs(QA_COMPACTION_RETRY_PROMPT, "Continue after compaction."),
    );
    expect(await writePlan.text()).toContain('"name":"write"');

    expect(
      await openAiReply(
        server,
        userInputs(
          QA_COMPACTION_RETRY_PROMPT,
          makeToolOutput("Successfully wrote 41 bytes to compaction-retry-summary.txt"),
          "Continue after compaction.",
        ),
      ),
    ).toContain("replay unsafe after write");
  });

  it("supports exact reply memory prompts and embeddings requests", async () => {
    const server = await startMockServer();

    expect(
      await reply(
        server,
        "Please remember this fact for later: the QA canary code is ALPHA-7. Reply exactly `Remembered ALPHA-7.` once stored.",
      ),
    ).toBe("Remembered ALPHA-7.");

    const embeddingPayload = (await fetchOkJson(`${server.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: ["Project Nebula ORBIT-10", "Project Nebula ORBIT-9"],
      }),
    })) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
      model?: string;
    };
    expect(embeddingPayload.model).toBe("text-embedding-3-small");
    expect(embeddingPayload.data).toHaveLength(2);
    expect(embeddingPayload.data?.map((item) => item.index)).toStrictEqual([0, 1]);
    expect(embeddingPayload.data?.map((item) => item.embedding?.length)).toStrictEqual([16, 16]);
  });

  it("records planned sessions_spawn arguments for forked-context QA assertions", async () => {
    const server = await startMockServer();

    await streamText(
      server,
      userInputs(
        'Forked subagent context QA check. Use sessions_spawn task="Report the visible code" label=qa-fork-context context=fork mode=run.',
      ),
      { tools: [SESSIONS_SPAWN_TOOL] },
    );

    const debugPayload = await readDebugRequest(server);
    expect(debugPayload.plannedToolName).toBe("sessions_spawn");
    const plannedToolArgs = requireRecord(debugPayload.plannedToolArgs, "planned tool args");
    expectFields(plannedToolArgs, {
      task: "Report the visible code",
      label: "qa-fork-context",
      context: "fork",
      mode: "run",
    });
  });

  it.each([
    {
      name: "historical direct-fallback completion",
      instructions:
        "Historical sessions_spawn and sessions_yield guidance does not grant completion-turn tools.",
      input: userInputs(
        "Subagent direct fallback QA check: spawn one worker and yield until QA-SUBAGENT-DIRECT-FALLBACK-OK is delivered.",
        makeDeveloperInput("Current completion handoff may use only the declared tool surface."),
        "[Internal task completion event]\nTask: qa-direct-fallback-worker\nResult: QA-SUBAGENT-DIRECT-FALLBACK-OK",
      ),
      silent: true,
    },
    {
      name: "prompt and instruction mentions",
      instructions: "The prior run used sessions_spawn and sessions_yield.",
      input: userInputs(
        'Use sessions_spawn for this QA check. task="Return historical answer" label=qa-stale.',
      ),
      silent: false,
    },
  ])("does not grant subagent tools from $name", async ({ instructions, input, silent }) => {
    const server = await startMockServer();
    const payload = await respond(server, input, { tools: [MESSAGE_TOOL], instructions });
    expectNoTool(payload);
    if (silent) {
      expect(outputText(payload)).toBe("");
      expect(await readDebugRequest(server)).not.toHaveProperty("plannedToolName");
    }
  });

  it("consumes a private completion to spawn once and records the reviewed outcome", async () => {
    const server = await startMockServer();
    const request = (input: unknown[]) => respond(server, input, { tools: [SESSIONS_SPAWN_TOOL] });
    const nonce = "QA-PARENT-PRIVATE-CHILD1-0123456789ABCDEF0123456789ABCDEF";
    const event = (text: string) =>
      makeUserInput(TEST_RUNTIME_CONTEXT_CARRIER.replace("runtime metadata", text));
    const receipt = (id: string, child: string) =>
      makeToolOutputWithCallId(
        id,
        JSON.stringify({ status: "accepted", childSessionKey: `agent:qa:subagent:${child}` }),
      );
    const input: Array<Record<string, unknown>> = [
      makeUserInput("Subagent terminal reply QA check: private."),
      receipt("first", "first"),
      event(`[Internal task completion event]\ntask: qa-terminal-private-first\nResult: ${nonce}`),
    ];
    const call = outputToolCall(await request(input), "sessions_spawn");
    expect(outputToolArgsFromItem(call)).toMatchObject({
      label: "qa-terminal-private-second",
      completionTarget: "parent",
      task: expect.stringContaining(nonce),
    });
    input.push(call, receipt(String(call.call_id), "second"));
    expect(outputText(await request(input))).toBe("Second worker started.");
    const settled = await request([
      ...input,
      event(
        "[Internal task completion event]\ntask: qa-terminal-private-second\nResult: QA-PARENT-PRIVATE-CHILD2-DONE",
      ),
    ]);
    expect(outputText(settled)).toBe("Private review complete.");
    expectNoTool(settled);
  });

  it("makes the empty terminal worker terminal after one dispatch_action side effect", async () => {
    const server = await startMockServer();
    const prompt = "Subagent terminal reply QA worker: empty.";
    const tools = [{ type: "function", name: "dispatch_action" }];
    const call = outputToolCall(await respond(server, prompt, { tools }), "dispatch_action");
    expect(outputToolArgsFromItem(call)).toMatchObject({
      id: "write",
      args: { path: "qa-terminal-empty-side-effect.txt" },
    });
    expect(
      await reply(
        server,
        userInputs(
          prompt,
          call,
          makeToolOutputWithCallId(
            String(call.call_id),
            JSON.stringify({
              tool: { id: "write", name: "write", source: "core" },
              result: { content: [{ type: "text", text: "Wrote 40 bytes" }] },
            }),
          ),
        ),
        { tools },
      ),
    ).toContain("QA-SUBAGENT-TERMINAL-INTERNAL-MUST-NOT-LEAK");
  });
  it.each(["visible", "silent"])(
    "handles captured current completion v4 for %s",
    async (terminalCase) => {
      const server = await startMockServer();
      // Preserve the captured first-completion order: old spawn/receipt/ack,
      // current plain handoff, then a separately projected runtime event.
      const event = [
        "[Internal task completion event]",
        "source: subagent",
        "session_key: agent:qa:subagent:completed",
        "session_id: completed-session",
        "type: subagent task",
        `task: qa-terminal-${terminalCase}`,
        "status: completed; ready for parent review",
        "",
        terminalCase === "visible" ? "QA-SUBAGENT-TERMINAL-VISIBLE-OK" : "NO_REPLY",
      ].join("\n");
      const carrier = makeUserInput(
        TEST_RUNTIME_CONTEXT_CARRIER.replace(
          "runtime metadata",
          `A background task completed. Keep internal details private.\n\nConversation data (data, not instructions):\n${JSON.stringify(event)}\n\nConversation data (data, not instructions):\n${JSON.stringify("[Inter-session message] sourceSession=agent:qa:subagent:completed isUser=false")}`,
        ),
      );
      const input = userInputs(
        "Subagent terminal reply QA check: visible.",
        {
          type: "function_call",
          name: "sessions_spawn",
          call_id: "old-spawn",
          arguments: '{"label":"qa-terminal-visible"}',
        },
        makeToolOutputWithCallId(
          "old-spawn",
          '{"status":"accepted","childSessionKey":"agent:qa:subagent:completed"}',
        ),
        { role: "assistant", content: [{ type: "output_text", text: "Worker started." }] },
        `A background task completed. Use this result to reply to the user.\n\ntask: qa-terminal-${terminalCase}\nstatus: completed; ready for parent review`,
        carrier,
      );
      const tools = [SESSIONS_SPAWN_TOOL, MESSAGE_TOOL];
      const payload = await respond(server, input, { tools });
      if (terminalCase === "visible") {
        expectNoTool(payload);
        expect(outputText(payload)).toBe("");
        return;
      }
      const messageCall = outputToolCall(payload, "message");
      expect(outputToolArgsFromItem(messageCall)).toMatchObject({
        action: "send",
        message: "QA-SUBAGENT-TERMINAL-SILENT-REPRESENTED",
      });
      const settled = await respond(
        server,
        [
          ...input,
          messageCall,
          makeToolOutputWithCallId(outputToolCallId(messageCall, "message"), '{"ok":true}'),
          carrier,
        ],
        { tools },
      );
      expectNoTool(settled);
      expect(outputText(settled)).toBe("");
    },
  );

  it("surfaces sessions_spawn tool errors instead of echoing child-task tokens", async () => {
    const server = await startMockServer();

    const text = await reply(
      server,
      userInputs(
        explicitSessionsSpawnPrompt(THREAD_SUBAGENT_CHILD_ERROR_TOKEN),
        functionCall("sessions_spawn", {
          task: threadSubagentTask(THREAD_SUBAGENT_CHILD_ERROR_TOKEN),
          label: "qa-thread-subagent",
          thread: true,
          mode: "session",
        }),
        makeToolOutput(JSON.stringify({ status: "error", error: THREAD_SUBAGENT_TOOL_ERROR })),
      ),
      { tools: [SESSIONS_SPAWN_TOOL] },
    );
    expect(text).toContain(THREAD_SUBAGENT_TOOL_ERROR);
    expect(text).not.toContain(THREAD_SUBAGENT_CHILD_ERROR_TOKEN);
  });

  it("plans memory tools and serves mock image generations", async () => {
    const server = await startMockServer();
    const prompt =
      "Memory tools check: what is the hidden project codename stored only in memory? Use memory tools first.";
    expect(await streamText(server, prompt)).toContain('"name":"memory_search"');
    const body = await streamText(
      server,
      userInputs(
        prompt,
        makeToolOutput(
          JSON.stringify({
            results: [
              {
                path: "MEMORY.md",
                snippet: "Hidden QA fact: the project codename is ORBIT-9.",
              },
            ],
          }),
        ),
        "Protocol note: acknowledged. Continue with the QA scenario plan.",
      ),
    );
    expectIncludes(body, '"name":"memory_get"', '\\"path\\":\\"MEMORY.md\\"', '\\"from\\":1');
    const request = {
      model: "gpt-image-1",
      prompt: "Draw a QA lighthouse",
      n: 1,
      size: "1024x1024",
    };
    const image = await expectOk(postJson(server, "/v1/images/generations", request));
    const data = requireArray(
      requireRecord(await image.json(), "image response").data,
      "image data",
    );
    expect(typeof requireRecord(data[0], "image data 0").b64_json).toBe("string");
    const log = requireArray(await getJson(server, "/debug/image-generations"), "image requests");
    expectFields(requireRecord(log[0], "image request 0"), request);
  });
  it("requires memory_get before answering thread recall in Code Mode", async () => {
    const server = await startMockServer();
    const prompt = makeUserInput(
      "Thread memory check: what is the hidden thread codename stored only in memory?",
    );
    const search = outputToolCall(
      await respondOpenAi(server, [
        { type: "additional_tools", role: "developer", tools: CODE_MODE_TOOLS },
        prompt,
      ]),
      "exec",
    );
    const searchId = outputToolCallId(search, "call_mock_memory_search");
    const input = [
      prompt,
      search,
      makeToolOutputWithCallId(
        searchId,
        completedResult({
          results: [
            { path: "MEMORY.md", startLine: 1, snippet: "Thread-hidden codename: ORBIT-21." },
          ],
        }),
      ),
    ];
    const pending = await respondOpenAi(server, input);
    const get = outputToolCall(pending, "memory_get");
    const getId = outputToolCallId(get, "call_mock_memory_get");
    expect(getId).not.toBe(searchId);
    expect(outputItems(pending).some((item) => item.type === "message")).toBe(false);
    expect(JSON.stringify(pending)).not.toContain("hidden thread codename is ORBIT-21");
    const final = await respondOpenAi(server, [
      ...input,
      get,
      makeToolOutputWithCallId(
        getId,
        completedResult({ text: "Thread-hidden codename: ORBIT-22." }),
      ),
    ]);
    expectIncludes(outputText(final), "ORBIT-22");
    expect(outputText(final)).not.toContain("ORBIT-21");
    expectNoTool(final);
  });
  it("covers distinct memory search, retrieval, ranking, and injection branches", async () => {
    const server = await startMockServer();
    const ranking =
      "Session memory ranking check: what is the current Project Nebula codename? Use memory tools first.";
    const thread =
      "@openclaw Thread memory check: what is the hidden thread codename stored only in memory? Use memory tools first and reply only in this thread.";
    const snack = "lemon pepper wings with blue cheese";
    const snackPrompt =
      "Silent snack recall check: what snack do I usually want for QA movie night? Reply in one short sentence.";
    const rememberPrompt =
      "Remember across conversations QA check: what snack do I usually want for QA movie night?";
    const agent = (prompt: string) => `You are a memory search agent.\n${prompt}`;
    const out = (value: unknown) => makeToolOutput(JSON.stringify(value));
    const hit = (path: string, snippet?: string, startLine?: number, endLine?: number) => ({
      path,
      snippet,
      startLine,
      endLine,
    });
    const results = (...entries: ReturnType<typeof hit>[]) => out({ results: entries });
    const fact = "Thread-hidden codename: ORBIT-22.";
    const hidden = "hidden thread codename is ORBIT-22";
    const ack = makeUserInput("Protocol note: acknowledged. Continue with the QA scenario plan.");
    const path = "sessions/qa-session-memory-ranking.jsonl";
    const current = hit(path, "Project Nebula current codename: ORBIT-10.", 2, 3);
    const stale = hit("MEMORY.md", "Project Nebula stale codename: ORBIT-9.", 1, 2);
    const injected = `<active_memory_plugin>User usually wants ${snack} for QA movie night.</active_memory_plugin>`;
    const system = (prefix = "") => ({
      role: "system",
      content: prefix + "## /workspace/MEMORY.md\n" + fact,
    });
    type Case = [
      name: string,
      input: unknown[],
      includes: string[],
      excludes?: string[],
      instructions?: string,
    ];
    const cases: Case[] = [
      ["ranking search", userInputs(ranking), ['"name":"memory_search"'], ['\\"corpus\\"']],
      ["instruction-only thread search", [ack], ['"name":"memory_search"', "ORBIT-22"], [], thread],
      [
        "direct thread search result",
        [results(hit("MEMORY.md", fact, 1, 1)), ack],
        ['"name":"memory_get"', '\\"path\\":\\"MEMORY.md\\"'],
        [hidden],
        thread,
      ],
      ["direct thread read", [out({ text: fact }), ack], ["ORBIT-22"], [], thread],
      [
        "unstructured thread output",
        [makeToolOutput("Thread-hidden codename: ORBIT-23."), ack],
        ["NONE"],
        ["ORBIT-23"],
        thread,
      ],
      [
        "unavailable memory does not use system facts",
        userInputs(
          system("Available tools include sessions_spawn.\n"),
          thread,
          out({ results: [], unavailable: true, error: "database is not open" }),
        ),
        ["NONE"],
        ["ORBIT-22"],
      ],
      [
        "empty memory does not use system facts",
        userInputs(system(), thread, out({ results: [] })),
        ["NONE"],
        ["ORBIT-22"],
      ],
      [
        "session ranking wins over stale file",
        userInputs(ranking, results(stale, current)),
        ["Protocol note: I checked memory and the current Project Nebula codename is ORBIT-10."],
      ],
      [
        "missing ranking snippet requires read",
        userInputs(ranking, results(hit(path, undefined, 2, 3))),
        ['"name":"memory_get"'],
        ["codename is ORBIT-10"],
      ],
      [
        "unavailable ranking result",
        userInputs(
          ranking,
          out({ results: [current], unavailable: true, error: "database is not open" }),
        ),
        ["NONE"],
        ["codename is ORBIT-10"],
      ],
      [
        "ranking uses returned value",
        userInputs(ranking, results(hit(path, "Project Nebula current codename: ORBIT-9."))),
        ["codename is ORBIT-9"],
        ["codename is ORBIT-10"],
      ],
      ["snack search", userInputs(agent(snackPrompt)), ['"name":"memory_search"']],
      [
        "snack read",
        userInputs(
          agent(snackPrompt),
          out({ text: `Stable QA movie night snack preference: ${snack}.` }),
        ),
        [snack],
      ],
      ["injected snack", userInputs(snackPrompt), [snack], [], "System context:\n" + injected],
      [
        "cross-conversation search",
        userInputs(agent(rememberPrompt)),
        [
          '"name":"memory_search"',
          "QA movie night snack lemon pepper wings blue cheese",
          '\\"maxResults\\":10',
        ],
      ],
      [
        "cross-conversation snippet",
        userInputs(
          agent(rememberPrompt),
          results(
            hit(
              "sessions/private-source.jsonl",
              `Stable QA movie night snack preference: ${snack}.`,
              2,
              3,
            ),
          ),
        ),
        [snack],
        ['"name":"memory_get"'],
      ],
      ["cross-conversation injection", userInputs(rememberPrompt), [snack], [], injected],
    ];
    for (const [_name, input, included, excluded, instructions] of cases) {
      const text = JSON.stringify(await respond(server, input, { instructions }));
      expectIncludes(text, ...included);
      expectExcludes(text, ...(excluded ?? []));
    }
  });

  it.each([
    { name: "combined completion", combined: true, canDeliver: true, final: false },
    { name: "separate completions", combined: false, canDeliver: true, final: true },
    { name: "zero-tool completions", combined: false, canDeliver: false, final: false },
  ])(
    "delivers private fanout through the permitted surface for $name",
    async ({ combined, canDeliver, final }) => {
      const server = await startMockServer();
      const tools = combined ? [SESSIONS_SPAWN_TOOL, MESSAGE_TOOL] : [SESSIONS_SPAWN_TOOL];
      await startFanout(
        server,
        tools,
        JSON.stringify({
          status: "accepted",
          childSessionKey: "agent:qa:subagent:alpha",
          ...(combined ? { note: "ALPHA-OK" } : {}),
        }),
      );
      const instructions = final
        ? "Visible source replies are not automatically delivered for this run. Use `message(action=send)` for user-visible source-channel output. For progress, set `final=false`. When the message is the completed reply to the current source conversation, set `final=true`; OpenClaw stops after confirming delivery."
        : "Current source visible reply MUST use `message(action=send)`; final text is private. Skip tool = user gets nothing.";
      const withInstructions = (input: unknown[]) => ({
        ...(final ? { instructions: "Follow the unrelated Codex base instructions." } : {}),
        input: [makeDeveloperInput(instructions), ...input],
      });
      for (const markers of combined ? [["ALPHA-OK", "BETA-OK"]] : [["ALPHA-OK"], ["BETA-OK"]]) {
        const input = userInputs(
          QA_FANOUT_PROMPT,
          `[Internal task completion event]\n${markers.map((marker) => `result: ${marker}`).join("\n")}`,
        );
        const request = {
          tools: combined ? tools : canDeliver ? [MESSAGE_TOOL] : [],
          ...withInstructions(input),
        };
        const completion = await expectNonStreamingResponsesJson(server, request);
        if (!canDeliver || !markers.includes("BETA-OK")) {
          expectNoTool(completion);
          expect(outputText(completion)).toBe("");
          continue;
        }
        const message = outputToolCall(completion, "message");
        expect(outputToolArgsFromItem(message)).toEqual({
          action: "send",
          message: "subagent-1: ok\nsubagent-2: ok",
          ...(final ? { final: true } : {}),
        });
        if (combined) {
          const settled = await expectNonStreamingResponsesJson(server, {
            ...request,
            ...withInstructions([
              ...input,
              message,
              makeToolOutputWithCallId(
                outputToolCallId(message, "call_mock_message_fanout"),
                '{"ok":true,"messageId":"qa-fanout-final"}',
              ),
            ]),
          });
          expectNoTool(settled);
          expect(outputText(settled)).toBe("");
        }
      }
      if (!canDeliver) {
        const wake = await respond(
          server,
          userInputs(
            QA_FANOUT_PROMPT,
            "[Subagent Context] Every subagent in this batch has now settled.\n[Subagent Context] Review the completion results and send your consolidated final answer to the user now.\nALPHA-OK\nBETA-OK",
          ),
          { tools: [SESSIONS_SPAWN_TOOL] },
        );
        expectNoTool(wake);
        expect(outputText(wake)).toBe("subagent-1: ok\nsubagent-2: ok");
      }
    },
  );

  it("replays completed subagent fanout on requester-settle continuation turns", async () => {
    const server = await startMockServer();
    const prompt = QA_FANOUT_PROMPT;
    await startFanout(
      server,
      [SESSIONS_SPAWN_TOOL],
      '{"status":"accepted","childSessionKey":"agent:qa:subagent:alpha","note":"ALPHA-OK"}',
    );

    expect(
      await reply(
        server,
        userInputs(
          prompt,
          "[Subagent Context] Every subagent in this batch has now settled.\nALPHA-OK\nBETA-OK",
        ),
        { tools: [SESSIONS_SPAWN_TOOL] },
      ),
    ).toBe("subagent-1: ok\nsubagent-2: ok");

    const settledPayload = await respond(
      server,
      userInputs(
        prompt,
        "[Inter-session message]\nALPHA-OK\nBETA-OK\nAll spawned subagents have settled. Resume the parent turn and report both results together.",
      ),
      { tools: [SESSIONS_SPAWN_TOOL] },
    );
    expect(outputText(settledPayload)).toBe("subagent-1: ok\nsubagent-2: ok");
    expect(outputItems(settledPayload)).not.toContainEqual(
      expect.objectContaining({ type: "function_call", name: "sessions_spawn" }),
    );

    expect(
      await reply(server, "Continue with an unrelated conversation.", {
        tools: [SESSIONS_SPAWN_TOOL],
      }),
    ).not.toBe("subagent-1: ok\nsubagent-2: ok");

    const restartedFanout = await readResponse(server, prompt, { tools: [SESSIONS_SPAWN_TOOL] });
    expect(
      outputToolArgsFromItem(outputToolCall(await restartedFanout.json(), "sessions_spawn")),
    ).toEqual(expect.objectContaining({ label: "qa-fanout-alpha" }));
  });

  it("keeps source discovery reports out of subagent handoff prose", async () => {
    const server = await startMockServer();

    const text = await reply(
      server,
      userInputs(
        "Read the seeded docs and source plan, then report grouped into Worked, Failed, Blocked, and Follow-up.",
        makeToolOutput(
          "repo/qa/scenarios/index.yaml includes scenario: subagent-handoff and repo/extensions/qa-lab/src/suite.ts.",
        ),
        "Continue.",
      ),
    );
    expectIncludes(text, "Worked:", "repo/docs/help/testing.md", "Follow-up:");
    expect(text).not.toContain("Delegated task");
  });

  it("does not let fanout completion state hijack child worker replies", async () => {
    const server = await startMockServer();
    await startFanout(
      server,
      [SESSIONS_SPAWN_TOOL],
      '{"status":"accepted","childSessionKey":"agent:qa:subagent:alpha","note":"ALPHA-OK"}',
    );

    expect(
      await reply(
        server,
        "Fanout worker alpha: inspect the QA workspace and finish with exactly ALPHA-OK.",
      ),
    ).toBe("ALPHA-OK");
  });

  it("reads only current WhatsApp sticker context", async () => {
    const server = await startMockServer();
    const history = userInputs(
      WHATSAPP_STRUCTURED_SETUP_INPUT,
      "Reply with only this exact marker: QA_DOCUMENT_OK",
    );
    for (const sessionVersion of [3, 4] as const) {
      const sticker = makeWhatsAppStructuredInput(
        "[User sent media without caption]",
        "sticker",
        sessionVersion,
      );
      const cases = [
        { input: sticker, expected: "QA_WHATSAPP_STICKER_OK" },
        {
          input: [...sticker, ...makeWhatsAppStructuredInput("", "image", sessionVersion)],
          expected: "QA_DOCUMENT_OK",
        },
        {
          input: [...sticker, makeUserInput("A later ordinary message")],
          expected: "QA_DOCUMENT_OK",
        },
        { input: [...sticker, makeUserInput("<contact>")], expected: "QA_WHATSAPP_CONTACT_OK" },
        {
          input: [...sticker, makeUserInput("📍 37.774900, -122.419400")],
          expected: "QA_WHATSAPP_LOCATION_OK",
        },
        {
          input: [
            makeImageUserInput({ type: "input_image", image_url: "data:image/webp;base64,AA==" }),
          ],
          expected: "QA_DOCUMENT_OK",
        },
      ];
      for (const { input, expected } of cases) {
        expect(await reply(server, [...history, ...input])).toBe(expected);
      }
    }
  });

  it("detects each WhatsApp structured body after a channel envelope", async () => {
    const server = await startMockServer();
    const setupInput = WHATSAPP_STRUCTURED_SETUP_INPUT;

    for (const structuredCase of WHATSAPP_STRUCTURED_CASES) {
      expect(
        await reply(server, [
          setupInput,
          makeUserInput("Reply with only this previous document marker: QA_WHATSAPP_DOCUMENT_OK"),
          ...makeWhatsAppStructuredInput(
            `[WhatsApp +15555550123] +15555550123: ${structuredCase.body}`,
            "mediaKind" in structuredCase ? structuredCase.mediaKind : undefined,
          ),
        ]),
      ).toBe(structuredCase.expected);
    }
  });

  it("uses image generation directives from request context when the latest user text is generic", async () => {
    const server = await startMockServer();
    const input = userInputs(
      '@qa-sut.example.test /tool image_generate action=generate prompt="QA lighthouse image for Matrix delivery testing" size=1024x1024 count=1',
      "Continue with the QA scenario plan and report worked, failed, and blocked items.",
    );
    const call = outputToolCall(
      await respond(server, input, { tools: [IMAGE_GENERATE_TOOL] }),
      "image_generate",
    );
    expect(String(call.arguments)).toContain("qa-lighthouse.png");
    expect(
      await reply(server, [
        ...input,
        functionCall(
          "image_generate",
          { prompt: "A QA lighthouse", filename: "qa-lighthouse.png" },
          "image",
        ),
        makeToolOutputWithCallId(
          "image",
          JSON.stringify({ details: { media: { mediaUrls: ["/tmp/qa-lighthouse.png"] } } }),
        ),
      ]),
    ).toContain("Attachment: /tmp/qa-lighthouse.png");
  });

  it("completes an image without replaying a tool unavailable to the completion turn", async () => {
    const server = await startMockServer();
    const prompt = "Image generation check: generate a QA lighthouse image.";
    const call = outputToolCall(
      await respond(server, prompt, { tools: [IMAGE_GENERATE_TOOL] }),
      "image_generate",
    );
    const completion = await respond(
      server,
      userInputs(
        prompt,
        call,
        makeToolOutputWithCallId(
          outputToolCallId(call, "image"),
          JSON.stringify({
            content: [{ type: "text", text: "Background image generation started." }],
            details: { async: true, status: "started" },
          }),
        ),
        [
          "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
          "OpenClaw runtime context (internal):",
          "",
          "[Internal task completion event]",
          "source: image_generation",
          "status: completed successfully",
          "MEDIA:/tmp/qa-lighthouse.png",
          "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        ].join("\n"),
      ),
      { tools: [MESSAGE_TOOL] },
    );
    expectNoTool(completion, "image_generate");
    expect(outputText(completion)).toBe(
      "Protocol note: generated the QA lighthouse image successfully.\nMEDIA:/tmp/qa-lighthouse.png",
    );
  });
  it.each([
    [
      "plans QA tool-search failure calls with denied-input args",
      {
        input: userInputs(
          "tool search qa failure target=web_search. Exercise the denied-input path once and then summarize.",
        ),
      },
      "web_search",
      "OPENCLAW_QA_WEB_SEARCH_DENIED_INPUT",
    ],
    [
      "plans one structured batch search for the Tool Search gateway fixture",
      {
        tools: [{ type: "function", name: "tool_search" }],
        input: userInputs(
          "tool search qa check target=fake_plugin_tool_17. Call exactly that tool once and then summarize.",
        ),
      },
      "tool_search",
      {
        queries: [
          { query: "fake_plugin_tool_17", limit: 1 },
          { query: QA_TOOL_SEARCH_SECONDARY_TARGET, limit: 1 },
        ],
      },
    ],
  ] as const)("%s", async (_name, body, tool, args) => {
    const item = outputItem(await expectNonStreamingResponsesJson(await startMockServer(), body));
    expectFields(item, { type: "function_call", name: tool });
    if (typeof args === "string") {
      expect(String(item.arguments)).toContain(args);
    } else {
      expect(JSON.parse(String(item.arguments))).toEqual(args);
    }
  });

  const catalogTarget = "fake_plugin_tool_17";
  const catalogQueries = [
    { query: catalogTarget, limit: 1 },
    { query: QA_TOOL_SEARCH_SECONDARY_TARGET, limit: 1 },
  ];
  it.each([
    {
      name: "calls the selected catalog tool after a structured batch search",
      tools: ["tool_search", "dispatch_action"],
      callName: "tool_search",
      callId: "call_tool_search_1",
      args: { queries: catalogQueries },
      output: JSON.stringify({
        results: catalogQueries.map(({ query }) => ({ query, candidates: [{ name: query }] })),
      }),
      invokes: true,
    },
    {
      name: "does not call a catalog tool when structured search returns no matching candidate",
      tools: ["tool_search", "dispatch_action"],
      callName: "tool_search",
      callId: "call_tool_search_1",
      args: { queries: [{ query: catalogTarget, limit: 1 }] },
      output: JSON.stringify({ results: [{ query: catalogTarget, candidates: [] }] }),
      invokes: false,
    },
  ])("$name", async ({ tools, callName, callId, args, output, invokes }) => {
    const payload = await respond(
      await startMockServer(),
      userInputs(
        `tool search qa check target=${catalogTarget}. Call exactly that tool once and then summarize.`,
        functionCall(callName, args, callId),
        makeToolOutputWithCallId(callId, output),
      ),
      { tools: tools.map((name) => ({ type: "function", name })) },
    );
    const item = outputItem(payload);
    if (invokes) {
      expectFields(item, { type: "function_call", name: "dispatch_action" });
      expect(JSON.parse(String(item.arguments))).toMatchObject({ id: catalogTarget });
    } else {
      expect(item.name).not.toBe("dispatch_action");
    }
  });

  it.each([
    {
      fixture: "single",
      expectedQuestionId: "deploy_target",
      expectedMultiSelect: undefined,
    },
    { fixture: "multi", expectedQuestionId: "checks", expectedMultiSelect: true },
  ])("plans the $fixture ask_user Telegram fixture", async (entry) => {
    const server = await startMockServer();
    const response = await readResponse(
      server,
      `tool search qa check target=ask_user ask_user_fixture=${entry.fixture}. Ask the question.`,
    );

    const call = outputItem(await response.json());
    const args = JSON.parse(String(call.arguments)) as {
      questions?: Array<{ id?: string; multiSelect?: boolean }>;
    };
    expect(call.name).toBe("ask_user");
    expect(args.questions).toHaveLength(1);
    expect(args.questions?.[0]).toMatchObject({
      id: entry.expectedQuestionId,
      ...(entry.expectedMultiSelect ? { multiSelect: true } : {}),
    });
  });

  it.each([
    {
      label: "non-text native patch output",
      prompt:
        "tool search qa check target=apply_patch. Call apply_patch exactly once and then summarize.",
      output: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }],
      expectedOutput: "",
      structuredError: false,
    },
    {
      label: "empty failed native patch output",
      prompt:
        "tool search qa failure target=apply_patch. Exercise the denied-input path once and then summarize.",
      output: "",
      expectedOutput: "",
      structuredError: true,
    },
  ])("links and completes $label custom-tool outputs", async (testCase) => {
    const server = await startMockServer();
    const planResponse = await readResponse(server, testCase.prompt);
    const plannedCall = outputItem(await planResponse.json());
    expect(plannedCall).toMatchObject({ type: "function_call", name: "apply_patch" });
    const callId = outputToolCallId(plannedCall, "native-patch-call");

    const continuationResponse = await readResponse(
      server,
      userInputs(testCase.prompt, {
        type: "custom_tool_call_output",
        call_id: callId,
        output: testCase.output,
        ...(testCase.structuredError ? { is_error: true } : {}),
      }),
    );
    expect(outputItem(await continuationResponse.json()).type).toBe("message");

    const debug = await readDebugRequest(server);
    expectFields(debug, { toolOutput: testCase.expectedOutput, toolOutputCallId: callId });
    if (testCase.structuredError) {
      expect(debug.toolOutputStructuredError).toBe(true);
    } else {
      expect(debug).not.toHaveProperty("toolOutputStructuredError");
    }
    expect(debug).not.toHaveProperty("plannedToolName");
  });

  let nestedImageInput: unknown = QA_IMAGE_INPUT;
  for (let index = 0; index < 4_000; index += 1) {
    nestedImageInput = [textBlock("nested"), nestedImageInput];
  }
  it.each([
    [
      "uses current request instructions for deeply nested image descriptions",
      [
        makeDeveloperInput(QA_IMAGE_DESCRIPTION_PROMPT),
        makeImageUserInput(nestedImageInput, QA_IMAGE_MEDIA_CONTEXT),
      ],
      ["red", "blue"],
    ],
    [
      "describes reattached generated images in the roundtrip flow",
      [
        makeImageUserInput(
          textBlock(
            "Roundtrip image inspection check: describe the generated lighthouse attachment in one short sentence.",
          ),
          QA_IMAGE_INPUT,
        ),
      ],
      ["lighthouse"],
    ],
  ] as const)("%s", async (_name, input, words) => {
    const server = await startMockServer();
    const text = (await readMockImageResponseText(server, [...input])).toLowerCase();
    for (const word of words) {
      expect(text).toContain(word);
    }
    expect((await readDebugRequest(server)).imageInputCount).toBe(1);
  });

  it("rereads the current model-switch turn before reporting continuity", async () => {
    const server = await startMockServer();

    const response = await streamResponse(
      server,
      userInputs(
        "Read QA_KICKOFF_TASK.md first.",
        makeToolOutput("QA mission: read source and docs first."),
        "Switch models now. Tool continuity check: reread QA_KICKOFF_TASK.md and mention the handoff in one short sentence.",
      ),
    );
    expect(await response.text()).toContain('"name":"read"');

    expect(
      await reply(
        server,
        userInputs(
          "Switch models now. Tool continuity check: reread QA_KICKOFF_TASK.md and mention the handoff in one short sentence.",
          makeToolOutput(
            "QA mission: Understand this OpenClaw repo from source + docs before acting.",
          ),
        ),
        { model: "gpt-5.6-luna-alt" },
      ),
    ).toContain("model switch handoff confirmed");
  });

  it("returns the Codex remote-compaction-v2 response shape", async () => {
    const server = await startMockServer();

    const response = await streamResponse(
      server,
      userInputs("Retained context.", { type: "compaction_trigger" }),
    );

    const body = await response.text();
    expectIncludes(
      body,
      '"type":"response.output_item.done"',
      '"type":"compaction"',
      '"encrypted_content":"QA_MOCK_REMOTE_COMPACTION_SUMMARY"',
      '"type":"response.completed"',
    );
    expect(await getJson(server, "/debug/requests")).toEqual([]);
  });

  it.each([
    {
      name: "baseline",
      options: undefined,
      ids: ["claude-opus-4-8", "gpt-5.6-luna", "gpt-4o-transcribe"],
    },
    {
      name: "selected target-era",
      options: { modelRefs: ["mock-openai/gpt-5.5", "mock-openai/gpt-5.5-alt"] },
      ids: ["gpt-5.5", "gpt-5.5-alt", "gpt-image-1"],
    },
  ])("advertises $name models on /v1/models", async ({ options, ids }) => {
    const server = await startMockServer(options);
    const body = (await fetchOkJson(`${server.baseUrl}/v1/models`)) as {
      data: Array<{ id: string }>;
    };
    expect(body.data.map((entry) => entry.id)).toEqual(expect.arrayContaining(ids));
  });

  it("transcribes channel audio trigger variants", async () => {
    const server = await startMockServer();
    for (const { body, text } of [
      {
        body: '--qa\r\ncontent-disposition: form-data; name="file"; filename="upload.ogg"\r\n\r\nOPENCLAW_QA_GROUP_AUDIO_TRIGGER\r\n--qa--\r\n',
        text: "openclawqa reply with only this exact marker after group audio preflight: WHATSAPP_QA_GROUP_AUDIO_TRANSCRIPT_OK",
      },
      {
        body: '--qa\r\ncontent-disposition: form-data; name="file"; filename="upload.ogg"\r\n\r\nx\r\n--qa--\r\n',
        text: "Reply with only this exact marker: WHATSAPP_QA_AUDIO_TRANSCRIPT_OK",
      },
      {
        body: '--qa\r\ncontent-disposition: form-data; name="file"; filename="audio.wav"\r\n\r\nfixture audio\r\n--qa\r\ncontent-disposition: form-data; name="prompt"\r\n\r\nMATRIX_QA_VOICE_PREFLIGHT_TRIGGER\r\n--qa--\r\n',
        text: "C3PLQA reply with only these words Matrix QA voice pre-flight OK.",
      },
    ]) {
      const response = await fetchOk(`${server.baseUrl}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=qa" },
        body,
      });
      await expect(response.json()).resolves.toEqual({ text });
    }
  });

  it("preserves already-native Anthropic tool IDs", () => {
    const events: StreamEvent[] = [
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "function_call", name: "read", call_id: "toolu_native_123", arguments: "{}" },
      },
    ];
    expect(adaptAnthropicToolCallIds(events)).toMatchObject([
      { item: { call_id: "toolu_native_123" } },
    ]);
  });
  it("uses native Codex custom exec, output arrays, and cell_id waits", async () => {
    const server = await startMockServer();
    const tools = NATIVE_CODE_MODE_TOOLS;
    const prompt = QA_COMPACTION_RETRY_PROMPT;
    const execPayload = await respondOpenAi(server, prompt, { tools });
    const execCall = outputItem(execPayload);
    expect(execCall).toMatchObject({ type: "custom_tool_call", name: "exec" });
    const source = String(execCall.input);
    expectIncludes(source, "tools[target.name](targetArgs)", "text(JSON.stringify(value));");
    expectExcludes(source, "tools.callValue", "target.id");
    expect(source).not.toMatch(/ALL_TOOLS[^\n]*\.id/);
    expect(source).not.toContain("return value");

    const execCallId = outputToolCallId(execCall, "native-exec");
    const waitPayload = await respondOpenAi(
      server,
      userInputs(prompt, execCall, {
        type: "custom_tool_call_output",
        call_id: execCallId,
        output: [textBlock("Script running with cell ID cell-write-1\nLive output:\n")],
      }),
      { tools },
    );
    const waitCall = outputToolCall(waitPayload, "wait");
    expect(outputToolArgsFromItem(waitCall)).toEqual({ cell_id: "cell-write-1" });

    expect(
      await openAiReply(
        server,
        userInputs(
          prompt,
          execCall,
          {
            type: "custom_tool_call_output",
            call_id: execCallId,
            output: [textBlock("Script running with cell ID cell-write-1\nLive output:\n")],
          },
          waitCall,
          {
            type: "function_call_output",
            call_id: outputToolCallId(waitCall, "native-wait"),
            output: [
              textBlock("Script completed\nWall time: 0.1 seconds\nOutput:\n"),
              textBlock(completedResult({ changed: false })),
              textBlock(JSON.stringify(QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT)),
            ],
          },
        ),
        { tools },
      ),
    ).toBe("Protocol note: replay unsafe after write.");
  });

  it.each([
    {
      label: "terminated header with canonical JSON",
      output: [
        textBlock("Script terminated\nWall time: 0.1 seconds\nOutput:\n"),
        textBlock(JSON.stringify(QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT)),
      ],
    },
    {
      label: "completed header without JSON",
      output: [textBlock("Script completed\nWall time: 0.1 seconds\nOutput:\n")],
    },
  ])("rejects native Code Mode compaction evidence with $label", async ({ output }) => {
    const server = await startMockServer();
    const tools = NATIVE_CODE_MODE_TOOLS;
    const execPayload = await respondOpenAi(server, QA_COMPACTION_RETRY_PROMPT, { tools });
    const execCall = outputItem(execPayload);
    const payload = await respondOpenAi(
      server,
      userInputs(QA_COMPACTION_RETRY_PROMPT, execCall, {
        type: "custom_tool_call_output",
        call_id: outputToolCallId(execCall, "native-exec"),
        output,
      }),
      { tools },
    );

    expectNoTool(payload);
    expect(outputText(payload)).not.toBe("Protocol note: replay unsafe after write.");
  });

  it.each(["read", "exec"] as const)(
    "does not interpret unmarked %s results as Code Mode control envelopes",
    async (name) => {
      const server = await startMockServer();
      const tools =
        name === "exec"
          ? ANTHROPIC_GUEST_CODE_MODE_TOOLS
          : [
              {
                name: "read",
                input_schema: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
                },
              },
              {
                name: "wait",
                input_schema: {
                  type: "object",
                  properties: { runId: { type: "string" } },
                  required: ["runId"],
                },
              },
            ];
      const messages: Array<Record<string, unknown>> = [
        makeAnthropicUserText(
          name === "read"
            ? "Read the seeded docs and report worked, failed, blocked, and follow-up items."
            : "Direct exec envelope isolation check.",
        ),
      ];
      let toolUse: Record<string, unknown> = {
        type: "tool_use",
        id: "toolu_direct_exec",
        name: "exec",
        input: { language: "javascript", code: "return 1;" },
      };
      if (name === "read") {
        const first = await expectAnthropicMessagesJson(server, { tools, messages });
        const read = first.content.find((block) => block.type === "tool_use");
        if (!read || typeof read.id !== "string") {
          throw new Error("Expected Anthropic read tool_use block");
        }
        toolUse = read;
      }
      const id = name === "read" ? "ordinary-read" : "direct-exec";
      for (const result of [
        { status: "waiting", runId: id },
        { status: "completed", value: { status: "waiting", runId: `${id}-completed-value` } },
      ]) {
        const body = await expectAnthropicMessagesJson(server, {
          tools,
          messages: [
            ...messages,
            { role: "assistant", content: [toolUse] },
            makeAnthropicToolResult(toolUse.id, JSON.stringify(result)),
          ],
        });
        expect(body.stop_reason).toBe("end_turn");
        expect(body.content.some((block) => block.type === "tool_use")).toBe(false);
      }
    },
  );

  it("finishes Anthropic Code Mode fanout after the second wrapped spawn result", async () => {
    const server = await startMockServer();
    const prompt =
      "Subagent fanout synthesis check: delegate exactly two bounded subagents sequentially using sessions_spawn, not ACP.";
    const messages: Array<Record<string, unknown>> = [makeAnthropicUserText(prompt)];
    const request = () => {
      return expectAnthropicMessagesJson(server, {
        tools: ANTHROPIC_GUEST_CODE_MODE_TOOLS,
        messages,
      });
    };
    const appendCompletedResult = (
      toolUse: Record<string, unknown>,
      value: Record<string, unknown>,
    ) => {
      messages.push(
        { role: "assistant", content: [toolUse] },
        makeAnthropicToolResult(toolUse.id, completedResult(value)),
      );
    };
    const requireToolUse = (body: AnthropicResponse, expectedName: string) => {
      expect(body.stop_reason).toBe("tool_use");
      const toolUse = body.content.find((block) => block.type === "tool_use");
      if (!toolUse || typeof toolUse.id !== "string") {
        throw new Error("Expected Anthropic tool_use block");
      }
      expect(toolUse.name).toBe(expectedName);
      return toolUse;
    };
    const alpha = requireToolUse(await request(), "exec");
    appendCompletedResult(alpha, { status: "accepted", childSessionKey: "alpha" });
    const beta = requireToolUse(await request(), "exec");
    appendCompletedResult(beta, { status: "accepted", childSessionKey: "beta" });
    const firstYield = requireToolUse(await request(), "exec");
    appendCompletedResult(firstYield, { status: "yielded" });
    messages.push(makeAnthropicUserText("[Inter-session message]\nALPHA-OK"));
    const secondYield = requireToolUse(await request(), "exec");
    appendCompletedResult(secondYield, { status: "yielded" });
    messages.push(makeAnthropicUserText("[Inter-session message]\nBETA-OK"));

    const final = await request();
    expect(final.stop_reason).toBe("end_turn");
    expect(final.content.find((block) => block.type === "text")?.text).toBe(
      "subagent-1: ok\nsubagent-2: ok",
    );
  });

  it("preserves mixed-content Anthropic tool_result errors in debug snapshots", async () => {
    const server = await startMockServer();

    await expectAnthropicMessages(server, {
      messages: [
        anthropicCall("read", { path: "/missing" }, "toolu_mock_read_error"),
        {
          role: "user",
          content: [
            ...makeAnthropicErrorToolResult(
              "toolu_mock_read_error",
              "ENOENT: no such file or directory",
            ).content,
            { type: "text", text: "Report the read failure." },
          ],
        },
      ],
    });

    const debug = await readDebugRequest(server);
    expectFields(debug, {
      toolOutputCallId: "toolu_mock_read_error",
      toolOutputStructuredError: true,
      toolOutput: "ENOENT: no such file or directory",
      prompt: "Report the read failure.",
    });
  });

  it("preserves whitespace Anthropic tool results without replay", async () => {
    const server = await startMockServer();
    const callId = "toolu_empty_patch";
    const body = await expectAnthropicMessagesJson(server, {
      tools: [{ name: "apply_patch", input_schema: { type: "object", properties: {} } }],
      messages: [
        makeAnthropicUserText(
          "tool search qa check target=apply_patch. Call apply_patch exactly once and then summarize.",
        ),
        anthropicCall("apply_patch", {}, callId),
        makeAnthropicToolResult(callId, "  "),
      ],
    });
    expect(body.stop_reason).toBe("end_turn");
    expect(body.content).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "tool_use" })]),
    );
    const debug = await readDebugRequest(server);
    expect(debug.toolOutputCallId).toBe(callId);
    expect(debug.toolOutputStructuredError ?? false).toBe(false);
    expect(debug).not.toHaveProperty("plannedToolName");
  });

  it("replays one signed Anthropic thinking error for each independent scenario", async () => {
    const server = await startMockServer();
    const readCallIds: string[] = [];
    const stream = async (messages: unknown[]) => {
      const response = await expectAnthropicMessages(server, { stream: true, messages });
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      return response.text();
    };
    const readCall = async (prompt: string) => {
      const events = sseEvents(await stream([makeAnthropicUserText(prompt)]));
      const start = events.find(
        (event) =>
          event.type === "content_block_start" &&
          requireRecord(event.content_block, "content block").type === "tool_use",
      );
      const tool = requireRecord(start?.content_block, "read tool");
      expect(tool.name).toBe("read");
      expect(tool.input).toEqual({});
      expect(
        events.find((event) => event.type === "content_block_delta" && event.index === start?.index)
          ?.delta,
      ).toEqual({
        type: "input_json_delta",
        partial_json: JSON.stringify({ path: "QA_KICKOFF_TASK.md" }),
      });
      const id = tool.id;
      if (typeof id !== "string" || id.length === 0) {
        throw new Error("Expected an Anthropic read tool call ID");
      }
      readCallIds.push(id);
      return id;
    };
    const replay = (prompt: string, id: string) =>
      stream([
        makeAnthropicUserText(prompt),
        anthropicCall("read", { path: "QA_KICKOFF_TASK.md" }, id),
        makeAnthropicToolResult(id, "QA kickoff task completed."),
      ]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt = `${QA_ANTHROPIC_THINKING_ERROR_RECOVERY_PROMPT} QA scenario run: direct-${attempt}`;
      const initial = await readCall(prompt);
      expectIncludes(
        await replay(prompt, initial),
        '"type":"thinking_delta"',
        '"type":"signature_delta"',
        '"signature":"qa_signed_thinking_block_91953"',
        "event: error",
        '"type":"api_error"',
      );
      const retry = await readCall(prompt);
      expect(retry).not.toBe(initial);
      const recovered = await replay(prompt, retry);
      expectIncludes(recovered, "event: message_stop", "ANTHROPIC-THINKING-ERROR-RECOVERED-OK");
      expect(recovered).not.toContain("event: error");
    }
    expect(new Set(readCallIds).size).toBe(4);
  });

  it.each([
    {
      paths: ["/v1/messages"],
      bodies: ['{"model":"claude-opus-4-8","messages":[', "null", "[]", '"text"'],
      anthropic: true,
    },
    {
      paths: ["/v1/responses", "/v1/embeddings", "/v1/images/generations"],
      bodies: ["{bad", "[]", '"text"'],
      anthropic: false,
    },
  ])(
    "rejects malformed JSON without crashing (Anthropic=$anthropic)",
    async ({ paths, bodies, anthropic }) => {
      const server = await startMockServer();
      for (const path of paths) {
        for (const rawBody of bodies) {
          const response = await fetch(`${server.baseUrl}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: rawBody,
          });

          expect(response.status).toBe(400);
          const body = (await response.json()) as {
            type?: string;
            error: { type: string; message: string };
          };
          if (anthropic) {
            expect(body.type).toBe("error");
          }
          expect(body.error.type).toBe("invalid_request_error");
          expect(body.error.message).toContain("Malformed JSON body");
        }
      }

      await fetchOk(`${server.baseUrl}/healthz`);
    },
  );

  it("defaults empty-string Anthropic /v1/messages model to claude-opus-4-8", async () => {
    const server = await startMockServer();

    const body = await expectAnthropicMessagesJson(server, {
      model: "",
      max_tokens: 256,
      messages: [{ role: "user", content: "Read the plan" }],
    });
    expect(body.model).toBe("claude-opus-4-8");

    const debug = (await fetchOkJson(`${server.baseUrl}/debug/last-request`)) as { model: string };
    expect(debug.model).toBe("claude-opus-4-8");
  });

  it.each([
    {
      kind: "reasoning-only",
      prompt: QA_REASONING_ONLY_RECOVERY_PROMPT,
      retry: QA_REASONING_ONLY_RETRY_INSTRUCTION,
      expected: "REASONING-RECOVERED-OK",
    },
    {
      kind: "empty-response",
      prompt: QA_EMPTY_RESPONSE_RECOVERY_PROMPT,
      retry: QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
      expected: "EMPTY-RECOVERED-OK",
    },
  ])(
    "scripts $kind recovery after a replay-safe read",
    async ({ kind, prompt, retry, expected }) => {
      const server = await startMockServer();
      const toolPlan = await readOpenAiPromptResponseText(server, prompt);
      expectIncludes(toolPlan, '"name":"read"', "QA_KICKOFF_TASK.md");
      const output = makeToolOutput(
        "QA mission: Understand this OpenClaw repo from source + docs before acting.",
      );
      const first = await respondOpenAi(server, userInputs(prompt, output));
      if (kind === "reasoning-only") {
        const reasoningOutput = outputItem(first);
        expectFields(reasoningOutput, { type: "reasoning", id: "rs_mock_reasoning_recovery" });
        const summary = requireArray(reasoningOutput.summary, "reasoning summary");
        expect(String(requireRecord(summary[0], "reasoning summary 0").text)).toContain(
          "Need visible answer",
        );
      } else {
        expect(outputContentItem(first)).toMatchObject({ type: "output_text", text: "" });
        expect(outputText(first)).toBe("");
      }
      expect(await openAiReply(server, userInputs(prompt, retry, output))).toBe(expected);

      const requestLog = requireArray(await getJson(server, "/debug/requests"), "debug requests");
      expect(requireRecord(requestLog[0], "debug request 0").plannedToolName).toBe("read");
      expect(String(requireRecord(requestLog[1], "debug request 1").allInputText)).toContain(
        prompt,
      );
      expect(String(requireRecord(requestLog[2], "debug request 2").allInputText)).toContain(retry);
    },
  );

  it("scripts mixed reasoning-plus-blank output for the explicit model pair", async () => {
    const server = await startMockServer();

    const primary = await respondOpenAi(server, QA_MIXED_REASONING_BLANK_FALLBACK_PROMPT, {
      model: "mock-empty-primary",
    });
    expect(outputItems(primary).map((item) => item.type)).toEqual(["reasoning", "message"]);
    expect(outputText(primary, 1)).toBe(" ");

    expect(
      await openAiReply(server, QA_MIXED_REASONING_BLANK_FALLBACK_PROMPT, {
        model: "mock-visible-fallback",
      }),
    ).toBe("MODEL-FALLBACK-VISIBLE-OK");
  });

  it("scripts the GPT-5.6 Luna thinking visibility switch prompts", async () => {
    const server = await startMockServer();

    const offPayload = await respondOpenAi(server, QA_THINKING_VISIBILITY_OFF_PROMPT);
    expect(outputItem(offPayload).type).toBe("message");
    expect(outputText(offPayload)).toBe("THINKING-OFF-OK");

    const maxPayload = await respondOpenAi(server, QA_THINKING_VISIBILITY_MAX_PROMPT);
    const maxReasoning = outputItem(maxPayload);
    expectFields(maxReasoning, { type: "reasoning", id: "rs_mock_thinking_visibility_max" });
    expect(maxReasoning.summary).toEqual([]);
    expect(outputItem(maxPayload, 1).type).toBe("message");
    expect(outputText(maxPayload, 1)).toBe("THINKING-MAX-OK");

    const maxStream = await readOpenAiPromptResponseText(server, QA_THINKING_VISIBILITY_MAX_PROMPT);
    expectIncludes(maxStream, '"type":"response.output_text.delta"', '"delta":"THINKING-MAX-OK"');
    expectSlots(sseEvents(maxStream), [maxReasoning.id, outputItem(maxPayload, 1).id]);
  });

  it("keeps the reasoning-only side-effect path ready for no-auto-retry QA coverage", async () => {
    const server = await startMockServer();

    const toolPlan = await readOpenAiPromptResponseText(
      server,
      QA_REASONING_ONLY_SIDE_EFFECT_PROMPT,
    );
    expectIncludes(toolPlan, '"name":"write"', "reasoning-only-side-effect.txt");

    const sideEffectPayload = await respondOpenAi(
      server,
      userInputs(
        QA_REASONING_ONLY_SIDE_EFFECT_PROMPT,
        makeToolOutput("Successfully wrote 28 bytes to reasoning-only-side-effect.txt."),
      ),
    );
    const sideEffectOutput = outputItem(sideEffectPayload);
    expectFields(sideEffectOutput, { type: "reasoning", id: "rs_mock_reasoning_side_effect" });

    const requests = await fetchOk(`${server.baseUrl}/debug/requests`);
    expect((await requests.json()) as Array<{ allInputText?: string }>).toHaveLength(2);
  });

  it("scripts settled continuation after a side-effecting write with settled exhaustion", async () => {
    const server = await startMockServer();
    const history = await completeSideEffectScenario(server, "exhaustion");
    const recovery = makeUserInput(QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT);
    const continuation = makeUserInput(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
    const output = makeToolOutput(
      "Successfully wrote 27 bytes to qa-empty-response-side-effect.txt",
    );
    await expect(streamOpenAiText(server, [...history, recovery])).resolves.toContain(
      '"name":"write"',
    );
    const read = (...input: Parameters<typeof userInputs>) =>
      openAiReply(server, userInputs(...input));
    await expect(read(...history, recovery, output)).resolves.toBe("");
    await expect(read(...history, recovery, continuation, output)).resolves.toBe(
      "TELEGRAM-EMPTY-WRITE-RECOVERED-OK",
    );
    await expect(read(...history, recovery, continuation)).resolves.toBe(
      "TELEGRAM-EMPTY-WRITE-RECOVERED-OK",
    );
    await expect(
      read(
        [
          "Empty response after write recovery QA check: write once, then respond with exact marker: `CRON-EMPTY-WRITE-RECOVERED-OK`.",
          "This is an unattended scheduled run. If nothing needs doing, reply exactly HEARTBEAT_OK.",
        ].join("\n\n"),
        `${QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION}\nRead HEARTBEAT.md if it exists.`,
        output,
      ),
    ).resolves.toBe("CRON-EMPTY-WRITE-RECOVERED-OK");
    await expect(
      read(recovery, continuation, output, "Read HEARTBEAT.md if it exists."),
    ).resolves.toBe("HEARTBEAT_OK");
  });

  it("reports a failed Code Mode read honestly through ordinary continuation", async () => {
    const server = await startMockServer();
    const prompt =
      "Failed tool terminal recovery QA check: read the missing file, then respond with exact marker: `QA-FAILED-TOOL-FINALIZED-OK`.";

    const toolPlan = await postStream(server, prompt, {
      model: "gpt-5.6-luna",
      tools: CODE_MODE_TOOLS,
    });
    const plannedResponse = await toolPlan.text();
    expectIncludes(plannedResponse, '"name":"exec"', "qa-failed-terminal-missing-file.txt");
    const plannedRequest = requireRecord(
      await (await fetch(`${server.baseUrl}/debug/last-request`)).json(),
      "failed terminal tool plan",
    );
    expectFields(plannedRequest, { plannedToolName: "read", plannedWireToolName: "exec" });

    const failedToolOutput = makeToolOutputWithCallId(
      String(plannedRequest.plannedToolCallId),
      JSON.stringify({ status: "failed", error: "ENOENT: qa-failed-terminal-missing-file.txt" }),
    );
    expect(
      await reply(server, userInputs(prompt, failedToolOutput), {
        model: "gpt-5.6-luna",
        tools: CODE_MODE_TOOLS,
      }),
    ).toBe("The requested file could not be read: ENOENT. QA-FAILED-TOOL-FINALIZED-OK");

    expect(
      await reply(
        server,
        userInputs(
          prompt,
          makeToolOutputWithCallId(String(plannedRequest.plannedToolCallId), "file contents"),
        ),
        { model: "gpt-5.6-luna", tools: CODE_MODE_TOOLS },
      ),
    ).toBe("BUG-TOOL-DID-NOT-FAIL");
  });
  it("pins provider-specific plans for parity scenarios", async () => {
    const sourcePrompt =
      "Read the seeded docs and source plan, then report grouped into Worked, Failed, Blocked, and Follow-up.";
    const handoffPrompt =
      "Delegate one bounded QA task to a subagent. Wait for the subagent to finish.";
    for (const prompt of [sourcePrompt, handoffPrompt, QA_FANOUT_PROMPT]) {
      for (const [provider, modelId, location, path] of [
        ["openai", "gpt-5.6-luna", "workspace", "repo/qa/scenarios/index.yaml"],
        ["anthropic", "claude-opus-4-8", "docs fixture", "repo/docs/help/testing.md"],
      ]) {
        const response = await respond(await startMockServer(), userInputs(prompt), {
          model: prompt === handoffPrompt ? modelId : `${provider}/${modelId}`,
          ...(prompt === sourcePrompt ? {} : { tools: [SESSIONS_SPAWN_TOOL] }),
        });
        const args = outputToolArgs(response);
        if (prompt === sourcePrompt) {
          expect(args).toEqual({ path });
        } else {
          expect(args).toMatchObject(
            prompt === handoffPrompt
              ? {
                  label: "qa-sidecar",
                  task: `Inspect the QA ${location} and return one concise protocol note.`,
                }
              : {
                  label: "qa-fanout-alpha",
                  task: `Fanout worker alpha: inspect the QA ${location} and finish with exactly ALPHA-OK.`,
                },
          );
        }
      }
    }
  });
  /* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
  function expectTextOnly(response: unknown, text: string) {
    expect(outputText(response)).toBe(text);
    expectNoTool(response);
  }

  it("keeps forbidden sends empty through finalization", async () => {
    const server = await startMockServer();
    const sessionKey = "agent:orion:main";
    const marker = "QA-A2A-DENIED-OK";
    const kickoff = makeUserInput(
      `qa a2a message-tool mirror check. sessionKey="${sessionKey}". exact marker: \`${marker}\``,
    );
    const tools = [{ type: "function", name: "sessions_send" }];
    const request = (input: unknown[], surface = tools) =>
      respondOpenAi(server, input, { tools: surface });
    const plan = await request([kickoff]);
    const call = outputToolCall(plan, "sessions_send");
    const args = outputToolArgs(plan);
    expect(args).toMatchObject({ sessionKey, timeoutSeconds: 0 });
    expectIncludes(String(args.message), "qa group visible reply tool check", marker);
    const input = [
      kickoff,
      call,
      makeToolOutputWithCallId(
        outputToolCallId(call, "call_a2a"),
        JSON.stringify({
          status: "forbidden",
          error:
            "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
        }),
      ),
    ];
    const response = await request(input);
    expectTextOnly(response, "");
    expectTextOnly(
      await request(
        [
          ...input,
          ...outputItems(response),
          makeUserInput(
            `${QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION} If a tool failed, say so; never claim completion or success.`,
          ),
        ],
        [],
      ),
      "",
    );
    const target = await request(
      userInputs(
        kickoff,
        `qa group visible reply tool check. Use the visible room reply path. exact marker: \`${marker}\``,
      ),
      [...tools, { type: "function", name: "message" }],
    );
    expect(outputItem(target)).toMatchObject({ type: "function_call", name: "message" });
    expect(outputToolArgs(target)).toMatchObject({ action: "send", message: marker });
  });
  it.each([
    { prompt: "Telegram unsent failure QA check.", partialText: "" },
    {
      prompt: "Telegram visible partial failure QA check.",
      partialText: "TELEGRAM-VISIBLE-PARTIAL-BEFORE-FAILURE",
    },
  ])("preserves Anthropic streaming failure for $prompt", async ({ prompt, partialText }) => {
    const response = await postJson(await startMockServer(), "/v1/messages", {
      model: "qa-model",
      max_tokens: 256,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    });
    const body = await response.text();
    const expectedError = { type: "api_error", message: expect.any(String) };
    expect(response.status).toBe(200);
    const events = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    expect(events.at(-1)).toMatchObject({ type: "error", error: expectedError });
    expectExcludes(body, "event: message_stop", '"stop_reason":"end_turn"');
    expect(
      events
        .filter((event) => event.type === "content_block_delta")
        .map((event) => event.delta.text)
        .join(""),
    ).toBe(partialText);
  });

  it("keeps cursor reads correct when retained debug requests rotate", async () => {
    const server = await startMockServer();
    const limit = 2_000;
    const requests = (suffix = "") => fetch(`${server.baseUrl}/debug/requests${suffix}`);
    const cursor = async () =>
      readQaMockRequestCursor(await getJson(server, "/debug/request-cursor"));
    const send = (index: number) => respondOpenAi(server, `cursor request ${index}`);
    expect(await cursor()).toBe(0);
    await send(0);
    await send(1);
    for (let start = 2; start < limit; start += 32) {
      const batch = await Promise.allSettled(
        Array.from({ length: Math.min(32, limit - start) }, (_, offset) => send(start + offset)),
      );
      for (const result of batch) {
        if (result.status === "rejected") {
          throw result.reason;
        }
      }
    }
    expect(await cursor()).toBe(limit);
    await respondOpenAi(server, "cursor request overflow");
    const retained = requireArray(await (await requests()).json(), "retained requests");
    expect(retained).toHaveLength(limit);
    expect(retained[0]).toMatchObject({
      cursor: 2,
      allInputText: expect.stringContaining("cursor request 1"),
    });
    expect(retained.at(-1)).toMatchObject({
      cursor: limit + 1,
      allInputText: expect.stringContaining("cursor request overflow"),
    });
    expect(await (await requests(`?after=${limit}`)).json()).toMatchObject([
      { prompt: expect.stringContaining("overflow") },
    ]);
    for (const [after, code, error] of [
      [
        0,
        409,
        { error: "request cursor expired", after: 0, oldestCursor: 2, latestCursor: limit + 1 },
      ],
      [
        limit + 2,
        409,
        {
          error: "request cursor is ahead of the latest recorded request",
          after: limit + 2,
          latestCursor: limit + 1,
        },
      ],
      [1.5, 400, { error: "after must be a non-negative safe integer" }],
    ] as const) {
      const response = await requests(`?after=${after}`);
      expect(response.status).toBe(code);
      expect(await response.json()).toEqual(error);
    }
  });
  it("rejects an oversized upload without taking down the provider", async () => {
    const server = await startMockServer();
    const result = await postRawWebhook({
      url: `${server.baseUrl}/v1/responses`,
      body: "{}",
      contentLength: 16 * 1024 * 1024 + 1,
      headers: { "content-type": "application/json" },
    });
    expect(result.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
    expect(JSON.parse(result.body)).toEqual({ error: "Payload too large" });
    expect(result.closedByServer).toBe(true);
    expect(await getJson(server, "/healthz")).toEqual({ ok: true, status: "live" });
  });
  it("preserves memory retrieval line selection", async () => {
    const server = await startMockServer();
    for (const [range, from] of [
      [{ endLine: 7 }, 7],
      [{ endLine: 0 }, 1],
      [{ startLine: 0, endLine: 9 }, 1],
    ] as const) {
      const payload = await respondOpenAi(
        server,
        userInputs(
          "Memory tools check: read the hidden project codename.",
          makeToolOutputWithCallId(
            "call_memory_search",
            JSON.stringify({ results: [{ path: "MEMORY.md", ...range }] }),
          ),
        ),
        { tools: [{ type: "function", name: "memory_get", parameters: { type: "object" } }] },
      );
      expect(outputToolArgsFromItem(outputToolCall(payload, "memory_get"))).toEqual({
        path: "MEMORY.md",
        from,
        lines: 4,
      });
    }
  });
  it("fences completed tools with an empty user message after continuation", async () => {
    const laterInput = [
      { role: "user", content: "Continue." },
      { role: "user", content: [] },
    ];
    const requestKind = "agent-initial";

    const server = await startMockServer();
    await respondOpenAi(
      server,
      [
        makeUserInput("Tool progress QA check: read `QA.md` before answering."),
        {
          type: "function_call",
          id: "fc_fixture",
          call_id: "fixture_call",
          name: "read",
          arguments: '{"path":"QA.md"}',
        },
        { type: "function_call_output", call_id: "fixture_call", output: "fixture result" },
        ...laterInput,
      ],
      { model: "qa-model" },
    );
    const snapshot = await getJson(server, "/debug/last-request");
    expect(snapshot).toMatchObject({ requestKind });
    if (requestKind === "agent-initial") {
      expect(snapshot).not.toHaveProperty("plannedToolName");
    }
  });
  it("requires both WhatsApp batched markers in the current turn without leaking prior batches", async () => {
    const server = await startMockServer();
    const first =
      "First batched WhatsApp QA message WHATSAPP_QA_BATCHED_FIRST_TEST. " +
      "Wait for the next message before replying.";
    const second =
      "Second batched WhatsApp QA message. Reply with only this exact marker: " +
      "WHATSAPP_QA_BATCHED_FINAL_TEST only if the first and second messages appear " +
      "together in this single inbound message.";
    const combined = `${first}\n${second}`;
    for (const { input, expected } of [
      { input: [second], expected: "WHATSAPP_QA_BATCHED_MISSING_CONTEXT_TEST" },
      { input: [first, second], expected: "WHATSAPP_QA_BATCHED_MISSING_CONTEXT_TEST" },
      {
        input: [
          `<conversation_context>\n[user]\n${first}\n</conversation_context>\n\nCurrent user request:\n${second}`,
        ],
        expected: "WHATSAPP_QA_BATCHED_MISSING_CONTEXT_TEST",
      },
      { input: [combined], expected: "WHATSAPP_QA_BATCHED_FINAL_TEST" },
      {
        input: [combined, "Reply with only this exact marker: FRESH_TURN"],
        expected: "FRESH_TURN",
      },
      {
        input: [combined, second.replaceAll("_TEST", "_NEXT")],
        expected: "WHATSAPP_QA_BATCHED_MISSING_CONTEXT_NEXT",
      },
    ]) {
      expect(await reply(server, input.map(makeUserInput)), input.join(" | ")).toBe(expected);
    }
  });
});
