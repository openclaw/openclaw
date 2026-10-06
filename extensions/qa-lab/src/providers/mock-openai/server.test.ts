import { once } from "node:events";
import { postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { readQaMockRequestCursor } from "../shared/debug-request-cursor.js";
import { adaptAnthropicToolCallIds } from "./mock-anthropic-wire.js";
import type { StreamEvent } from "./mock-openai-contracts.js";
import { QA_TOOL_SEARCH_SECONDARY_TARGET, readTargetFromPrompt } from "./mock-openai-tooling.js";
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
  expectResponses,
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

const { startMockServer, cleanups } = createMockServerTestHarness();
const QA_FANOUT_PROMPT =
  "Subagent fanout synthesis check: delegate two bounded subagents sequentially, then report both results together.";

const QA_IMAGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3RQQkAMAzAwPg33Wnos+wgBo40dboAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANYADwAAAAAAAAAAAAAAAAAAAAAAAAAAAAC+Azy47PDiI4pA2wAAAABJRU5ErkJggg==";
const QA_IMAGE_INPUT = {
  type: "input_image",
  source: { type: "base64", mime_type: "image/png", data: QA_IMAGE_PNG_BASE64 },
} as const;
const QA_IMAGE_MEDIA_CONTEXT = {
  type: "input_text",
  text: "[media attached: media://inbound/red-top-blue-bottom.png (image/png)]",
} as const;
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
    diff: "+1 Replay safety: unsafe after write.",
    patch: [
      "--- compaction-retry-summary.txt",
      "+++ compaction-retry-summary.txt",
      "@@ -0,0 +1,1 @@",
      "+Replay safety: unsafe after write.",
      "",
    ].join("\n"),
    firstChangedLine: 1,
  },
  output: [],
  replaySafe: false,
  telemetry: {
    catalogSize: 32,
    sources: { openclaw: 32, mcp: 0, client: 0 },
    counterScope: "qaFixtureScope01",
    searchCount: 0,
    describeCount: 0,
    callCount: 1,
  },
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

function expectPostJson(server: MockServer, path: string, body: unknown) {
  return expectOk(postJson(server, path, body));
}

async function expectPostJsonJson<T>(server: MockServer, path: string, body: unknown) {
  return (await expectPostJson(server, path, body)).json() as Promise<T>;
}

function postNonStreamingResponses(server: MockServer, body: Record<string, unknown>) {
  return postResponses(server, { stream: false, ...body });
}

function expectNonStreamingResponses(server: MockServer, body: Record<string, unknown>) {
  return expectResponses(server, { stream: false, ...body });
}

function expectOpenAiNonStreamingResponses(server: MockServer, body: Record<string, unknown>) {
  return expectNonStreamingResponses(server, { model: "gpt-5.6-luna", ...body });
}

function postStreamingResponses(server: MockServer, body: Record<string, unknown>) {
  return postResponses(server, { stream: true, ...body });
}

function expectStreamingResponses(server: MockServer, body: Record<string, unknown>) {
  return expectResponses(server, { stream: true, ...body });
}

