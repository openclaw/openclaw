export const anthropicServerSideFallbackCases = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-fable-5", name: "Claude Fable 5" },
  { id: "claude-opus-5", name: "Claude Opus 5" },
  {
    id: "claude-opus-5-5",
    name: "Opus 5.5 with model betas",
    headers: { "Anthropic-Beta": "files-api-2025-04-14" },
    customBeta: true,
  },
  {
    id: "claude-opus-5-5",
    name: "Opus 5.5 with request betas",
    optionHeaders: { "anthropic-beta": "files-api-2025-04-14" },
    customBeta: true,
  },
];

export const anthropicTerminalFallbackRequestedModel = {
  id: "claude-fable-5",
  name: "Claude Fable 5",
  cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
};

type AnthropicTerminalFallbackCase = {
  name: string;
  model?: unknown;
  marker?: boolean;
  fallback?: boolean;
  repeat?: boolean;
  boundary?: boolean;
  unknown?: boolean;
  failure?: "incomplete" | "error";
};

export const anthropicTerminalFallbackCases: AnthropicTerminalFallbackCase[] = [
  { name: "sticky serving model", model: "claude-opus-4-8", fallback: true },
  {
    name: "repeated terminal metadata",
    model: "claude-opus-4-8",
    fallback: true,
    repeat: true,
  },
  {
    name: "existing content boundary",
    model: "claude-opus-4-8",
    fallback: true,
    boundary: true,
  },
  { name: "start-model mismatch alone", marker: false },
  { name: "missing terminal model" },
  { name: "blank terminal model", model: " " },
  { name: "non-string terminal model", model: 42 },
  { name: "unknown serving rates", model: "claude-future-9", fallback: true, unknown: true },
  { name: "incomplete stream", model: "claude-opus-4-8", failure: "incomplete" },
  { name: "stream error after metadata", model: "claude-opus-4-8", failure: "error" },
];

export function createAnthropicTerminalFallbackEvents(
  testCase: (typeof anthropicTerminalFallbackCases)[number],
): Record<string, unknown>[] {
  const usage = {
    input_tokens: 5,
    output_tokens: 9,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 4,
    cache_creation: null,
  };
  const terminal = {
    type: "message_delta",
    delta: { stop_reason: "tool_use" },
    usage: {
      ...usage,
      iterations: [
        ...(testCase.boundary
          ? [
              {
                type: "message",
                ...usage,
                model: "claude-fable-5",
                input_tokens: 1_000,
                output_tokens: 2_000,
              },
            ]
          : []),
        {
          type: testCase.marker === false ? "message" : "fallback_message",
          ...usage,
          model: testCase.model,
        },
      ],
    },
  };
  return [
    {
      type: "message_start",
      message: {
        id: "msg_terminal_fallback",
        model: "claude-opus-4-8",
        usage: { ...usage, output_tokens: 0 },
      },
    },
    ...(testCase.boundary
      ? [
          {
            type: "content_block_start",
            index: 3,
            content_block: {
              type: "fallback",
              from: { model: "claude-fable-5" },
              to: { model: "claude-opus-4-8" },
            },
          },
          { type: "content_block_stop", index: 3 },
        ]
      : []),
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "serving reasoning", signature: "sig_serving" },
    },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "answer" } },
    { type: "content_block_stop", index: 1 },
    {
      type: "content_block_start",
      index: 2,
      content_block: { type: "tool_use", id: "call_serving", name: "lookup", input: {} },
    },
    { type: "content_block_stop", index: 2 },
    terminal,
    ...(testCase.repeat ? [terminal] : []),
    ...(testCase.failure
      ? testCase.failure === "error"
        ? [{ type: "error", error: { type: "api_error", message: "synthetic stream failure" } }]
        : []
      : [{ type: "message_stop" }]),
  ];
}