function expectOpenAiStreamingResponses(server: MockServer, body: Record<string, unknown>) {
  return expectStreamingResponses(server, { model: "gpt-5.6-luna", ...body });
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

async function expectResponsesText(server: MockServer, body: unknown) {
  return (await expectResponses(server, body)).text();
}

function expectStreamingResponsesText(server: MockServer, body: Record<string, unknown>) {
  return expectResponsesText(server, { stream: true, ...body });
}

function expectOpenAiStreamingResponsesText(server: MockServer, body: Record<string, unknown>) {
  return expectStreamingResponsesText(server, { model: "gpt-5.6-luna", ...body });
}

function makeImageUserInput(...content: unknown[]) {
  return { role: "user" as const, content };
}

function readMockImageResponse(server: MockServer, input: unknown[]) {
  return expectNonStreamingResponsesJson(server, { model: "mock-openai/gpt-5.6-luna", input });
}

async function readMockImageResponseText(server: MockServer, input: unknown[]) {
  return outputText(await readMockImageResponse(server, input));
}

function readMockResponse(server: MockServer, input: unknown[]) {
  return expectNonStreamingResponses(server, { input });
}

function readOpenAiPromptResponseText(server: MockServer, prompt: string, ...input: unknown[]) {
  return expectOpenAiStreamingResponsesText(server, { input: [makeUserInput(prompt), ...input] });
}

function makeToolOutput(output: unknown) {
  return { type: "function_call_output" as const, output };
}

async function completeSideEffectScenario(server: MockServer, kind: "recovery" | "exhaustion") {
  const kickoff = makeUserInput(
    kind === "recovery"
      ? QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT
      : QA_EMPTY_RESPONSE_SIDE_EFFECT_EXHAUSTION_PROMPT,
  );
  const plan = await expectOpenAiNonStreamingResponsesJson(server, { input: [kickoff] });
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
  const settled = await expectOpenAiNonStreamingResponsesJson(server, { input });
  expect(outputText(settled)).toBe(kind === "recovery" ? "TELEGRAM-EMPTY-WRITE-RECOVERED-OK" : "");
  return [...input, ...outputItems(settled)];
}

async function startFanout(server: MockServer, tools: readonly unknown[], alphaResult: string) {
  const first = await expectNonStreamingResponsesJson(server, {
    tools,
    input: [makeUserInput(QA_FANOUT_PROMPT)],
  });
  expect(outputToolArgsFromItem(outputToolCall(first, "sessions_spawn"))).toMatchObject({
    label: "qa-fanout-alpha",
  });
  const second = await expectNonStreamingResponsesJson(server, {
    tools,
    input: [makeUserInput(QA_FANOUT_PROMPT), makeToolOutput(alphaResult)],
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
  const input = [makeUserInput(text)];
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
  return {
    role: "developer" as const,
    content: [{ type: "input_text" as const, text }],
  };
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
const CODEX_CUSTOM_PATCH_TOOL = {
  type: "custom",
  name: "apply_patch",
  format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
} as const;
const CODEX_CUSTOM_PATCH_NAMESPACE = {
  type: "namespace",
  name: "openclaw_direct",
  tools: [CODEX_CUSTOM_PATCH_TOOL],
} as const;

const CODE_MODE_TOOLS = [
  {
    type: "function",
    name: "exec",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string" },
      },
      required: ["code"],
    },
  },
  {
    type: "function",
    name: "wait",
    parameters: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
    },
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
const WHATSAPP_AGENT_UPLOAD_TOKEN = "WHATSAPP_QA_AGENT_UPLOAD_TEST";
const WHATSAPP_GROUP_AGENT_UPLOAD_TOKEN = "WHATSAPP_QA_GROUP_AGENT_UPLOAD_TEST";
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

    const toolPlan = await expectOpenAiNonStreamingResponses(server, {
      tools: [READ_TOOL],
      input: [makeUserInput(prompt)],
    });
    expect(outputItem(await toolPlan.json()).name).toBe("read");

    const failure = await postNonStreamingResponses(server, {
      model: "gpt-5.6-luna",
      tools: [READ_TOOL],
      input: [
        makeUserInput(prompt),
        makeToolOutputWithCallId("call_mock_provider_503", "QA mission loaded"),
      ],
    });

    expect(failure.status).toBe(503);
    expect(failure.headers.get("retry-after")).toBe("120");
    expect(await failure.json()).toEqual({
      error: {
        type: "server_error",
        message: "Service Unavailable",
      },
    });
  });

  it("serves health and streamed responses", async () => {
    const server = await startMockServer();

    expect(await getJson(server, "/healthz")).toEqual({ ok: true, status: "live" });

    const response = await expectStreamingResponses(server, {
      input: [makeUserInput("Inspect the repo docs and kickoff task.")],
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain('"type":"response.output_item.added"');
    expect(body).toContain('"name":"read"');
  });

  it("recovers the stranded-final fixture by calling the message tool on the retry prompt", async () => {
    const server = await startMockServer();

    const initialBody = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      input: [
        makeUserInput(
          "qa stranded final recovery check. Include `QA-STRANDED-85714` in a thorough multi-sentence answer, but do not call any tool yet.",
        ),
      ],
    });

    const initialText = outputText(initialBody);
    expect(initialText).toContain("QA-STRANDED-85714");
    expect(initialText).toContain("近 7 日營收較前期增加");
    expect(initialText).toHaveLength(167);
    expect(initialText.match(/[.!?]+(?:\s|$)/g) ?? []).toHaveLength(0);
    expect(outputItems(initialBody).some((item) => item.type === "function_call")).toBe(false);

    const retryBody = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      input: [
        makeUserInput(
          [
            "qa stranded final recovery check.",
            "Your previous reply was not delivered to the conversation because you did not call message(action=send).",
            initialText,
          ].join(" "),
        ),
      ],
    });

    const toolCall = outputToolCall(retryBody, "message");
    expect(outputToolArgsFromItem(toolCall)).toEqual({
      action: "send",
      message: initialText,
    });
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
    const body = await expectOpenAiNonStreamingResponsesJson(await startMockServer(), {
      ...(tools ? { tools } : {}),
      input: [makeUserInput(prompt)],
    });
    const text = outputText(body);
    expect(text).toContain(marker);
    expect(text.length).toBeGreaterThanOrEqual(120);
    if (tools) {
      expect(outputItems(body).some((item) => item.type === "function_call")).toBe(false);
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
      continuation: [makeUserInput("Continue from the tool result.")],
    },
  ])(
    "completes the message-tool reply with $name",
    async ({ prompt, args, final, continuation }) => {
      const server = await startMockServer();
      const request = {
        stream: false,
        model: "gpt-5.6-luna",
        tools: [MESSAGE_TOOL],
        input: [makeUserInput(prompt)],
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
      expect(outputItems(completed).some((item) => item.type === "function_call")).toBe(false);
      expect(completed).not.toMatchObject({ output: [{ type: "function_call" }] });
    },
  );

  it("emits deterministic text deltas for generic streaming QA prompts", async () => {
    const server = await startMockServer();

    for (const { input, marker, phase, minimum, absent } of [
      {
        input: [makeUserInput("Quiet streaming QA check: reply exactly `QA_STREAMING_OK`.")],
        marker: "QA_STREAMING_OK",
        phase: true,
      },
      {
        input: [makeUserInput("Partial streaming QA check: reply exactly `QA_PARTIAL_OK`.")],
        marker: "QA_PARTIAL_OK",
      },
      {
        input: [
          makeUserInput(
            "Telegram reply-chain marker QA. Reply exactly: QA-TELEGRAM-REPLY-CHAIN-OK",
          ),
          makeUserInput("Quiet streaming QA check. Reply exactly: QA-TELEGRAM-STREAM-SINGLE-OK"),
        ],
        marker: "QA-TELEGRAM-STREAM-SINGLE-OK",
        absent: "QA-TELEGRAM-REPLY-CHAIN-OK",
      },
      {
        input: [
          makeUserInput("Telegram long final QA check. Use the scripted long final response."),
        ],
        marker: "TELEGRAM-LONG-FINAL",
        phase: true,
        minimum: 4_500,
      },
      {
        input: [
          makeUserInput("WhatsApp long final QA check. Use the scripted long final response."),
        ],
        marker: "WHATSAPP-LONG-FINAL",
        phase: true,
        minimum: 6_000,
      },
      {
        input: [
          makeUserInput(
            "Telegram long final three chunk QA check. Use the scripted three chunk final response.",
          ),
        ],
        marker: "TELEGRAM-LONG-FINAL-3CHUNK",
        phase: true,
        minimum: 8_000,
      },
    ]) {
      const body = await expectStreamingResponsesText(server, { input });
      expect(body).toContain('"type":"response.output_text.delta"');
      if (phase) {
        expect(body).toContain('"phase":"final_answer"');
      }
      if (minimum) {
        expect(body).toContain(`${marker}-BEGIN`);
        expect(body).toContain(`${marker}-END`);
        expect(body.length).toBeGreaterThan(minimum);
      } else {
        expect(body).toContain(marker);
      }
      if (absent) {
        expect(body).not.toContain(absent);
      }
    }

    const blockPrompt = [
      "Block streaming QA check: complete this whole sequence in one turn.",
      "Step 1: send an assistant text block containing only this exact marker: `BLOCK_ONE_OK`.",
      "That first marker block must be emitted before any tool call.",
      "Step 2: after the first marker block, use the read tool exactly once on `QA_KICKOFF_TASK.md`.",
      "Step 3: after that read completes, send a final assistant text block containing only this exact marker: `BLOCK_TWO_OK`.",
      "Never put both markers in the same assistant text block.",
    ].join("\n");
    const blockBody = await expectStreamingResponsesText(server, {
      input: [makeUserInput(blockPrompt)],
    });
    expect(blockBody).toContain('"item_id":"msg_mock_block_1"');
    expect(blockBody).toContain('"name":"read"');
    expect(blockBody).toContain("QA_KICKOFF_TASK.md");
    expect(blockBody).toContain("BLOCK_ONE_OK");
    expect(blockBody).not.toContain('"item_id":"msg_mock_block_2"');

    const blockContinuationBody = await expectStreamingResponsesText(server, {
      input: [
        makeUserInput(blockPrompt),
        makeToolOutputWithCallId("call_mock_read_fixture", "QA kickoff task read"),
      ],
    });
    expect(blockContinuationBody).toContain('"item_id":"msg_mock_block_2"');
    expect(blockContinuationBody).toContain("BLOCK_TWO_OK");
    expect(blockContinuationBody).not.toContain('"item_id":"msg_mock_block_1"');
  });

  it("dispatches structured Slack commentary, exec, and final phases", async () => {
    const server = await startMockServer();
    const suffix = "A1B2C3D4";
    const commentaryMarker = `SLACK-QA-COMMENTARY-${suffix}`;
    const toolMarker = `SLACK-QA-TOOL-${suffix}`;
    const finalMarker = `SLACK-QA-COMMENTARY-DONE-${suffix}`;
    const command = `grep '${toolMarker}' /dev/null || sleep 5`;
    const prompt = `${commentaryMarker} ${command} ${finalMarker}`;
    const stalePrompt =
      "SLACK-QA-COMMENTARY-11112222 grep 'SLACK-QA-TOOL-11112222' /dev/null || sleep 5 SLACK-QA-COMMENTARY-DONE-11112222";
    const currentEnvelope = `${stalePrompt}\n${prompt}`;

    const planResponse = await expectStreamingResponses(server, {
      tools: [{ type: "function", name: "exec" }],
      input: [
        makeUserInput(stalePrompt),
        makeToolOutputWithCallId("call_stale_slack_progress", ""),
        makeUserInput(currentEnvelope),
      ],
    });
    const events = (await planResponse.text())
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => requireRecord(JSON.parse(line.slice("data: ".length)), "Slack SSE event"));
    const completedItems = events
      .filter((event) => event.type === "response.output_item.done")
      .map((event) => requireRecord(event.item, "Slack completed item"));
    expect(completedItems).toHaveLength(2);
    expect(completedItems[0]).toMatchObject({
      type: "message",
      phase: "commentary",
      content: [{ type: "output_text", text: commentaryMarker }],
    });
    const exec = completedItems[1];
    if (!exec) {
      throw new Error("expected Slack progress exec output item");
    }
    expect(exec).toMatchObject({ type: "function_call", name: "exec" });
    expect(outputToolArgsFromItem(exec)).toEqual({ command });
    expect(JSON.stringify(events)).not.toContain(finalMarker);

    const final = await expectNonStreamingResponsesJson(server, {
      tools: [{ type: "function", name: "exec" }],
      input: [
        makeUserInput(stalePrompt),
        makeToolOutputWithCallId("call_stale_slack_progress", ""),
        makeUserInput(currentEnvelope),
        exec,
        makeToolOutputWithCallId(outputToolCallId(exec, "call_slack_progress"), ""),
      ],
    });
    expect(outputItem(final)).toMatchObject({ type: "message", phase: "final_answer" });
    expect(outputText(final)).toBe(finalMarker);
    expect(outputItems(final)).toHaveLength(1);
    expect(JSON.stringify(final)).not.toContain(commentaryMarker);
  });

  it("does not dispatch Slack progress when structured marker suffixes disagree", async () => {
    const server = await startMockServer();
    const payload = await expectNonStreamingResponsesJson(server, {
      tools: [{ type: "function", name: "exec" }],
      input: [
        makeUserInput(
          "SLACK-QA-COMMENTARY-A1B2C3D4 grep 'SLACK-QA-TOOL-11112222' /dev/null || sleep 5 SLACK-QA-COMMENTARY-DONE-A1B2C3D4",
        ),
      ],
    });

    expect(outputItems(payload)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "exec" })]),
    );
  });

  it("does not use stale exact replies from instructions after QA reads", async () => {
    const server = await startMockServer();

    const final = await expectNonStreamingResponsesJson(server, {
      instructions: "If this is a heartbeat check, reply exactly: HEARTBEAT_OK",
      input: [
        makeUserInput("Read QA_KICKOFF_TASK.md, then summarize what you found."),
        makeToolOutputWithCallId(
          "call_mock_read_1",
          JSON.stringify({ text: "QA mission: understand this OpenClaw repo." }),
        ),
      ],
    });

    const text = outputText(final);
    expect(text).toContain("Protocol note: I reviewed the requested material.");
    expect(text).not.toContain("HEARTBEAT_OK");
  });

  const evidencePrefix = "x".repeat(219);
  it.each([
    [
      "preserves surrogate pairs in HTTP tool-output evidence snippets",
      [
        makeUserInput("Summarize the tool result."),
        makeToolOutputWithCallId("call_mock_read_1", `${evidencePrefix}😀tail`),
      ],
      `Protocol note: I reviewed the requested material. Evidence snippet: ${evidencePrefix}`,
    ],
    [
      "classifies a completion event before the child task text it quotes",
      [
        makeUserInput("Subagent terminal reply QA check: empty."),
        makeUserInput(
          "[Internal task completion event]\nTask: qa-terminal-empty\nChild task: Subagent terminal reply QA worker: empty.\nResult: (no output)",
        ),
      ],
      "QA-SUBAGENT-TERMINAL-EMPTY-REPRESENTED",
    ],
    [
      "lets child subagent prompts finish with an exact token",
      [makeUserInput(threadSubagentTask("QA_SUBAGENT_CHILD_DIRECT"))],
      "QA_SUBAGENT_CHILD_DIRECT",
    ],
    [
      "keeps QA tool-search result summaries ahead of generic worked/failed/blocked summaries",
      [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "Answer in worked/failed/blocked format with source and docs notes.",
            },
          ],
        },
        makeUserInput(
          "tool search qa check target=fake_plugin_tool_17. Call exactly that tool once and then summarize.",
        ),
        makeToolOutputWithCallId(
          "call_tool_call_1",
          JSON.stringify({
            tool: { name: "fake_plugin_tool_17" },
            result: { content: [{ type: "text", text: "FAKE_PLUGIN_OK fake_plugin_tool_17" }] },
          }),
        ),
      ],
      "FAKE_PLUGIN_OK fake_plugin_tool_17",
    ],
    [
      "derives ask_user QA summaries from the returned answers",
      [
        {
          role: "system",
          content: [{ type: "input_text", text: "Nothing to say: entire reply exactly NO_REPLY" }],
        },
        makeUserInput(
          "QA routing marker: tool search qa check target=ask_user. Ask structured questions, then summarize their actual answers.",
        ),
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
      ],
      "ASK-USER-ROUNDTRIP-OK | deploy=Canary | checks=Lint,Unit | note=weekend-only",
    ],
    [
      "returns NO_REPLY for unmentioned group chatter",
      [
        makeUserInput(
          'Conversation info: ⟦openclaw:ctx⟧\n{"is_group_chat": true}\n\nhello team, no bot ping here',
        ),
      ],
      "NO_REPLY",
    ],
  ] as const)("%s", async (_name, input, expected) => {
    const payload = await expectNonStreamingResponsesJson(await startMockServer(), { input });
    expect(outputText(payload)).toBe(expected);
  });

  it("selects the latest block-streaming markers and target in one user envelope", async () => {
    const server = await startMockServer();
    const envelope = [
      "Block streaming QA check: first exact marker: `STALE_ONE`; read `stale-block.txt`; second exact marker: `STALE_TWO`.",
      "Block streaming QA check: first exact marker: `CURRENT_ONE`; read `current-block.txt`; second exact marker: `CURRENT_TWO`.",
    ].join("\n");
    const payload = await expectNonStreamingResponsesJson(server, {
      input: [makeUserInput(envelope)],
    });

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
    expect(lobsterBody).toContain('"name":"write"');
    expect(lobsterBody).toContain("lobster-invaders.html");

    const payload = await expectNonStreamingResponsesJson(server, {
      model: "gpt-5.6-luna-alt",
      input: [
        makeUserInput("Please remember this fact for later: the QA canary code is ALPHA-7."),
        makeUserInput("What was the QA canary code I asked you to remember earlier?"),
      ],
    });
    expect(outputText(payload)).toContain("ALPHA-7");

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
    const seedResponse = await expectOpenAiNonStreamingResponsesJson<unknown>(server, {
      input: [makeUserInput(seedPrompt)],
    });
    const botReplyMarker = outputText(seedResponse);
    expect(botReplyMarker).toMatch(new RegExp(`^${seedMarker}_BOT_[A-Z0-9]+$`, "u"));
    const botNonce = botReplyMarker.slice(`${seedMarker}_BOT_`.length);
    const expectedRecallMarker = `${recallMarker}_${botNonce}`;
    const recallPrompt = [
      "Slack MPIM assistant-history recall check.",
      `Recall the nonce from your immediately previous reply beginning with ${seedMarker}_BOT_.`,
      `Reply with only this exact format: ${recallMarker}_<NONCE>, using that same nonce.`,
      `Otherwise reply with only: ${missingMarker}`,
    ].join(" ");
    expect(recallPrompt).not.toContain(botReplyMarker);
    expect(recallPrompt).not.toContain(botNonce);

    const withRetainedBotHistory = await expectOpenAiNonStreamingResponsesJson<unknown>(server, {
      input: [
        makeUserInput(
          [
            "[Thread history - for context]",
            `[Slack Driver (user) Fri 2026-07-31 10:00 UTC] ${seedPrompt}`,
            "[slack message id: 1.000000 channel: C123]",
            "",
            `[Slack OpenClaw (this assistant) (assistant) Fri 2026-07-31 10:01 UTC] ${botReplyMarker}`,
            "[slack message id: 1.500000 channel: C123]",
            "",
            `[Slack Driver (user) Fri 2026-07-31 10:02 UTC] ${recallPrompt}`,
          ].join("\n"),
        ),
      ],
    });
    expect(outputText(withRetainedBotHistory)).toBe(expectedRecallMarker);

    const withStructuredAssistantHistoryOnly = await expectOpenAiNonStreamingResponsesJson<unknown>(
      server,
      {
        input: [
          makeUserInput(seedPrompt),
          {
            role: "assistant",
            content: [{ type: "output_text", text: botReplyMarker }],
          },
          makeUserInput(recallPrompt),
        ],
      },
    );
    expect(outputText(withStructuredAssistantHistoryOnly)).toBe(missingMarker);

    const withHumanAttributedSeed = await expectOpenAiNonStreamingResponsesJson<unknown>(server, {
      input: [
        makeUserInput(
          [
            "[Thread history - for context]",
            `[Slack Alice (user) Fri 2026-07-31 10:00 UTC] ${botReplyMarker}`,
            "[slack message id: 1.000000 channel: C123]",
            "",
            `[Slack Driver (user) Fri 2026-07-31 10:02 UTC] ${recallPrompt}`,
          ].join("\n"),
        ),
      ],
    });
    expect(outputText(withHumanAttributedSeed)).toBe(missingMarker);

    for (const prefix of [
      "Please remember this fact for later: ORBIT-22. ",
      "Reply exactly `SHADOWED-EXACT-REPLY`. ",
    ]) {
      const overlappingSeed = await expectOpenAiNonStreamingResponsesJson<unknown>(server, {
        input: [makeUserInput(prefix + seedPrompt)],
      });
      expect(outputText(overlappingSeed)).toMatch(new RegExp(`^${seedMarker}_BOT_[A-Z0-9]+$`, "u"));
      const overlappingRecall = await expectOpenAiNonStreamingResponsesJson<unknown>(server, {
        input: [makeUserInput(prefix + recallPrompt)],
      });
      expect(outputText(overlappingRecall)).toBe(missingMarker);
    }
  });

  it("emits the Slack native chart presentation through the declared message tool", async () => {
    const server = await startMockServer();

    const undeclaredPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [makeUserInput(SLACK_CHART_PROMPT)],
    });
    expect(
      outputItems(undeclaredPayload).some(
        (item) => item.type === "function_call" && item.name === "message",
      ),
    ).toBe(false);

    const declaredPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      input: [makeUserInput(SLACK_CHART_PROMPT)],
    });
    const toolCall = outputToolCall(declaredPayload, "message");
    expect(outputToolArgsFromItem(toolCall)).toEqual(SLACK_CHART_MESSAGE_TOOL_ARGS);

    const afterToolPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      input: [
        makeUserInput(SLACK_CHART_PROMPT),
        makeToolOutputWithCallId(
          outputToolCallId(toolCall, "call_mock_message_chart"),
          "message sent",
        ),
      ],
    });
    expect(
      outputItems(afterToolPayload).some(
        (item) => item.type === "function_call" && item.name === "message",
      ),
    ).toBe(false);
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
    const request = { tools: [MESSAGE_TOOL], input: [makeUserInput(prompt)] };
    const initial = await expectOpenAiNonStreamingResponsesJson(server, request);
    const call = outputToolCall(initial, "message");
    expect(outputToolArgsFromItem(call)).toEqual(args);
    if (result) {
      const completed = await expectOpenAiNonStreamingResponsesJson(server, {
        ...request,
        input: [
          ...request.input,
          makeToolOutputWithCallId(outputToolCallId(call, "message"), result),
        ],
      });
      expect(outputText(completed)).toBe("NO_REPLY");
    }
  });

  it.each([
    {
      action: "react",
      prompt: WHATSAPP_AGENT_REACT_PROMPT,
      groupPrompt: WHATSAPP_GROUP_AGENT_REACT_PROMPT,
    },
  ])(
    "emits WhatsApp $action only when the message tool is declared",
    async ({ action, prompt, groupPrompt }) => {
      const server = await startMockServer();
      for (const tools of action === "react" ? [undefined, [READ_TOOL]] : [undefined]) {
        const undeclared = await expectOpenAiNonStreamingResponsesJson(server, {
          ...(tools ? { tools } : {}),
          input: [makeUserInput(prompt)],
        });
        expect(
          outputItems(undeclared).some(
            (item) => item.type === "function_call" && item.name === "message",
          ),
        ).toBe(false);
      }
      for (const [input, caption] of [
        [prompt, WHATSAPP_AGENT_UPLOAD_TOKEN],
        [groupPrompt, WHATSAPP_GROUP_AGENT_UPLOAD_TOKEN],
      ] as const) {
        const declared = await expectOpenAiNonStreamingResponsesJson(server, {
          tools: [MESSAGE_TOOL],
          input: [makeUserInput(input)],
        });
        const call = outputToolCall(declared, "message");
        expect(call).toMatchObject({ type: "function_call", name: "message" });
        const args = outputToolArgsFromItem(call);
        if (action === "react") {
          expect(args).toEqual({ action: "react", emoji: "👍", final: true });
        } else {
          expect(args).toMatchObject({
            action: "upload-file",
            caption,
            contentType: "image/png",
            filename: "whatsapp-qa-agent-upload.png",
          });
          expect(args.buffer).toEqual(expect.any(String));
        }
      }
    },
  );

  it("answers WhatsApp pending-history prompts only with injected prior group context", async () => {
    const server = await startMockServer();
    const currentTriggerPrompt = [
      "openclawqa pending history context check",
      WHATSAPP_PENDING_HISTORY_TRIGGER_MARKER,
      `Return ${WHATSAPP_PENDING_HISTORY_OK_MARKER} only if prior group context contains the context-only sentinel.`,
    ].join(" ");

    const historyContext = buildWhatsAppPendingHistoryContextFixture([
      {
        sender: "Alice",
        timestamp: 1_786_000_000_000,
        body: `quiet context ${WHATSAPP_PENDING_HISTORY_QUIET_MARKER} ${WHATSAPP_PENDING_HISTORY_CONTEXT_SENTINEL}`,
      },
    ]);
    const withStructuredHistory = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [
        makeUserInput(currentTriggerPrompt),
        makeUserInput(TEST_RUNTIME_CONTEXT_CARRIER.replace("runtime metadata", historyContext)),
      ],
    });

    expect(outputText(withStructuredHistory)).toBe(WHATSAPP_PENDING_HISTORY_OK_MARKER);

    const withoutHistory = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [makeUserInput(currentTriggerPrompt)],
    });

    expect(outputText(withoutHistory)).not.toBe(WHATSAPP_PENDING_HISTORY_OK_MARKER);

    const currentMessageOnlyMarkers = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [
        makeDeveloperInput(
          buildWhatsAppPendingHistoryContextFixture([
            {
              sender: "Alice",
              timestamp: 1_786_000_000_000,
              body: "unrelated prior context",
            },
          ]),
        ),
        makeUserInput(
          [
            WHATSAPP_PENDING_HISTORY_TRIGGER_PROMPT,
            `Current request: ${WHATSAPP_PENDING_HISTORY_QUIET_MARKER}`,
          ].join("\n"),
        ),
      ],
    });

    expect(outputText(currentMessageOnlyMarkers)).not.toBe(WHATSAPP_PENDING_HISTORY_OK_MARKER);

    const ordinaryEarlierUserMarkers = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [
        makeUserInput(
          `${WHATSAPP_PENDING_HISTORY_QUIET_MARKER} ${WHATSAPP_PENDING_HISTORY_CONTEXT_SENTINEL}`,
        ),
        makeUserInput(currentTriggerPrompt),
      ],
    });

    expect(outputText(ordinaryEarlierUserMarkers)).not.toBe(WHATSAPP_PENDING_HISTORY_OK_MARKER);

    const contextWithoutCurrentTrigger = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [
        makeUserInput(
          [historyContext, "openclawqa pending history context check without current trigger"].join(
            "\n",
          ),
        ),
      ],
    });

    expect(outputText(contextWithoutCurrentTrigger)).not.toBe(WHATSAPP_PENDING_HISTORY_OK_MARKER);
  });

  it("uses the WhatsApp broadcast runtime agent id context for distinct markers", async () => {
    const server = await startMockServer();

    const mainPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [
        makeDeveloperInput("Runtime: agent=main | channel=whatsapp | capabilities=messageactions"),
        makeUserInput(WHATSAPP_BROADCAST_PROMPT),
      ],
    });
    const secondPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [
        makeDeveloperInput(
          "Runtime: agent=qa-second | channel=whatsapp | capabilities=messageactions",
        ),
        makeUserInput(WHATSAPP_BROADCAST_PROMPT),
      ],
    });
    const noIdentityPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [
        makeDeveloperInput("Runtime: channel=whatsapp | capabilities=messageactions"),
        makeUserInput(WHATSAPP_BROADCAST_PROMPT),
      ],
    });

    expect(outputText(mainPayload)).toBe(`${WHATSAPP_BROADCAST_TOKEN}_MAIN`);
    expect(outputText(secondPayload)).toBe(`${WHATSAPP_BROADCAST_TOKEN}_SECOND`);
    expect(outputText(noIdentityPayload)).not.toMatch(
      new RegExp(`${WHATSAPP_BROADCAST_TOKEN}_(?:MAIN|SECOND)`, "u"),
    );
  });

  it("matches WhatsApp group dispatch markers without answering unrelated prompts", async () => {
    const server = await startMockServer();
    expect(WHATSAPP_REPLY_TO_BOT_TRIGGER_PROMPT).not.toMatch(/\bopenclawqa\b/iu);
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
      const payload = await expectOpenAiNonStreamingResponsesJson(server, {
        input: [makeUserInput(prompt)],
      });
      expect(outputText(payload)).toBe(marker);
      if (unrelated) {
        const other = await expectOpenAiNonStreamingResponsesJson(server, {
          input: [makeUserInput(unrelated)],
        });
        expect(outputText(other)).not.toBe(marker);
      }
    }
  });

  it("advances repo-contract followthrough when transcript text is newer than extracted tool output", async () => {
    const server = await startMockServer();

    const prompt =
      "Repo contract followthrough check. Read AGENT.md, SOUL.md, and FOLLOWTHROUGH_INPUT.md first. Then follow the repo contract exactly, write ./repo-contract-summary.txt, and reply with three labeled lines: Read, Wrote, Status.";

    const response = await expectOpenAiStreamingResponses(server, {
      input: [
        makeUserInput(prompt),
        makeToolOutput(
          "# Repo contract\n\nStep order:\n1. Read AGENT.md.\n2. Read SOUL.md.\n3. Read FOLLOWTHROUGH_INPUT.md.\n4. Write ./repo-contract-summary.txt.\n",
        ),
        makeUserInput("# Execution style\n\nStay brief, honest, and action-first.\n"),
      ],
    });

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

    const response = await expectOpenAiStreamingResponses(server, {
      input: [
        makeUserInput(prompt),
        makeToolOutput(
          "# Personal task ledger\n\nRequired status contract:\n1. Read PERSONAL_TASK_LEDGER.md.\n2. Read FOLLOWTHROUGH_NOTE.md.\n3. Write ./personal-task-status.txt.\n",
        ),
        makeUserInput(
          "Task: prepare a local OpenClaw PR readiness note.\nPending: wait for maintainer feedback before publishing.\nBlocked: publishing needs explicit user approval.\nDone: local evidence captured in personal-task-status.txt.\n",
        ),
      ],
    });

    const body = await response.text();
    expect(body).toContain('"name":"write"');
    expect(body).toContain("personal-task-status.txt");
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
    expect(writeBody).toContain('"name":"write"');
    expect(writeBody).toContain("personal-failure-recovery.txt");
    expect(writeBody).toContain("Retry boundary: do not retry");
    expect(writeBody).not.toContain("retry succeeded");

    const finalBody = await readOpenAiPromptResponseText(
      server,
      prompt,
      makeToolOutput(
        "Successfully wrote personal-failure-recovery.txt with the failed step and retry boundary.",
      ),
    );
    expect(finalBody).toContain("PERSONAL-FAILURE-RECOVERY-OK");
    expect(finalBody).toContain("Retry boundary: do not retry");
    expect(finalBody).not.toContain("fully complete");
  });

  it("injects one Anthropic overflow per session before planning the logical write", async () => {
    const server = await startMockServer();
    const body = {
      tools: [
        {
          name: "exec",
          input_schema: {
            type: "object",
            properties: {
              code: { type: "string" },
            },
            required: ["code"],
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
      ],
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
    const initial = await postNonStreamingResponses(server, {
      model: "gpt-5.6-luna",
      client_metadata: { session_id: "compaction-summary" },
      input: [
        makeUserInput(`${QA_COMPACTION_RETRY_PROMPT}\n${QA_COMPACTION_RETRY_OVERFLOW_PADDING}`),
      ],
    });
    expect(initial.status).toBe(400);

    const response = await postNonStreamingResponses(server, {
      model: "gpt-5.6-luna",
      instructions: QA_COMPACTION_SUMMARY_INSTRUCTIONS,
      input: `<conversation>\n[Chunk 1 - oldest messages]\nQA-COMPACTION-BULKY-HISTORICAL-MARKER\n${QA_COMPACTION_RETRY_OVERFLOW_PADDING}\n</conversation>\n\nAdditional focus: preserve exact identifiers and current work.`,
    });

    expect(response.status).toBe(200);
    const summary = outputText(await response.json());
    expectCurrentCompactionSummaryHeadings(summary);
    expect(summary).not.toContain("QA-COMPACTION-DURABLE-MARKER");
    expect(summary).not.toContain("QA-COMPACTION-BULKY-HISTORICAL-MARKER");
    const requests = requireArray(
      await getJson(server, "/debug/requests"),
      "compaction requests",
    ).map((request) => requireRecord(request, "compaction request"));
    expect(requests).toHaveLength(2);
    const summaryRequest = requireRecord(requests[1], "compaction request 1");
    expect(summaryRequest).toMatchObject({
      requestKind: "compaction-summary",
      outcome: "success",
    });
    expect(Number(summaryRequest.rawByteLength)).toBeGreaterThan(256 * 1024);
    expect(summaryRequest.errorCode).toBeUndefined();
    expect(summaryRequest.allInputText).toContain("[Chunk 1 - oldest messages]");
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
      expect(recoveredText).toContain(recoveredMarker);
      expect(recoveredText).toContain(`${markerPrefix}-session-a`);
      expect(recoveredText).toContain("## Decisions");
      expect(recoveredText).toContain("## Open TODOs");
      expect(recoveredText).toContain("## Constraints/Rules");
      expect(recoveredText).toContain("## Pending user asks");
      expect(recoveredText).toContain("## Exact identifiers");
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
    const requests = requireArray(await getJson(server, "/debug/requests"), "summary requests");
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request).toMatchObject({ requestKind: "compaction-summary", outcome: "success" });
      expect(request).not.toHaveProperty("plannedToolName");
    }
  });

  it.each([
    {
      label: "content added under another target",
      result: {
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
      },
    },
  ])("rejects Anthropic Code Mode compaction retry result with $label", async ({ result }) => {
    const server = await startMockServer();
    const callId = "toolu_compaction_retry_invalid";
    const body = requireRecord(
      await expectAnthropicMessagesJson(server, {
        messages: [
          makeAnthropicUserText(
            "Compaction retry mutating tool check: read COMPACTION_RETRY_CONTEXT.md, then create compaction-retry-summary.txt and keep replay safety explicit.",
          ),
          {
            role: "assistant",
            content: [{ type: "tool_use", id: callId, name: "exec", input: {} }],
          },
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

    const writePlan = await expectOpenAiStreamingResponses(server, {
      input: [
        makeUserInput(QA_COMPACTION_RETRY_PROMPT),
        makeUserInput("Continue after compaction."),
      ],
    });
    expect(await writePlan.text()).toContain('"name":"write"');

    const finalReply = await expectOpenAiNonStreamingResponses(server, {
      input: [
        makeUserInput(QA_COMPACTION_RETRY_PROMPT),
        makeToolOutput("Successfully wrote 41 bytes to compaction-retry-summary.txt"),
        makeUserInput("Continue after compaction."),
      ],
    });
    expect(outputText(await finalReply.json())).toContain("replay unsafe after write");
  });

  it("supports exact reply memory prompts and embeddings requests", async () => {
    const server = await startMockServer();

    const rememberPayload = await expectNonStreamingResponsesJson(server, {
      input: [
        makeUserInput(
          "Please remember this fact for later: the QA canary code is ALPHA-7. Reply exactly `Remembered ALPHA-7.` once stored.",
        ),
      ],
    });
    expect(outputText(rememberPayload)).toBe("Remembered ALPHA-7.");

    const embeddingPayload = (await fetchOkJson(`${server.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
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

    await expectResponsesText(server, {
      stream: true,
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(
          'Forked subagent context QA check. Use sessions_spawn task="Report the visible code" label=qa-fork-context context=fork mode=run.',
        ),
      ],
    });

    const debugPayload = await readDebugRequest(server);
    expect(debugPayload.plannedToolName).toBe("sessions_spawn");
    const plannedToolArgs = requireRecord(debugPayload.plannedToolArgs, "planned tool args");
    expect(plannedToolArgs.task).toBe("Report the visible code");
    expect(plannedToolArgs.label).toBe("qa-fork-context");
    expect(plannedToolArgs.context).toBe("fork");
    expect(plannedToolArgs.mode).toBe("run");
  });

  it.each([
    {
      name: "historical direct-fallback completion",
      instructions:
        "Historical sessions_spawn and sessions_yield guidance does not grant completion-turn tools.",
      input: [
        makeUserInput(
          "Subagent direct fallback QA check: spawn one worker and yield until QA-SUBAGENT-DIRECT-FALLBACK-OK is delivered.",
        ),
        makeDeveloperInput("Current completion handoff may use only the declared tool surface."),
        makeUserInput(
          "[Internal task completion event]\nTask: qa-direct-fallback-worker\nResult: QA-SUBAGENT-DIRECT-FALLBACK-OK",
        ),
      ],
      silent: true,
    },
    {
      name: "prompt and instruction mentions",
      instructions: "The prior run used sessions_spawn and sessions_yield.",
      input: [
        makeUserInput(
          'Use sessions_spawn for this QA check. task="Return historical answer" label=qa-stale.',
        ),
      ],
      silent: false,
    },
  ])("does not grant subagent tools from $name", async ({ instructions, input, silent }) => {
    const server = await startMockServer();
    const payload = await expectNonStreamingResponsesJson(server, {
      tools: [MESSAGE_TOOL],
      instructions,
      input,
    });
    expect(outputItems(payload).some((item) => item.type === "function_call")).toBe(false);
    if (silent) {
      expect(outputText(payload)).toBe("");
      expect(await readDebugRequest(server)).not.toHaveProperty("plannedToolName");
    }
  });

  it.each([
    [
      "prefers the current direct-fallback worker turn over an earlier parent kickoff",
      [
        makeUserInput("Subagent direct fallback QA check: spawn one worker and yield."),
        makeUserInput(
          "Subagent direct fallback worker: finish with exactly QA-SUBAGENT-DIRECT-FALLBACK-OK.",
        ),
      ],
      "QA-SUBAGENT-DIRECT-FALLBACK-OK",
    ],
  ] as const)("%s", async (_name, input, expected) => {
    const payload = await expectNonStreamingResponsesJson(await startMockServer(), {
      tools: [SESSIONS_SPAWN_TOOL, SESSIONS_YIELD_TOOL],
      input,
    });
    expect(outputItems(payload).some((item) => item.type === "function_call")).toBe(false);
    expect(outputText(payload)).toBe(expected);
  });

  it.each<[string, string | RegExp]>([
    ["Subagent terminal reply QA worker: silent.", "NO_REPLY"],
    [
      "Subagent terminal reply QA worker: fallback.",
      [
        "QA-SUBAGENT-TERMINAL-FALLBACK-OK",
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
        "QA-SUBAGENT-TERMINAL-INTERNAL-MUST-NOT-LEAK",
        "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      ].join("\n"),
    ],
    [
      "Subagent private completion QA worker: first.",
      /^QA-PARENT-PRIVATE-CHILD1-[A-F0-9]{32}\nMEDIA:\.\/qa-private-result\.png$/u,
    ],
  ])("returns the worker result for %s", async (prompt, expected) => {
    const server = await startMockServer();
    const payload = await expectNonStreamingResponsesJson(server, {
      input: [makeUserInput(prompt)],
    });

    if (typeof expected === "string") {
      expect(outputText(payload)).toBe(expected);
    } else {
      expect(outputText(payload)).toMatch(expected);
    }
  });

  it("consumes a private completion to spawn once and records the reviewed outcome", async () => {
    const server = await startMockServer();
    const nonce = "QA-PARENT-PRIVATE-CHILD1-0123456789ABCDEF0123456789ABCDEF";
    const kickoff = makeUserInput("Subagent terminal reply QA check: private.");
    const firstReceipt = makeToolOutputWithCallId(
      "first",
      JSON.stringify({ status: "accepted", childSessionKey: "agent:qa:subagent:first" }),
    );
    const completion = makeUserInput(
      TEST_RUNTIME_CONTEXT_CARRIER.replace(
        "runtime metadata",
        `[Internal task completion event]\ntask: qa-terminal-private-first\nResult: ${nonce}`,
      ),
    );
    const second = await expectNonStreamingResponsesJson(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [kickoff, firstReceipt, completion],
    });
    const call = outputItems(second).find((item) => item.type === "function_call");
    if (!call) {
      throw new Error("Expected second private child spawn");
    }
    expect(call?.name).toBe("sessions_spawn");
    expect(JSON.parse(String(call?.arguments))).toMatchObject({
      label: "qa-terminal-private-second",
      completionTarget: "parent",
      task: expect.stringContaining(nonce),
    });
    const secondReceipt = makeToolOutputWithCallId(
      String(call?.call_id),
      JSON.stringify({ status: "accepted", childSessionKey: "agent:qa:subagent:second" }),
    );
    const continued = await expectNonStreamingResponsesJson(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [kickoff, firstReceipt, completion, call, secondReceipt],
    });
    expect(outputText(continued)).toBe("Second worker started.");
    const settled = await expectNonStreamingResponsesJson(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        kickoff,
        firstReceipt,
        completion,
        call,
        secondReceipt,
        makeUserInput(
          TEST_RUNTIME_CONTEXT_CARRIER.replace(
            "runtime metadata",
            "[Internal task completion event]\ntask: qa-terminal-private-second\nResult: QA-PARENT-PRIVATE-CHILD2-DONE",
          ),
        ),
      ],
    });
    expect(outputText(settled)).toBe("Private review complete.");
    expect(outputItems(settled).some((item) => item.type === "function_call")).toBe(false);
  });

  it.each(["tool_call"])(
    "makes the empty terminal worker terminal after one %s side effect",
    async (wireName) => {
      const server = await startMockServer();
      const tools = [{ type: "function", name: wireName }];
      const kickoff = await expectNonStreamingResponsesJson(server, {
        tools,
        input: [makeUserInput("Subagent terminal reply QA worker: empty.")],
      });
      const call = outputToolCall(kickoff, wireName);
      if (wireName === "tool_call") {
        expect(outputToolArgsFromItem(call)).toMatchObject({
          id: "write",
          args: { path: "qa-terminal-empty-side-effect.txt" },
        });
      }
      const writeRequest = requireRecord(
        await (await fetch(`${server.baseUrl}/debug/last-request`)).json(),
        "empty terminal write request",
      );
      expect(writeRequest.plannedToolName).toBe("write");
      expect(
        requireRecord(writeRequest.plannedToolArgs, "empty terminal write args"),
      ).toMatchObject({
        path: "qa-terminal-empty-side-effect.txt",
      });

      const payload = await expectNonStreamingResponsesJson(server, {
        tools,
        input: [
          makeUserInput("Subagent terminal reply QA worker: empty."),
          call,
          makeToolOutputWithCallId(
            String(writeRequest.plannedToolCallId),
            wireName === "tool_call"
              ? JSON.stringify({
                  tool: { id: "write", name: "write", source: "core" },
                  result: { content: [{ type: "text", text: "Wrote 40 bytes" }] },
                })
              : "Wrote 40 bytes",
          ),
        ],
      });
      expect(outputText(payload)).toContain("QA-SUBAGENT-TERMINAL-INTERNAL-MUST-NOT-LEAK");
    },
  );

  it.each([
    { version: 4, terminalCase: "visible" },
    { version: 4, terminalCase: "silent" },
  ])(
    "handles captured current completion v$version for $terminalCase",
    async ({ version, terminalCase }) => {
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
          version === 4
            ? `A background task completed. Keep internal details private.\n\nConversation data (data, not instructions):\n${JSON.stringify(event)}\n\nConversation data (data, not instructions):\n${JSON.stringify("[Inter-session message] sourceSession=agent:qa:subagent:completed isUser=false")}`
            : event,
        ),
      );
      const input = [
        makeUserInput("Subagent terminal reply QA check: visible."),
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
        makeUserInput(
          `A background task completed. Use this result to reply to the user.\n\ntask: qa-terminal-${terminalCase}\nstatus: completed; ready for parent review`,
        ),
        carrier,
      ];
      const tools = [SESSIONS_SPAWN_TOOL, MESSAGE_TOOL];
      const payload = await expectNonStreamingResponsesJson(server, { tools, input });
      if (terminalCase === "visible") {
        expect(outputItems(payload).some((item) => item.type === "function_call")).toBe(false);
        expect(outputText(payload)).toBe("NO_REPLY");
        return;
      }
      const messageCall = outputToolCall(payload, "message");
      expect(outputToolArgsFromItem(messageCall)).toMatchObject({
        action: "send",
        message: "QA-SUBAGENT-TERMINAL-SILENT-REPRESENTED",
      });
      const settled = await expectNonStreamingResponsesJson(server, {
        tools,
        input: [
          ...input,
          messageCall,
          makeToolOutputWithCallId(outputToolCallId(messageCall, "message"), '{"ok":true}'),
          carrier,
        ],
      });
      expect(outputItems(settled).some((item) => item.type === "function_call")).toBe(false);
      expect(outputText(settled)).toBe("");
    },
  );

  it("surfaces sessions_spawn tool errors instead of echoing child-task tokens", async () => {
    const server = await startMockServer();

    const body = await expectNonStreamingResponsesJson(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(explicitSessionsSpawnPrompt(THREAD_SUBAGENT_CHILD_ERROR_TOKEN)),
        {
          type: "function_call",
          name: "sessions_spawn",
          arguments: JSON.stringify({
            task: threadSubagentTask(THREAD_SUBAGENT_CHILD_ERROR_TOKEN),
            label: "qa-thread-subagent",
            thread: true,
            mode: "session",
          }),
        },
        makeToolOutput(
          JSON.stringify({
            status: "error",
            error: THREAD_SUBAGENT_TOOL_ERROR,
          }),
        ),
      ],
    });

    const text = outputText(body);
    expect(text).toContain(THREAD_SUBAGENT_TOOL_ERROR);
    expect(text).not.toContain(THREAD_SUBAGENT_CHILD_ERROR_TOKEN);
  });

  it("plans memory tools and serves mock image generations", async () => {
    const server = await startMockServer();

    const memorySearch = await expectStreamingResponses(server, {
      input: [
        makeUserInput(
          "Memory tools check: what is the hidden project codename stored only in memory? Use memory tools first.",
        ),
      ],
    });
    expect(await memorySearch.text()).toContain('"name":"memory_search"');

    const memoryGetText = await expectStreamingResponsesText(server, {
      input: [
        makeUserInput(
          "Memory tools check: what is the hidden project codename stored only in memory? Use memory tools first.",
        ),
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
        makeUserInput("Protocol note: acknowledged. Continue with the QA scenario plan."),
      ],
    });
    expect(memoryGetText).toContain('"name":"memory_get"');
    expect(memoryGetText).toContain('\\"path\\":\\"MEMORY.md\\"');
    expect(memoryGetText).toContain('\\"from\\":1');

    const image = await fetchOk(`${server.baseUrl}/v1/images/generations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: "Draw a QA lighthouse",
        n: 1,
        size: "1024x1024",
      }),
    });
    const imagePayload = requireRecord(await image.json(), "image response");
    const imageData = requireArray(imagePayload.data, "image data");
    expect(typeof requireRecord(imageData[0], "image data 0").b64_json).toBe("string");

    const imageRequestLog = requireArray(
      await getJson(server, "/debug/image-generations"),
      "image generation requests",
    );
    const imageRequest = requireRecord(imageRequestLog[0], "image generation request 0");
    expect(imageRequest.model).toBe("gpt-image-1");
    expect(imageRequest.prompt).toBe("Draw a QA lighthouse");
    expect(imageRequest.n).toBe(1);
    expect(imageRequest.size).toBe("1024x1024");
  });

  it("requires memory_get before answering thread recall in Code Mode", async () => {
    const server = await startMockServer();
    const prompt =
      "@openclaw Thread memory check: what is the hidden thread codename stored only in memory? Use memory tools first and reply only in this thread.";

    const initialInput: Array<Record<string, unknown>> = [
      {
        type: "additional_tools",
        role: "developer",
        tools: CODE_MODE_TOOLS,
      },
      makeUserInput(prompt),
    ];

    const searchPlan = await expectOpenAiNonStreamingResponsesJson(server, {
      input: initialInput,
    });
    const searchCall = outputToolCall(searchPlan, "exec");
    const searchCallId = outputToolCallId(searchCall, "call_mock_memory_search");
    const continuationInput: Array<Record<string, unknown>> = [
      makeUserInput(prompt),
      searchCall,
      makeToolOutputWithCallId(
        searchCallId,
        JSON.stringify({
          status: "completed",
          value: {
            results: [
              {
                path: "MEMORY.md",
                startLine: 1,
                endLine: 1,
                snippet: "Thread-hidden codename: ORBIT-21.",
              },
            ],
          },
        }),
      ),
    ];

    const getPlan = await expectOpenAiNonStreamingResponsesJson(server, {
      input: continuationInput,
    });
    const getCall = outputToolCall(getPlan, "memory_get");
    const getCallId = outputToolCallId(getCall, "call_mock_memory_get");
    expect(getCallId).not.toBe(searchCallId);
    expect(outputItems(getPlan).some((item) => item.type === "message")).toBe(false);
    expect(JSON.stringify(getPlan)).not.toContain("hidden thread codename is ORBIT-21");
    continuationInput.push(
      getCall,
      makeToolOutputWithCallId(
        getCallId,
        JSON.stringify({
          status: "completed",
          value: { text: "Thread-hidden codename: ORBIT-22." },
        }),
      ),
    );

    const final = await expectOpenAiNonStreamingResponsesJson(server, {
      input: continuationInput,
    });
    expect(outputText(final)).toContain("ORBIT-22");
    expect(outputText(final)).not.toContain("ORBIT-21");
    expect(outputItems(final).some((item) => item.type === "function_call")).toBe(false);

    const requests = requireArray(await getJson(server, "/debug/requests"), "debug requests").map(
      (request, index) => requireRecord(request, `debug request ${index}`),
    );
    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({
      plannedToolName: "memory_search",
      plannedWireToolName: "exec",
      plannedToolCallId: searchCallId,
    });
    expect(requests[1]).toMatchObject({
      toolOutputCallId: searchCallId,
      plannedToolName: "memory_get",
      plannedToolCallId: getCallId,
    });
    expect(requests[1]).not.toHaveProperty("plannedWireToolName");
    expect(requests[2]).toMatchObject({
      toolOutputCallId: getCallId,
    });
    expect(requests[2]).not.toHaveProperty("plannedToolName");
  });

  it("supports advanced QA memory and subagent recovery prompts", async () => {
    const server = await startMockServer();
    const rankingPrompt =
      "Session memory ranking check: what is the current Project Nebula codename? Use memory tools first.";
    const threadPrompt =
      "@openclaw Thread memory check: what is the hidden thread codename stored only in memory? Use memory tools first and reply only in this thread.";
    const acknowledgement = makeUserInput(
      "Protocol note: acknowledged. Continue with the QA scenario plan.",
    );
    const snack = "lemon pepper wings with blue cheese";
    const activeMemoryPrompt = [
      "You are a memory search agent.",
      "Use only the available memory tools.",
      "Prefer memory_recall when available.",
      "If memory_recall is unavailable, use memory_search and memory_get.",
      "",
      "Conversation context:",
      "Latest user message:",
      "Silent snack recall check: what snack do I usually want for QA movie night? Reply in one short sentence.",
    ].join("\n");
    const rememberPrompt = [
      "You are a memory search agent.",
      "Use only the available memory tools.",
      "Latest user message:",
      "Remember across conversations QA check: what snack do I usually want for QA movie night?",
    ].join("\n");
    const memoryOutput = (value: unknown) => makeToolOutput(JSON.stringify(value));
    const streamMemory = (prompt: string, ...inputs: unknown[]) =>
      expectStreamingResponsesText(server, { input: [makeUserInput(prompt), ...inputs] });
    const streamMemoryResponse = (prompt: string, ...inputs: unknown[]) =>
      expectStreamingResponses(server, { input: [makeUserInput(prompt), ...inputs] });
    const readMemory = (input: unknown[], instructions?: string) =>
      expectNonStreamingResponses(server, {
        ...(instructions ? { instructions } : {}),
        input,
      });

    const memoryText = await streamMemory(rankingPrompt);
    expect(memoryText).toContain('"name":"memory_search"');
    expect(memoryText).not.toContain('\\"corpus\\"');

    const threadMemorySearchText = await expectStreamingResponsesText(server, {
      instructions: threadPrompt,
      input: [acknowledgement],
    });
    expect(threadMemorySearchText).toContain('"name":"memory_search"');
    expect(threadMemorySearchText).toContain("ORBIT-22");

    const threadMemoryGetText = await expectStreamingResponsesText(server, {
      instructions: threadPrompt,
      input: [
        memoryOutput({
          results: [
            {
              path: "MEMORY.md",
              startLine: 1,
              endLine: 1,
              snippet: "Thread-hidden codename: ORBIT-22.",
            },
          ],
        }),
        acknowledgement,
      ],
    });
    expect(threadMemoryGetText).toContain('"name":"memory_get"');
    expect(threadMemoryGetText).toContain('\\"path\\":\\"MEMORY.md\\"');
    expect(threadMemoryGetText).not.toContain("hidden thread codename is ORBIT-22");

    const threadMemorySummary = await readMemory(
      [memoryOutput({ text: "Thread-hidden codename: ORBIT-22." }), acknowledgement],
      threadPrompt,
    );
    expect(JSON.stringify(await threadMemorySummary.json())).toContain("ORBIT-22");

    const rawThreadMemorySummary = await readMemory(
      [makeToolOutput("Thread-hidden codename: ORBIT-23."), acknowledgement],
      threadPrompt,
    );
    const rawThreadMemoryText = JSON.stringify(await rawThreadMemorySummary.json());
    expect(rawThreadMemoryText).toContain("NONE");
    expect(rawThreadMemoryText).not.toContain("ORBIT-23");

    const unavailableThreadMemorySummary = await readMemory([
      {
        role: "system",
        content:
          "Available tools include sessions_spawn.\n## /workspace/MEMORY.md\nThread-hidden codename: ORBIT-22.",
      },
      makeUserInput(threadPrompt),
      memoryOutput({ results: [], unavailable: true, error: "database is not open" }),
    ]);
    const unavailableThreadMemoryText = JSON.stringify(await unavailableThreadMemorySummary.json());
    expect(unavailableThreadMemoryText).toContain("NONE");
    expect(unavailableThreadMemoryText).not.toContain("ORBIT-22");

    const emptyThreadMemorySummary = await readMemory([
      {
        role: "system",
        content: "## /workspace/MEMORY.md\nThread-hidden codename: ORBIT-22.",
      },
      makeUserInput(threadPrompt),
      memoryOutput({ results: [] }),
    ]);
    const emptyThreadMemoryText = JSON.stringify(await emptyThreadMemorySummary.json());
    expect(emptyThreadMemoryText).toContain("NONE");
    expect(emptyThreadMemoryText).not.toContain("ORBIT-22");

    const currentSessionResult = {
      path: "sessions/qa-session-memory-ranking.jsonl",
      startLine: 2,
      endLine: 3,
      snippet: "Project Nebula current codename: ORBIT-10.",
    };
    const memoryFollowup = await streamMemoryResponse(
      rankingPrompt,
      memoryOutput({ results: [currentSessionResult] }),
    );
    expect(await memoryFollowup.text()).toContain(
      "Protocol note: I checked memory and the current Project Nebula codename is ORBIT-10.",
    );

    const memoryFollowupPrefersSessionResult = await streamMemoryResponse(
      rankingPrompt,
      memoryOutput({
        results: [
          {
            path: "MEMORY.md",
            startLine: 1,
            endLine: 2,
            snippet: "Project Nebula stale codename: ORBIT-9.",
          },
          currentSessionResult,
        ],
      }),
    );
    expect(await memoryFollowupPrefersSessionResult.text()).toContain(
      "Protocol note: I checked memory and the current Project Nebula codename is ORBIT-10.",
    );

    const pathOnlySessionMemoryText = await streamMemory(
      rankingPrompt,
      memoryOutput({ results: [{ path: currentSessionResult.path, startLine: 2, endLine: 3 }] }),
    );
    expect(pathOnlySessionMemoryText).toContain('"name":"memory_get"');
    expect(pathOnlySessionMemoryText).not.toContain("codename is ORBIT-10");

    const unavailableSessionMemoryText = await streamMemory(
      rankingPrompt,
      memoryOutput({
        results: [{ path: currentSessionResult.path, snippet: currentSessionResult.snippet }],
        unavailable: true,
        error: "database is not open",
      }),
    );
    expect(unavailableSessionMemoryText).toContain("NONE");
    expect(unavailableSessionMemoryText).not.toContain("codename is ORBIT-10");

    const differentlyRankedSessionMemoryText = await streamMemory(
      rankingPrompt,
      memoryOutput({
        results: [
          { path: currentSessionResult.path, snippet: "Project Nebula current codename: ORBIT-9." },
        ],
      }),
    );
    expect(differentlyRankedSessionMemoryText).toContain("codename is ORBIT-9");
    expect(differentlyRankedSessionMemoryText).not.toContain("codename is ORBIT-10");

    const activeMemorySearch = await streamMemoryResponse(activeMemoryPrompt);
    expect(await activeMemorySearch.text()).toContain('"name":"memory_search"');

    const snackOutput = memoryOutput({ text: `Stable QA movie night snack preference: ${snack}.` });
    const activeMemoryStreamSummary = await streamMemoryResponse(activeMemoryPrompt, snackOutput);
    expect(await activeMemoryStreamSummary.text()).toContain("lemon pepper wings with blue cheese");

    const activeMemorySummary = await readMemory([makeUserInput(activeMemoryPrompt), snackOutput]);
    expect(JSON.stringify(await activeMemorySummary.json())).toContain(
      "lemon pepper wings with blue cheese",
    );

    const injectedMemory = `<active_memory_plugin>User usually wants ${snack} for QA movie night.</active_memory_plugin>`;
    const injectedMainReply = await readMemory(
      [
        makeUserInput(
          "Silent snack recall check: what snack do I usually want for QA movie night? Reply in one short sentence.",
        ),
      ],
      ["System context:", injectedMemory].join("\n"),
    );
    expect(JSON.stringify(await injectedMainReply.json())).toContain(
      "lemon pepper wings with blue cheese",
    );
    const lastRequestPayload = await readDebugRequest(server);
    expect(String(lastRequestPayload.instructions)).toContain("<active_memory_plugin>");
    expect(String(lastRequestPayload.allInputText)).toContain("<active_memory_plugin>");

    const rememberSearchText = await streamMemory(rememberPrompt);
    expect(rememberSearchText).toContain('"name":"memory_search"');
    expect(rememberSearchText).toContain("QA movie night snack lemon pepper wings blue cheese");
    expect(rememberSearchText).toContain('\\"maxResults\\":10');

    const rememberSearchSummaryText = await streamMemory(
      rememberPrompt,
      memoryOutput({
        results: [
          {
            path: "sessions/private-source.jsonl",
            startLine: 2,
            endLine: 3,
            snippet: `Stable QA movie night snack preference: ${snack}.`,
          },
        ],
      }),
    );
    expect(rememberSearchSummaryText).toContain("lemon pepper wings with blue cheese");
    expect(rememberSearchSummaryText).not.toContain('"name":"memory_get"');

    const rememberInjectedMainReply = await readMemory(
      [
        makeUserInput(
          "Remember across conversations QA check: what snack do I usually want for QA movie night?",
        ),
      ],
      injectedMemory,
    );
    expect(JSON.stringify(await rememberInjectedMainReply.json())).toContain(
      "lemon pepper wings with blue cheese",
    );

    const fanoutPrompt = QA_FANOUT_PROMPT;
    const spawnBody = await expectStreamingResponsesText(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [makeUserInput(fanoutPrompt)],
    });
    expect(spawnBody).toContain('"name":"sessions_spawn"');
    expect(spawnBody).toContain('\\"label\\":\\"qa-fanout-alpha\\"');

    const secondSpawnBody = await expectStreamingResponsesText(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(fanoutPrompt),
        makeToolOutput(
          '{"status":"accepted","childSessionKey":"agent:qa:subagent:alpha","note":"ALPHA-OK"}',
        ),
      ],
    });
    expect(secondSpawnBody).toContain('"name":"sessions_spawn"');
    expect(secondSpawnBody).toContain('\\"label\\":\\"qa-fanout-beta\\"');

    const final = await expectNonStreamingResponses(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(fanoutPrompt),
        makeToolOutput(
          '{"status":"accepted","childSessionKey":"agent:qa:subagent:beta","note":"BETA-OK"}',
        ),
      ],
    });
    expect(outputText(await final.json())).toBe("subagent-1: ok\nsubagent-2: ok");
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
        const input = [
          makeUserInput(QA_FANOUT_PROMPT),
          makeUserInput(
            `[Internal task completion event]\n${markers.map((marker) => `result: ${marker}`).join("\n")}`,
          ),
        ];
        const request = {
          tools: combined ? tools : canDeliver ? [MESSAGE_TOOL] : [],
          ...withInstructions(input),
        };
        const completion = await expectNonStreamingResponsesJson(server, request);
        if (!canDeliver || !markers.includes("BETA-OK")) {
          expect(outputItems(completion).some((item) => item.type === "function_call")).toBe(false);
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
          expect(outputItems(settled).some((item) => item.type === "function_call")).toBe(false);
          expect(outputText(settled)).toBe("");
        }
      }
      if (!canDeliver) {
        const wake = await expectNonStreamingResponsesJson(server, {
          tools: [SESSIONS_SPAWN_TOOL],
          input: [
            makeUserInput(QA_FANOUT_PROMPT),
            makeUserInput(
              "[Subagent Context] Every subagent in this batch has now settled.\n[Subagent Context] Review the completion results and send your consolidated final answer to the user now.\nALPHA-OK\nBETA-OK",
            ),
          ],
        });
        expect(outputItems(wake).some((item) => item.type === "function_call")).toBe(false);
        expect(outputText(wake)).toBe("subagent-1: ok\nsubagent-2: ok");
      }
    },
  );

  it("replays completed subagent fanout on requester-settle continuation turns", async () => {
    const server = await startMockServer();

    const prompt = QA_FANOUT_PROMPT;
    const spawn = await expectStreamingResponses(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [makeUserInput(prompt)],
    });
    expect(await spawn.text()).toContain('\\"label\\":\\"qa-fanout-alpha\\"');

    const secondSpawn = await expectStreamingResponses(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(prompt),
        makeToolOutput(
          '{"status":"accepted","childSessionKey":"agent:qa:subagent:alpha","note":"ALPHA-OK"}',
        ),
      ],
    });
    expect(await secondSpawn.text()).toContain('\\"label\\":\\"qa-fanout-beta\\"');

    const settledFinal = await expectNonStreamingResponses(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(prompt),
        makeUserInput(
          "[Subagent Context] Every subagent in this batch has now settled.\nALPHA-OK\nBETA-OK",
        ),
      ],
    });
    expect(outputText(await settledFinal.json())).toBe("subagent-1: ok\nsubagent-2: ok");

    const settledPayload = await expectNonStreamingResponsesJson(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(prompt),
        makeUserInput(
          "[Inter-session message]\nALPHA-OK\nBETA-OK\nAll spawned subagents have settled. Resume the parent turn and report both results together.",
        ),
      ],
    });
    expect(outputText(settledPayload)).toBe("subagent-1: ok\nsubagent-2: ok");
    expect(outputItems(settledPayload)).not.toContainEqual(
      expect.objectContaining({ type: "function_call", name: "sessions_spawn" }),
    );

    const unrelatedContinuation = await expectNonStreamingResponses(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [makeUserInput("Continue with an unrelated conversation.")],
    });
    expect(outputText(await unrelatedContinuation.json())).not.toBe(
      "subagent-1: ok\nsubagent-2: ok",
    );

    const restartedFanout = await expectNonStreamingResponses(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [makeUserInput(prompt)],
    });
    expect(
      outputToolArgsFromItem(outputToolCall(await restartedFanout.json(), "sessions_spawn")),
    ).toEqual(expect.objectContaining({ label: "qa-fanout-alpha" }));
  });

  it("keeps source discovery reports out of subagent handoff prose", async () => {
    const server = await startMockServer();

    const response = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput(
          "Read the seeded docs and source plan, then report grouped into Worked, Failed, Blocked, and Follow-up.",
        ),
        makeToolOutput(
          "repo/qa/scenarios/index.yaml includes scenario: subagent-handoff and repo/extensions/qa-lab/src/suite.ts.",
        ),
        makeUserInput("Continue."),
      ],
    });

    const text = outputText(await response.json());
    expect(text).toContain("Worked:");
    expect(text).toContain("repo/docs/help/testing.md");
    expect(text).toContain("Follow-up:");
    expect(text).not.toContain("Delegated task");
  });

  it("does not let fanout completion state hijack child worker replies", async () => {
    const server = await startMockServer();

    const prompt = QA_FANOUT_PROMPT;
    const spawn = await expectStreamingResponses(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [makeUserInput(prompt)],
    });
    expect(await spawn.text()).toContain('\\"label\\":\\"qa-fanout-alpha\\"');

    const secondSpawn = await expectStreamingResponses(server, {
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        makeUserInput(prompt),
        makeToolOutput(
          '{"status":"accepted","childSessionKey":"agent:qa:subagent:alpha","note":"ALPHA-OK"}',
        ),
      ],
    });
    expect(await secondSpawn.text()).toContain('\\"label\\":\\"qa-fanout-beta\\"');

    const childReply = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput(
          "Fanout worker alpha: inspect the QA workspace and finish with exactly ALPHA-OK.",
        ),
      ],
    });
    expect(outputText(await childReply.json())).toBe("ALPHA-OK");
  });

  it.each([
    {
      name: "automation heartbeat",
      prompt:
        "System: Gateway restart config-apply ok\n\nFollow the heartbeat monitor scratch context when provided. If nothing needs attention, reply NO_REPLY.",
      reply: "NO_REPLY",
    },
  ])("answers $name prompts without spawning extra subagents", async ({ prompt, reply }) => {
    const server = await startMockServer();

    const response = await expectNonStreamingResponses(server, {
      input: [makeUserInput(prompt)],
    });

    expect(outputText(await response.json())).toBe(reply);
  });

  it("returns exact markers for visible and hot-installed skills", async () => {
    const server = await startMockServer();

    const visible = await expectNonStreamingResponses(server, {
      input: [makeUserInput("Visible skill marker: give me the visible skill marker exactly.")],
    });
    expect(outputText(await visible.json())).toBe("VISIBLE-SKILL-OK");

    const hot = await expectNonStreamingResponses(server, {
      input: [makeUserInput("Hot install marker: give me the hot install marker exactly.")],
    });
    expect(outputText(await hot.json())).toBe("HOT-INSTALL-OK");
  });

  it("reads only current WhatsApp sticker context", async () => {
    const server = await startMockServer();
    const history = [
      WHATSAPP_STRUCTURED_SETUP_INPUT,
      makeUserInput("Reply with only this exact marker: QA_DOCUMENT_OK"),
    ];
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
        const payload = await expectNonStreamingResponsesJson(server, {
          input: [...history, ...input],
        });
        expect(outputText(payload)).toBe(expected);
      }
    }
  });

  it("detects each WhatsApp structured body after a channel envelope", async () => {
    const server = await startMockServer();
    const setupInput = WHATSAPP_STRUCTURED_SETUP_INPUT;

    for (const structuredCase of WHATSAPP_STRUCTURED_CASES) {
      const response = await readMockResponse(server, [
        setupInput,
        makeUserInput("Reply with only this previous document marker: QA_WHATSAPP_DOCUMENT_OK"),
        ...makeWhatsAppStructuredInput(
          `[WhatsApp +15555550123] +15555550123: ${structuredCase.body}`,
          "mediaKind" in structuredCase ? structuredCase.mediaKind : undefined,
        ),
      ]);

      expect(outputText(await response.json())).toBe(structuredCase.expected);
    }
  });

  it("uses image generation directives from request context when the latest user text is generic", async () => {
    const server = await startMockServer();

    const channelPrompt =
      '@qa-sut.example.test /tool image_generate action=generate prompt="QA lighthouse image for Matrix delivery testing" size=1024x1024 count=1';
    const genericPrompt =
      "Continue with the QA scenario plan and report worked, failed, and blocked items.";

    const toolPlan = await expectNonStreamingResponses(server, {
      tools: [IMAGE_GENERATE_TOOL],
      input: [makeUserInput(channelPrompt), makeUserInput(genericPrompt)],
    });

    const toolPlanOutput = outputItem(await toolPlan.json());
    expect(toolPlanOutput.type).toBe("function_call");
    expect(toolPlanOutput.name).toBe("image_generate");
    expect(String(toolPlanOutput.arguments)).toContain("qa-lighthouse.png");

    const toolResult = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput(channelPrompt),
        makeUserInput(genericPrompt),
        {
          type: "function_call",
          name: "image_generate",
          call_id: "call_mock_image_generate_1",
          arguments: JSON.stringify({
            prompt: "A QA lighthouse",
            filename: "qa-lighthouse.png",
          }),
        },
        makeToolOutputWithCallId(
          "call_mock_image_generate_1",
          JSON.stringify({
            details: { media: { mediaUrls: ["/tmp/qa-lighthouse.png"] } },
          }),
        ),
      ],
    });

    expect(outputText(await toolResult.json())).toContain("Attachment: /tmp/qa-lighthouse.png");
  });

  it("completes an image without replaying a tool unavailable to the completion turn", async () => {
    const server = await startMockServer();
    const prompt = "Image generation check: generate a QA lighthouse image.";
    const imagePlan = await expectNonStreamingResponsesJson<unknown>(server, {
      tools: [IMAGE_GENERATE_TOOL],
      input: [makeUserInput(prompt)],
    });
    const imageCall = outputToolCall(imagePlan, "image_generate");
    const callId = outputToolCallId(imageCall, "call_mock_image_generate_unavailable");
    const completionEvent = [
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "OpenClaw runtime context (internal):",
      "",
      "[Internal task completion event]",
      "source: image_generation",
      "task: A QA lighthouse on a dark sea with a tiny protocol droid silhouette.",
      "status: completed successfully",
      "Generated media:",
      "MEDIA:/tmp/qa-lighthouse.png",
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    ].join("\n");
    const completion = await expectNonStreamingResponsesJson<unknown>(server, {
      tools: [MESSAGE_TOOL],
      input: [
        makeUserInput(prompt),
        {
          type: "function_call",
          name: "image_generate",
          call_id: callId,
          arguments: String(imageCall.arguments),
        },
        makeToolOutputWithCallId(
          callId,
          JSON.stringify({
            content: [{ type: "text", text: "Background image generation started." }],
            details: { async: true, status: "started" },
          }),
        ),
        makeUserInput(completionEvent),
      ],
    });

    expect(
      outputItems(completion).some(
        (item) => item.type === "function_call" && item.name === "image_generate",
      ),
    ).toBe(false);
    expect(outputText(completion)).toBe(
      "Protocol note: generated the QA lighthouse image successfully.\nMEDIA:/tmp/qa-lighthouse.png",
    );
  });

  it.each([
    [
      "plans QA tool-search failure calls with denied-input args",
      {
        input: [
          makeUserInput(
            "tool search qa failure target=web_search. Exercise the denied-input path once and then summarize.",
          ),
        ],
      },
      "web_search",
      "OPENCLAW_QA_WEB_SEARCH_DENIED_INPUT",
    ],
  ] as const)("%s", async (_name, body, tool, argument) => {
    const item = outputItem(await expectNonStreamingResponsesJson(await startMockServer(), body));
    expect(item.type).toBe("function_call");
    expect(item.name).toBe(tool);
    expect(String(item.arguments)).toContain(argument);
  });

  it.each([
    [
      "plans one structured batch search for the Tool Search gateway fixture",
      {
        tools: [{ type: "function", name: "tool_search" }],
        input: [
          makeUserInput(
            "tool search qa check target=fake_plugin_tool_17. Call exactly that tool once and then summarize.",
          ),
        ],
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
    expect(item.type).toBe("function_call");
    expect(item.name).toBe(tool);
    expect(JSON.parse(String(item.arguments))).toEqual(args);
  });

  const catalogTarget = "fake_plugin_tool_17";
  const catalogQueries = [
    { query: catalogTarget, limit: 1 },
    { query: QA_TOOL_SEARCH_SECONDARY_TARGET, limit: 1 },
  ];
  it.each([
    {
      name: "calls the selected catalog tool after a structured batch search",
      tools: ["tool_search", "tool_call"],
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
      tools: ["tool_search", "tool_call"],
      callName: "tool_search",
      callId: "call_tool_search_1",
      args: { queries: [{ query: catalogTarget, limit: 1 }] },
      output: JSON.stringify({ results: [{ query: catalogTarget, candidates: [] }] }),
      invokes: false,
    },
  ])("$name", async ({ tools, callName, callId, args, output, invokes }) => {
    const payload = await expectNonStreamingResponsesJson(await startMockServer(), {
      tools: tools.map((name) => ({ type: "function", name })),
      input: [
        makeUserInput(
          `tool search qa check target=${catalogTarget}. Call exactly that tool once and then summarize.`,
        ),
        { type: "function_call", call_id: callId, name: callName, arguments: JSON.stringify(args) },
        makeToolOutputWithCallId(callId, output),
      ],
    });
    const item = outputItem(payload);
    if (invokes) {
      expect(item.type).toBe("function_call");
      expect(item.name).toBe("tool_call");
      expect(JSON.parse(String(item.arguments))).toMatchObject({ id: catalogTarget });
    } else {
      expect(item.name).not.toBe("tool_call");
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
    const response = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput(
          `tool search qa check target=ask_user ask_user_fixture=${entry.fixture}. Ask the question.`,
        ),
      ],
    });

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

  it("preserves namespaced native custom-tool identity over Responses WebSocket", async () => {
    const server = await startMockServer();
    const socket = new WebSocket(`${server.baseUrl.replace(/^http/u, "ws")}/v1/responses`);
    cleanups.push(async () => socket.terminate());
    await once(socket, "open");

    const completed = new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const events: Array<Record<string, unknown>> = [];
      socket.on("error", reject);
      socket.on("message", (message) => {
        const event = JSON.parse(Buffer.from(message as Buffer).toString("utf8")) as Record<
          string,
          unknown
        >;
        events.push(event);
        if (event.type === "response.completed") {
          resolve(events);
        }
      });
    });
    socket.send(
      JSON.stringify({
        type: "response.create",
        tools: [CODEX_CUSTOM_PATCH_NAMESPACE],
        input: [
          makeUserInput(
            "tool search qa check target=apply_patch. Call apply_patch exactly once and then summarize.",
          ),
        ],
      }),
    );

    const events = await completed;
    const added = requireRecord(
      events.find((event) => event.type === "response.output_item.added")?.item,
      "WebSocket custom-tool added item",
    );
    const done = requireRecord(
      events.find((event) => event.type === "response.output_item.done")?.item,
      "WebSocket custom-tool completed item",
    );
    const response = requireRecord(
      events.find((event) => event.type === "response.completed")?.response,
      "WebSocket completed response",
    );
    for (const item of [added, done, outputItem(response)]) {
      expect(item).toMatchObject({
        type: "custom_tool_call",
        name: "apply_patch",
        namespace: "openclaw_direct",
      });
    }
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
    const planResponse = await expectNonStreamingResponses(server, {
      input: [makeUserInput(testCase.prompt)],
    });
    const plannedCall = outputItem(await planResponse.json());
    expect(plannedCall).toMatchObject({ type: "function_call", name: "apply_patch" });
    const callId = outputToolCallId(plannedCall, "native-patch-call");

    const continuationResponse = await expectNonStreamingResponses(server, {
      input: [
        makeUserInput(testCase.prompt),
        {
          type: "custom_tool_call_output",
          call_id: callId,
          output: testCase.output,
          ...(testCase.structuredError ? { is_error: true } : {}),
        },
      ],
    });
    expect(outputItem(await continuationResponse.json()).type).toBe("message");

    const debug = await readDebugRequest(server);
    expect(debug.toolOutput).toBe(testCase.expectedOutput);
    expect(debug.toolOutputCallId).toBe(callId);
    if (testCase.structuredError) {
      expect(debug.toolOutputStructuredError).toBe(true);
    } else {
      expect(debug).not.toHaveProperty("toolOutputStructuredError");
    }
    expect(debug).not.toHaveProperty("plannedToolName");
  });

  it.each([
    [
      "uses current request instructions for image descriptions",
      [
        makeDeveloperInput(QA_IMAGE_DESCRIPTION_PROMPT),
        makeImageUserInput(QA_IMAGE_INPUT, QA_IMAGE_MEDIA_CONTEXT),
      ],
      ["red", "blue"],
    ],
    [
      "describes reattached generated images in the roundtrip flow",
      [
        makeImageUserInput(
          {
            type: "input_text",
            text: "Roundtrip image inspection check: describe the generated lighthouse attachment in one short sentence.",
          },
          QA_IMAGE_INPUT,
        ),
      ],
      ["lighthouse"],
    ],
  ] as const)("%s", async (_name, input, words) => {
    const text = (
      await readMockImageResponseText(await startMockServer(), [...input])
    ).toLowerCase();
    for (const word of words) {
      expect(text).toContain(word);
    }
  });

  it("handles deeply nested image input shapes without recursive traversal failure", async () => {
    const server = await startMockServer();

    let content: unknown = {
      type: "input_image",
      source: {
        type: "base64",
        mime_type: "image/png",
        data: QA_IMAGE_PNG_BASE64,
      },
    };
    for (let index = 0; index < 4_000; index += 1) {
      content = [{ type: "input_text", text: "nested" }, content];
    }

    await expectNonStreamingResponses(server, {
      model: "mock-openai/gpt-5.6-luna",
      input: [
        {
          role: "user",
          content,
        },
      ],
    });

    expect((await readDebugRequest(server)).imageInputCount).toBe(1);
  });

  it("rereads the current model-switch turn before reporting continuity", async () => {
    const server = await startMockServer();

    const response = await expectStreamingResponses(server, {
      input: [
        makeUserInput("Read QA_KICKOFF_TASK.md first."),
        makeToolOutput("QA mission: read source and docs first."),
        makeUserInput(
          "Switch models now. Tool continuity check: reread QA_KICKOFF_TASK.md and mention the handoff in one short sentence.",
        ),
      ],
    });
    expect(await response.text()).toContain('"name":"read"');

    const completed = await expectNonStreamingResponses(server, {
      model: "gpt-5.6-luna-alt",
      input: [
        makeUserInput(
          "Switch models now. Tool continuity check: reread QA_KICKOFF_TASK.md and mention the handoff in one short sentence.",
        ),
        makeToolOutput(
          "QA mission: Understand this OpenClaw repo from source + docs before acting.",
        ),
      ],
    });

    expect(outputText(await completed.json())).toContain("model switch handoff confirmed");
  });

  it("returns the Codex remote-compaction-v2 response shape", async () => {
    const server = await startMockServer();

    const response = await expectStreamingResponses(server, {
      input: [makeUserInput("Retained context."), { type: "compaction_trigger" }],
    });

    const body = await response.text();
    expect(body).toContain('"type":"response.output_item.done"');
    expect(body).toContain('"type":"compaction"');
    expect(body).toContain('"encrypted_content":"QA_MOCK_REMOTE_COMPACTION_SUMMARY"');
    expect(body).toContain('"type":"response.completed"');
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
      {
        item: { call_id: "toolu_native_123" },
      },
    ]);
  });
  it("uses native Codex custom exec, output arrays, and cell_id waits", async () => {
    const server = await startMockServer();
    const tools = NATIVE_CODE_MODE_TOOLS;
    const prompt = QA_COMPACTION_RETRY_PROMPT;
    const execPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools,
      input: [makeUserInput(prompt)],
    });
    const execCall = outputItem(execPayload);
    expect(execCall).toMatchObject({ type: "custom_tool_call", name: "exec" });
    const source = String(execCall.input);
    expect(source).toContain("tools[target.name](targetArgs)");
    expect(source).toContain("text(JSON.stringify(value));");
    expect(source).not.toContain("tools.callValue");
    expect(source).not.toContain("target.id");
    expect(source).not.toMatch(/ALL_TOOLS[^\n]*\.id/);
    expect(source).not.toContain("return value");

    const execCallId = outputToolCallId(execCall, "native-exec");
    const waitPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools,
      input: [
        makeUserInput(prompt),
        execCall,
        {
          type: "custom_tool_call_output",
          call_id: execCallId,
          output: [
            {
              type: "input_text",
              text: "Script running with cell ID cell-write-1\nLive output:\n",
            },
          ],
        },
      ],
    });
    const waitCall = outputToolCall(waitPayload, "wait");
    expect(outputToolArgsFromItem(waitCall)).toEqual({ cell_id: "cell-write-1" });

    const finalPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools,
      input: [
        makeUserInput(prompt),
        execCall,
        {
          type: "custom_tool_call_output",
          call_id: execCallId,
          output: [
            {
              type: "input_text",
              text: "Script running with cell ID cell-write-1\nLive output:\n",
            },
          ],
        },
        waitCall,
        {
          type: "function_call_output",
          call_id: outputToolCallId(waitCall, "native-wait"),
          output: [
            { type: "input_text", text: "Script completed\nWall time: 0.1 seconds\nOutput:\n" },
            {
              type: "input_text",
              text: JSON.stringify({ status: "completed", value: { changed: false } }),
            },
            {
              type: "input_text",
              text: JSON.stringify(QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT),
            },
          ],
        },
      ],
    });
    expect(outputText(finalPayload)).toBe("Protocol note: replay unsafe after write.");
  });

  it.each([
    {
      label: "terminated header with canonical JSON",
      output: [
        { type: "input_text", text: "Script terminated\nWall time: 0.1 seconds\nOutput:\n" },
        {
          type: "input_text",
          text: JSON.stringify(QA_COMPACTION_RETRY_CODE_MODE_WRITE_RESULT),
        },
      ],
    },
    {
      label: "completed header without JSON",
      output: [{ type: "input_text", text: "Script completed\nWall time: 0.1 seconds\nOutput:\n" }],
    },
  ])("rejects native Code Mode compaction evidence with $label", async ({ output }) => {
    const server = await startMockServer();
    const tools = NATIVE_CODE_MODE_TOOLS;
    const execPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools,
      input: [makeUserInput(QA_COMPACTION_RETRY_PROMPT)],
    });
    const execCall = outputItem(execPayload);
    const payload = await expectOpenAiNonStreamingResponsesJson(server, {
      tools,
      input: [
        makeUserInput(QA_COMPACTION_RETRY_PROMPT),
        execCall,
        {
          type: "custom_tool_call_output",
          call_id: outputToolCallId(execCall, "native-exec"),
          output,
        },
      ],
    });

    expect(outputItems(payload).some((item) => item.type === "function_call")).toBe(false);
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
        makeAnthropicToolResult(toolUse.id, JSON.stringify({ status: "completed", value })),
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

  it("places tool_result after the parent user message even in mixed-content turns", async () => {
    // Fresh text must not fence out the tool result from the same turn.
    const server = await startMockServer();

    await expectAnthropicMessages(server, {
      messages: [
        makeAnthropicUserText("Delegate one bounded QA task to a subagent."),
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_mock_spawn_mixed",
              name: "sessions_spawn",
              input: { task: "Inspect the QA workspace", label: "qa-sidecar", thread: false },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_mock_spawn_mixed",
              content: "SUBAGENT-OK",
            },
            {
              type: "text",
              text: "Keep going with the fanout.",
            },
          ],
        },
      ],
    });

    const debug = (await fetchOkJson(`${server.baseUrl}/debug/last-request`)) as {
      prompt: string;
      allInputText: string;
      toolOutputCallId: string;
      toolOutput: string;
    };
    expect(debug.toolOutput).toBe("SUBAGENT-OK");
    expect(debug.toolOutputCallId).toBe("toolu_mock_spawn_mixed");
    expect(debug.prompt).toBe("Keep going with the fanout.");
    expect(debug.allInputText).toContain("Delegate one bounded QA task");
  });

  it("exposes structured Anthropic tool_result errors in debug snapshots", async () => {
    const server = await startMockServer();

    await expectAnthropicMessages(server, {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_mock_read_error",
              name: "read",
              input: { path: "/missing" },
            },
          ],
        },
        makeAnthropicErrorToolResult("toolu_mock_read_error", "ENOENT: no such file or directory"),
      ],
    });

    const debug = (await fetchOkJson(`${server.baseUrl}/debug/last-request`)) as {
      toolOutputCallId: string;
      toolOutputStructuredError?: boolean;
    };
    expect(debug.toolOutputCallId).toBe("toolu_mock_read_error");
    expect(debug.toolOutputStructuredError).toBe(true);
  });

  it.each([{ label: "whitespace", content: "  ", isError: false }])(
    "preserves $label Anthropic tool results without replay",
    async ({ content, isError }) => {
      const server = await startMockServer();
      const callId = "toolu_empty_patch";
      const response = await expectAnthropicMessages(server, {
        tools: [{ name: "apply_patch", input_schema: { type: "object", properties: {} } }],
        messages: [
          makeAnthropicUserText(
            "tool search qa check target=apply_patch. Call apply_patch exactly once and then summarize.",
          ),
          {
            role: "assistant",
            content: [{ type: "tool_use", id: callId, name: "apply_patch", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: callId,
                content,
                ...(isError ? { is_error: true } : {}),
              },
            ],
          },
        ],
      });

      const body = requireRecord(await response.json(), "Anthropic empty tool completion");
      expect(body.stop_reason).toBe("end_turn");
      expect(requireArray(body.content, "Anthropic response content")).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "tool_use" })]),
      );
      const debug = requireRecord(
        await fetch(`${server.baseUrl}/debug/last-request`).then((result) => result.json()),
        "Anthropic empty tool debug request",
      );
      expect(debug.toolOutputCallId).toBe(callId);
      expect(debug.toolOutputStructuredError ?? false).toBe(isError);
      expect(debug).not.toHaveProperty("plannedToolName");
    },
  );

  it("replays one signed Anthropic thinking error for each independent scenario", async () => {
    const server = await startMockServer();
    const readCallIds: string[] = [];
    const scenarioPrompts: string[] = [];

    const requestAnthropicStream = async (messages: unknown[]) => {
      const response = await expectAnthropicMessages(server, {
        stream: true,
        messages,
      });
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      return response.text();
    };

    const readAnthropicToolCallId = (readStream: string) => {
      const readEvents = readStream
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) =>
          requireRecord(JSON.parse(line.slice("data: ".length)) as unknown, "Anthropic SSE event"),
        );
      const readEvent = readEvents.find(
        (event) =>
          event.type === "content_block_start" &&
          requireRecord(event.content_block, "Anthropic content block").type === "tool_use",
      );
      const readTool = requireRecord(readEvent?.content_block, "Anthropic read tool call");
      expect(readTool.name).toBe("read");
      expect(readTool.input).toEqual({});
      const readInputEvent = readEvents.find(
        (event) => event.type === "content_block_delta" && event.index === readEvent?.index,
      );
      expect(requireRecord(readInputEvent?.delta, "Anthropic read tool input delta")).toEqual({
        type: "input_json_delta",
        partial_json: JSON.stringify({ path: "QA_KICKOFF_TASK.md" }),
      });
      const callId = readTool.id;
      if (typeof callId !== "string" || callId.length === 0) {
        throw new Error("Expected an Anthropic read tool call ID");
      }
      readCallIds.push(callId);
      return callId;
    };

    const buildReplayMessages = (
      promptMessage: { role: "user"; content: Array<{ type: "text"; text: string }> },
      callId: string,
    ) => [
      promptMessage,
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: callId,
            name: "read",
            input: { path: "QA_KICKOFF_TASK.md" },
          },
        ],
      },
      makeAnthropicToolResult(callId, "QA kickoff task completed."),
    ];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const scenarioPrompt = `${QA_ANTHROPIC_THINKING_ERROR_RECOVERY_PROMPT} QA scenario run: direct-${attempt}`;
      scenarioPrompts.push(scenarioPrompt);
      const promptMessage = makeAnthropicUserText(scenarioPrompt);
      const initialCallId = readAnthropicToolCallId(await requestAnthropicStream([promptMessage]));
      const errorStream = await requestAnthropicStream(
        buildReplayMessages(promptMessage, initialCallId),
      );
      expect(errorStream).toContain('"type":"thinking_delta"');
      expect(errorStream).toContain('"type":"signature_delta"');
      expect(errorStream).toContain('"signature":"qa_signed_thinking_block_91953"');
      expect(errorStream).toContain("event: error");
      expect(errorStream).toContain('"type":"api_error"');

      const retryCallId = readAnthropicToolCallId(await requestAnthropicStream([promptMessage]));
      expect(retryCallId).not.toBe(initialCallId);
      const recoveryStream = await requestAnthropicStream(
        buildReplayMessages(promptMessage, retryCallId),
      );
      expect(recoveryStream).toContain("event: message_stop");
      expect(recoveryStream).toContain("ANTHROPIC-THINKING-ERROR-RECOVERED-OK");
      expect(recoveryStream).not.toContain("event: error");
    }

    expect(new Set(readCallIds).size).toBe(4);
    const debugRequests = requireArray(
      await getJson(server, "/debug/requests"),
      "Anthropic debug requests",
    ).map((request) => requireRecord(request, "Anthropic debug request"));
    expect(debugRequests).toHaveLength(8);
    expect(debugRequests.every((request) => request.providerVariant === "anthropic")).toBe(true);
    expect(debugRequests.map((request) => request.plannedToolCallId)).toEqual([
      readCallIds[0],
      undefined,
      readCallIds[1],
      undefined,
      readCallIds[2],
      undefined,
      readCallIds[3],
      undefined,
    ]);
    expect(debugRequests.map((request) => request.toolOutputCallId)).toEqual([
      undefined,
      readCallIds[0],
      undefined,
      readCallIds[1],
      undefined,
      readCallIds[2],
      undefined,
      readCallIds[3],
    ]);
    expect(debugRequests.map((request) => request.prompt)).toEqual([
      scenarioPrompts[0],
      scenarioPrompts[0],
      scenarioPrompts[0],
      scenarioPrompts[0],
      scenarioPrompts[1],
      scenarioPrompts[1],
      scenarioPrompts[1],
      scenarioPrompts[1],
    ]);
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

    const body = (await expectPostJsonJson(server, "/v1/messages", {
      model: "",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: "Read the plan",
        },
      ],
    })) as { model: string };
    expect(body.model).toBe("claude-opus-4-8");

    const debug = (await fetchOkJson(`${server.baseUrl}/debug/last-request`)) as { model: string };
    expect(debug.model).toBe("claude-opus-4-8");
  });

  it("scripts a reasoning-only recovery sequence after a replay-safe read", async () => {
    const server = await startMockServer();

    const toolPlan = await readOpenAiPromptResponseText(server, QA_REASONING_ONLY_RECOVERY_PROMPT);
    expect(toolPlan).toContain('"name":"read"');
    expect(toolPlan).toContain("QA_KICKOFF_TASK.md");

    const reasoningPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [
        makeUserInput(QA_REASONING_ONLY_RECOVERY_PROMPT),
        makeToolOutput(
          "QA mission: Understand this OpenClaw repo from source + docs before acting.",
        ),
      ],
    });
    const reasoningOutput = outputItem(reasoningPayload);
    expect(reasoningOutput.type).toBe("reasoning");
    expect(reasoningOutput.id).toBe("rs_mock_reasoning_recovery");
    const reasoningSummary = requireArray(reasoningOutput.summary, "reasoning summary");
    expect(String(requireRecord(reasoningSummary[0], "reasoning summary 0").text)).toContain(
      "Need visible answer",
    );

    const recoveredPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [
        makeUserInput(QA_REASONING_ONLY_RECOVERY_PROMPT),
        makeUserInput(QA_REASONING_ONLY_RETRY_INSTRUCTION),
        makeToolOutput(
          "QA mission: Understand this OpenClaw repo from source + docs before acting.",
        ),
      ],
    });
    expect(outputText(recoveredPayload)).toBe("REASONING-RECOVERED-OK");

    const requestLog = requireArray(await getJson(server, "/debug/requests"), "debug requests");
    expect(requireRecord(requestLog[0], "debug request 0").plannedToolName).toBe("read");
    expect(String(requireRecord(requestLog[1], "debug request 1").allInputText)).toContain(
      QA_REASONING_ONLY_RECOVERY_PROMPT,
    );
    expect(String(requireRecord(requestLog[2], "debug request 2").allInputText)).toContain(
      QA_REASONING_ONLY_RETRY_INSTRUCTION,
    );
  });

  it.each([
    {
      name: "explicit",
      primaryModel: "mock-empty-primary",
      fallbackModel: "mock-visible-fallback",
    },
  ])("scripts mixed reasoning-plus-blank output for the $name model pair", async (models) => {
    const server = await startMockServer();

    const primary = await expectOpenAiNonStreamingResponsesJson(server, {
      model: models.primaryModel,
      input: [makeUserInput(QA_MIXED_REASONING_BLANK_FALLBACK_PROMPT)],
    });
    expect(outputItems(primary).map((item) => item.type)).toEqual(["reasoning", "message"]);
    expect(outputText(primary, 1)).toBe(" ");

    const fallback = await expectOpenAiNonStreamingResponsesJson(server, {
      model: models.fallbackModel,
      input: [makeUserInput(QA_MIXED_REASONING_BLANK_FALLBACK_PROMPT)],
    });
    expect(outputText(fallback)).toBe("MODEL-FALLBACK-VISIBLE-OK");
  });

  it("scripts the GPT-5.6 Luna thinking visibility switch prompts", async () => {
    const server = await startMockServer();

    const offPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [makeUserInput(QA_THINKING_VISIBILITY_OFF_PROMPT)],
    });
    expect(outputItem(offPayload).type).toBe("message");
    expect(outputText(offPayload)).toBe("THINKING-OFF-OK");

    const maxPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [makeUserInput(QA_THINKING_VISIBILITY_MAX_PROMPT)],
    });
    const maxReasoning = outputItem(maxPayload);
    expect(maxReasoning.type).toBe("reasoning");
    expect(maxReasoning.id).toBe("rs_mock_thinking_visibility_max");
    expect(maxReasoning.summary).toEqual([]);
    expect(outputItem(maxPayload, 1).type).toBe("message");
    expect(outputText(maxPayload, 1)).toBe("THINKING-MAX-OK");

    const maxStream = await readOpenAiPromptResponseText(server, QA_THINKING_VISIBILITY_MAX_PROMPT);
    expect(maxStream).toContain('"type":"response.output_text.delta"');
    expect(maxStream).toContain('"delta":"THINKING-MAX-OK"');
  });

  it("keeps the reasoning-only side-effect path ready for no-auto-retry QA coverage", async () => {
    const server = await startMockServer();

    const toolPlan = await readOpenAiPromptResponseText(
      server,
      QA_REASONING_ONLY_SIDE_EFFECT_PROMPT,
    );
    expect(toolPlan).toContain('"name":"write"');
    expect(toolPlan).toContain("reasoning-only-side-effect.txt");

    const sideEffectPayload = await expectOpenAiNonStreamingResponsesJson(server, {
      input: [
        makeUserInput(QA_REASONING_ONLY_SIDE_EFFECT_PROMPT),
        makeToolOutput("Successfully wrote 28 bytes to reasoning-only-side-effect.txt."),
      ],
    });
    const sideEffectOutput = outputItem(sideEffectPayload);
    expect(sideEffectOutput.type).toBe("reasoning");
    expect(sideEffectOutput.id).toBe("rs_mock_reasoning_side_effect");

    const requests = await fetchOk(`${server.baseUrl}/debug/requests`);
    expect((await requests.json()) as Array<{ allInputText?: string }>).toHaveLength(2);
  });

  it.each([
    {
      name: "recovery",
      prompt: QA_EMPTY_RESPONSE_RECOVERY_PROMPT,
      retry: QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
      expected: "EMPTY-RECOVERED-OK",
    },
  ])(
    "scripts empty-response $name after a replay-safe read",
    async ({ prompt, retry, expected }) => {
      const server = await startMockServer();
      const plan = await readOpenAiPromptResponseText(server, prompt);
      expect(plan).toContain('"name":"read"');
      const output = makeToolOutput(
        "QA mission: Understand this OpenClaw repo from source + docs before acting.",
      );
      const first = await expectOpenAiNonStreamingResponsesJson(server, {
        input: [makeUserInput(prompt), output],
      });
      expect(outputContentItem(first)).toMatchObject({ type: "output_text", text: "" });
      expect(outputText(first)).toBe("");
      const second = await expectOpenAiNonStreamingResponsesJson(server, {
        input: [makeUserInput(prompt), makeUserInput(retry), output],
      });
      expect(outputText(second)).toBe(expected);
    },
  );

  it.each([{ history: "settled exhaustion", completedScenario: "exhaustion" as const }])(
    "scripts settled continuation after a side-effecting write with $history",
    async ({ completedScenario }) => {
      const server = await startMockServer();
      const historyInput = await completeSideEffectScenario(server, completedScenario);

      const toolPlan = await expectOpenAiStreamingResponsesText(server, {
        input: [...historyInput, makeUserInput(QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT)],
      });
      expect(toolPlan).toContain('"name":"write"');

      const toolOutput = {
        type: "function_call_output" as const,
        output: "Successfully wrote 27 bytes to qa-empty-response-side-effect.txt",
      };
      const emptyPayload = await expectOpenAiNonStreamingResponsesJson(server, {
        input: [
          ...historyInput,
          makeUserInput(QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT),
          toolOutput,
        ],
      });
      expect(outputText(emptyPayload)).toBe("");

      const recoveredPayload = await expectOpenAiNonStreamingResponsesJson(server, {
        input: [
          ...historyInput,
          makeUserInput(QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT),
          makeUserInput(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION),
          toolOutput,
        ],
      });
      expect(outputText(recoveredPayload)).toBe("TELEGRAM-EMPTY-WRITE-RECOVERED-OK");

      const statefulRecoveredPayload = await expectOpenAiNonStreamingResponsesJson(server, {
        input: [
          ...historyInput,
          makeUserInput(QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT),
          makeUserInput(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION),
        ],
      });
      expect(outputText(statefulRecoveredPayload)).toBe("TELEGRAM-EMPTY-WRITE-RECOVERED-OK");

      const cronRecoveredPayload = await expectOpenAiNonStreamingResponsesJson(server, {
        input: [
          makeUserInput(
            [
              "Empty response after write recovery QA check: write once, then respond with exact marker: `CRON-EMPTY-WRITE-RECOVERED-OK`.",
              "This is an unattended scheduled run. If nothing needs doing, reply exactly HEARTBEAT_OK.",
            ].join("\n\n"),
          ),
          makeUserInput(
            `${QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION}\nRead HEARTBEAT.md if it exists.`,
          ),
          toolOutput,
        ],
      });
      expect(outputText(cronRecoveredPayload)).toBe("CRON-EMPTY-WRITE-RECOVERED-OK");

      const laterHeartbeatPayload = await expectOpenAiNonStreamingResponsesJson(server, {
        input: [
          makeUserInput(QA_EMPTY_RESPONSE_SIDE_EFFECT_RECOVERY_PROMPT),
          makeUserInput(QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION),
          toolOutput,
          makeUserInput("Read HEARTBEAT.md if it exists."),
        ],
      });
      expect(outputText(laterHeartbeatPayload)).toBe("HEARTBEAT_OK");
    },
  );

  it("reports a failed Code Mode read honestly through ordinary continuation", async () => {
    const server = await startMockServer();
    const prompt =
      "Failed tool terminal recovery QA check: read the missing file, then respond with exact marker: `QA-FAILED-TOOL-FINALIZED-OK`.";

    const toolPlan = await postStreamingResponses(server, {
      model: "gpt-5.6-luna",
      tools: CODE_MODE_TOOLS,
      input: [makeUserInput(prompt)],
    });
    const plannedResponse = await toolPlan.text();
    expect(plannedResponse).toContain('"name":"exec"');
    expect(plannedResponse).toContain("qa-failed-terminal-missing-file.txt");
    const plannedRequest = requireRecord(
      await (await fetch(`${server.baseUrl}/debug/last-request`)).json(),
      "failed terminal tool plan",
    );
    expect(plannedRequest.plannedToolName).toBe("read");
    expect(plannedRequest.plannedWireToolName).toBe("exec");

    const failedToolOutput = makeToolOutputWithCallId(
      String(plannedRequest.plannedToolCallId),
      JSON.stringify({ status: "failed", error: "ENOENT: qa-failed-terminal-missing-file.txt" }),
    );
    const recovered = await expectNonStreamingResponsesJson(server, {
      model: "gpt-5.6-luna",
      tools: CODE_MODE_TOOLS,
      input: [makeUserInput(prompt), failedToolOutput],
    });
    expect(outputText(recovered)).toBe(
      "The requested file could not be read: ENOENT. QA-FAILED-TOOL-FINALIZED-OK",
    );

    const succeeded = await expectNonStreamingResponsesJson(server, {
      model: "gpt-5.6-luna",
      tools: CODE_MODE_TOOLS,
      input: [
        makeUserInput(prompt),
        makeToolOutputWithCallId(String(plannedRequest.plannedToolCallId), "file contents"),
      ],
    });
    expect(outputText(succeeded)).toBe("BUG-TOOL-DID-NOT-FAIL");
  });
});

describe("qa mock openai server provider variant tagging", () => {
  it("pins provider-specific plans for parity scenarios", async () => {
    const sourcePrompt =
      "Read the seeded docs and source plan, then report grouped into Worked, Failed, Blocked, and Follow-up.";
    const handoffPrompt =
      "Delegate one bounded QA task to a subagent. Wait for the subagent to finish.";
    const fanoutPrompt = QA_FANOUT_PROMPT;

    for (const { model, prompt, tools, expected, exact } of [
      {
        model: "openai/gpt-5.6-luna",
        prompt: sourcePrompt,
        expected: { path: "repo/qa/scenarios/index.yaml" },
        exact: true,
      },
      {
        model: "anthropic/claude-opus-4-8",
        prompt: sourcePrompt,
        expected: { path: "repo/docs/help/testing.md" },
        exact: true,
      },
      {
        model: "gpt-5.6-luna",
        prompt: handoffPrompt,
        tools: [SESSIONS_SPAWN_TOOL],
        expected: {
          label: "qa-sidecar",
          task: "Inspect the QA workspace and return one concise protocol note.",
        },
      },
      {
        model: "claude-opus-4-8",
        prompt: handoffPrompt,
        tools: [SESSIONS_SPAWN_TOOL],
        expected: {
          label: "qa-sidecar",
          task: "Inspect the QA docs fixture and return one concise protocol note.",
        },
      },
      {
        model: "openai/gpt-5.6-luna",
        prompt: fanoutPrompt,
        tools: [SESSIONS_SPAWN_TOOL],
        expected: {
          label: "qa-fanout-alpha",
          task: "Fanout worker alpha: inspect the QA workspace and finish with exactly ALPHA-OK.",
        },
      },
      {
        model: "anthropic/claude-opus-4-8",
        prompt: fanoutPrompt,
        tools: [SESSIONS_SPAWN_TOOL],
        expected: {
          label: "qa-fanout-alpha",
          task: "Fanout worker alpha: inspect the QA docs fixture and finish with exactly ALPHA-OK.",
        },
      },
    ]) {
      const response = await expectNonStreamingResponsesJson(await startMockServer(), {
        model,
        ...(tools ? { tools } : {}),
        input: [makeUserInput(prompt)],
      });
      if (exact) {
        expect(outputToolArgs(response)).toEqual(expected);
      } else {
        expect(outputToolArgs(response)).toMatchObject(expected);
      }
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

describe("a2a", () => {
  function expectTextOnly(response: unknown, text: string) {
    expect(outputText(response)).toBe(text);
    expect(outputItems(response).some((item) => item.type === "function_call")).toBe(false);
  }

  describe("mock OpenAI A2A scenarios", () => {
    it.each([
      {
        sessionKey: "agent:orion:main",
        marker: "QA-A2A-DENIED-OK",
        receipt: {
          status: "forbidden",
          error:
            "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
        },
      },
    ])(
      "keeps $receipt.status sends empty through finalization",
      async ({ sessionKey, marker, receipt }) => {
        const server = await startMockServer();
        const kickoff = makeUserInput(
          `qa a2a message-tool mirror check. sessionKey="${sessionKey}". exact marker: \`${marker}\``,
        );
        const tools = [{ type: "function", name: "sessions_send" }];
        const plan = await expectOpenAiNonStreamingResponsesJson(server, {
          tools,
          input: [kickoff],
        });
        const call = outputToolCall(plan, "sessions_send");
        expect(outputItem(plan)).toMatchObject({ type: "function_call", name: "sessions_send" });
        const args = outputToolArgs(plan);
        expect(args).toMatchObject({ sessionKey, timeoutSeconds: 0 });
        expect(String(args.message)).toContain("qa group visible reply tool check");
        expect(String(args.message)).toContain(marker);
        expect(await getJson(server, "/debug/last-request")).toMatchObject({
          plannedToolName: "sessions_send",
          plannedToolArgs: { sessionKey, timeoutSeconds: 0 },
        });
        const input: unknown[] = [
          kickoff,
          call,
          makeToolOutputWithCallId(outputToolCallId(call, "call_a2a"), JSON.stringify(receipt)),
        ];
        const response = await expectOpenAiNonStreamingResponsesJson(server, { tools, input });
        expectTextOnly(response, "");
        expectTextOnly(
          await expectOpenAiNonStreamingResponsesJson(server, {
            tools: [],
            input: [
              ...input,
              ...outputItems(response),
              makeUserInput(
                `${QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION} If a tool failed, say so; never claim completion or success.`,
              ),
            ],
          }),
          "",
        );

        const target = await expectOpenAiNonStreamingResponsesJson(server, {
          tools: [...tools, { type: "function", name: "message" }],
          input: [
            kickoff,
            makeUserInput(
              `qa group visible reply tool check. Use the visible room reply path. exact marker: \`${marker}\``,
            ),
          ],
        });
        expect(outputItem(target)).toMatchObject({ type: "function_call", name: "message" });
        expect(outputToolArgs(target)).toMatchObject({ action: "send", message: marker });
      },
    );
  });
});

describe("anthropic-failure", () => {
  it.each([
    { prompt: "Telegram unsent failure QA check.", stream: true, partialText: "" },
    {
      prompt: "Telegram visible partial failure QA check.",
      stream: true,
      partialText: "TELEGRAM-VISIBLE-PARTIAL-BEFORE-FAILURE",
    },
  ])(
    "preserves Anthropic failure for $prompt (stream=$stream)",
    async ({ prompt, stream, partialText }) => {
      const response = await postJson(await startMockServer(), "/v1/messages", {
        model: "qa-model",
        max_tokens: 256,
        stream,
        messages: [{ role: "user", content: prompt }],
      });
      const body = await response.text();
      const expectedError = { type: "api_error", message: expect.any(String) };
      if (stream) {
        expect(response.status).toBe(200);
        const events = body
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)));
        expect(events.at(-1)).toMatchObject({ type: "error", error: expectedError });
        expect(body).not.toContain("event: message_stop");
        expect(body).not.toContain('"stop_reason":"end_turn"');
        expect(
          events
            .filter((event) => event.type === "content_block_delta")
            .map((event) => event.delta.text)
            .join(""),
        ).toBe(partialText);
      } else {
        expect(response.status).toBe(500);
        expect(JSON.parse(body)).toEqual({ type: "error", error: expectedError });
      }
    },
  );
});

describe("cursor", () => {
  describe("qa mock openai server", () => {
    it("keeps cursor reads correct when retained debug requests rotate", async () => {
      const server = await startMockServer();
      const debugRequestLimit = 2_000;
      const readCursor = async () =>
        readQaMockRequestCursor(
          await fetch(`${server.baseUrl}/debug/request-cursor`).then((response) => response.json()),
        );

      const sendRequest = (index: number) =>
        expectOpenAiNonStreamingResponsesJson(server, {
          input: [makeUserInput(`cursor request ${index}`)],
        });

      expect(await readCursor()).toBe(0);
      // Keep the evicted request and its retained successor ordered.
      await sendRequest(0);
      await sendRequest(1);
      const batchSize = 32;
      for (let start = 2; start < debugRequestLimit; start += batchSize) {
        const results = await Promise.allSettled(
          Array.from({ length: Math.min(batchSize, debugRequestLimit - start) }, (_, offset) =>
            sendRequest(start + offset),
          ),
        );
        // Join the whole batch before reporting a failure or issuing overflow.
        for (const result of results) {
          if (result.status === "rejected") {
            throw result.reason;
          }
        }
      }
      const cursor = await readCursor();
      expect(cursor).toBe(debugRequestLimit);

      await expectOpenAiNonStreamingResponsesJson(server, {
        input: [makeUserInput("cursor request overflow")],
      });

      const retained = requireArray(
        await getJson(server, "/debug/requests"),
        "retained debug requests",
      );
      expect(retained).toHaveLength(debugRequestLimit);
      expect(retained[0]).toMatchObject({
        cursor: 2,
        allInputText: expect.stringContaining("cursor request 1"),
      });
      expect(retained.at(-1)).toMatchObject({
        cursor: debugRequestLimit + 1,
        allInputText: expect.stringContaining("cursor request overflow"),
      });

      const nextRequests = requireArray(
        await fetch(`${server.baseUrl}/debug/requests?after=${cursor}`).then((response) =>
          response.json(),
        ),
        "debug requests after cursor",
      );
      expect(nextRequests).toMatchObject([{ prompt: expect.stringContaining("overflow") }]);

      const expired = await fetch(`${server.baseUrl}/debug/requests?after=0`);
      expect(expired.status).toBe(409);
      expect(await expired.json()).toEqual({
        error: "request cursor expired",
        after: 0,
        oldestCursor: 2,
        latestCursor: debugRequestLimit + 1,
      });

      const futureCursor = debugRequestLimit + 2;
      const future = await fetch(`${server.baseUrl}/debug/requests?after=${futureCursor}`);
      expect(future.status).toBe(409);
      expect(await future.json()).toEqual({
        error: "request cursor is ahead of the latest recorded request",
        after: futureCursor,
        latestCursor: debugRequestLimit + 1,
      });

      const invalid = await fetch(`${server.baseUrl}/debug/requests?after=1.5`);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({
        error: "after must be a non-negative safe integer",
      });
    });
  });
});

describe("http", () => {
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
});

describe("memory-ranking-proof", () => {
  it("preserves memory retrieval line selection", async () => {
    const server = await startMockServer();
    for (const [range, from] of [
      [{ endLine: 7 }, 7],
      [{ endLine: 0 }, 1],
      [{ startLine: 0, endLine: 9 }, 1],
    ] as const) {
      const payload = await expectOpenAiNonStreamingResponsesJson(server, {
        tools: [{ type: "function", name: "memory_get", parameters: { type: "object" } }],
        input: [
          makeUserInput("Memory tools check: read the hidden project codename."),
          makeToolOutputWithCallId(
            "call_memory_search",
            JSON.stringify({ results: [{ path: "MEMORY.md", ...range }] }),
          ),
        ],
      });
      expect(outputToolArgsFromItem(outputToolCall(payload, "memory_get"))).toEqual({
        path: "MEMORY.md",
        from,
        lines: 4,
      });
    }
  });
});

describe("responses-input", () => {
  describe("mock Responses input text", () => {
    it.each([
      {
        name: "fences completed tools with an empty user message after continuation",
        laterInput: [
          { role: "user", content: "Continue." },
          { role: "user", content: [] },
        ],
        requestKind: "agent-initial",
      },
    ])("$name", async ({ laterInput, requestKind }) => {
      const server = await startMockServer();
      await expectOpenAiNonStreamingResponsesJson(server, {
        model: "qa-model",
        input: [
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
      });
      const snapshot = await getJson(server, "/debug/last-request");
      expect(snapshot).toMatchObject({ requestKind });
      if (requestKind === "agent-initial") {
        expect(snapshot).not.toHaveProperty("plannedToolName");
      }
    });
  });
});

describe("whatsapp-batched-reply", () => {
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
      const response = await expectNonStreamingResponsesJson(server, {
        input: input.map(makeUserInput),
      });
      expect(outputText(response), input.join(" | ")).toBe(expected);
    }
  });
});
