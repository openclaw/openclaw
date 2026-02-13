# Spec: OTel GenAI Semantic Convention Alignment

**Status:** Draft
**Branch:** `otel-diagnostics-fixes`
**Scope:** Align OpenClaw diagnostics with OTel GenAI Semantic Conventions v1.38+

---

## 1. Goal

Enrich the existing `diagnostics-otel` plugin to emit spans, metrics, and events
that follow the [OTel GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
so that OpenClaw telemetry works out-of-the-box with GenAI-aware backends
(Datadog, Grafana, Orq, LangWatch, Langfuse, Arize, etc.) while keeping the existing
`openclaw.*` operational telemetry intact.

---

## 2. Key Decisions

### D1: Dual-namespace (not migration)

Emit **both** `gen_ai.*` and `openclaw.*` attributes on model-usage spans.
The `openclaw.*` namespace stays for domain-specific operational data
(channels, queues, sessions, webhooks). No existing attributes are removed.

### D2: Content capture is opt-in

Message content (`gen_ai.input.messages`, `gen_ai.output.messages`,
`gen_ai.system_instructions`) is sensitive data. The spec says
instrumentations SHOULD NOT capture it by default.

New config key: `diagnostics.otel.captureContent` (default `false`).
When `false`, content attributes are omitted entirely. When `true`,
content is recorded as span attributes on inference spans using the
standard JSON structure.

### D3: Span naming follows the spec

Current span names like `openclaw.model.usage` become
`chat {model}` (e.g. `chat openai/gpt-5.2`) per the spec pattern
`{gen_ai.operation.name} {gen_ai.request.model}`.

The old `openclaw.model.usage` span name is dropped (breaking change
for dashboards, but this is pre-stable / development-phase telemetry).

### D4: New diagnostic event types for tool calls and finish reasons

Add new fields to `DiagnosticUsageEvent` and new event types to carry
the data needed for GenAI conventions. The diagnostic event system
remains the boundary between core and the OTel plugin.

### D5: Standard metrics alongside custom ones

Add the two required GenAI metrics (`gen_ai.client.operation.duration`,
`gen_ai.client.token.usage`) alongside existing `openclaw.*` metrics.
Both continue to be emitted.

### D6: No agent-level spans yet

The `create_agent` / `invoke_agent` span types from the GenAI agent
conventions are deferred. They require deeper instrumentation of the
agent lifecycle. Model inference and tool execution spans come first.

### D7: Target `gen_ai_latest_experimental` directly

We build against the latest OTel GenAI semantic conventions
(`gen_ai_latest_experimental`). Since we have no prior version of
GenAI attributes shipped, there is no backward compatibility concern.

We will read `OTEL_SEMCONV_STABILITY_OPT_IN` for spec compliance,
but it is effectively a no-op today - all `gen_ai.*` attributes are
always emitted. When the conventions stabilize, we can gate legacy
vs. stable attributes behind this env var if needed.

---

## 3. Changes

### 3.1 Config changes

**File:** `src/config/schema.ts`

Add to `FIELD_LABELS`:

```
"diagnostics.otel.captureContent": "OTel Capture Message Content"
```

Add to `FIELD_HELP`:

```
"diagnostics.otel.captureContent":
  "Record gen_ai.input.messages and gen_ai.output.messages on inference spans (opt-in, contains sensitive data)."
```

**File:** `src/config/config.ts` (or wherever the config type lives)

Add to the `otel` config block:

```ts
captureContent?: boolean;
```

### 3.2 Diagnostic event changes

**File:** `src/infra/diagnostic-events.ts`

#### 3.2.1 Extend `DiagnosticUsageEvent`

Add new optional fields:

```ts
export type DiagnosticUsageEvent = DiagnosticBaseEvent & {
  type: "model.usage";
  // ... existing fields ...

  // New fields for GenAI alignment:
  operationName?: string; // "chat" | "text_completion" | "generate_content"
  responseId?: string; // provider completion ID (e.g. "chatcmpl-xyz")
  responseModel?: string; // actual model used (may differ from requested)
  finishReasons?: string[]; // ["stop"] | ["tool_call"] | ["length"]
  inputMessages?: GenAiMessage[]; // structured input (opt-in)
  outputMessages?: GenAiMessage[]; // structured output (opt-in)
  systemInstructions?: GenAiPart[]; // system prompt parts (opt-in)
  toolDefinitions?: GenAiToolDef[]; // available tools (opt-in)
};
```

#### 3.2.2 Add GenAI message types

```ts
export type GenAiPartText = { type: "text"; content: string };
export type GenAiPartToolCall = {
  type: "tool_call";
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
};
export type GenAiPartToolCallResponse = {
  type: "tool_call_response";
  id: string;
  response: unknown;
};
export type GenAiPartReasoning = { type: "reasoning"; content: string };
export type GenAiPartMedia = {
  type: "uri" | "blob";
  modality: "image" | "audio" | "video";
  mime_type?: string;
  uri?: string;
  content?: string; // base64 for blob
};

export type GenAiPart =
  | GenAiPartText
  | GenAiPartToolCall
  | GenAiPartToolCallResponse
  | GenAiPartReasoning
  | GenAiPartMedia;

export type GenAiMessage = {
  role: "system" | "user" | "assistant" | "tool";
  parts: GenAiPart[];
  finish_reason?: string;
};

export type GenAiToolDef = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};
```

#### 3.2.3 Add tool execution event

```ts
export type DiagnosticToolExecutionEvent = DiagnosticBaseEvent & {
  type: "tool.execution";
  toolName: string;
  toolType?: "function" | "extension" | "datastore";
  toolCallId?: string;
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  durationMs?: number;
  error?: string;
  // Opt-in content:
  arguments?: Record<string, unknown>;
  result?: unknown;
};
```

Add to `DiagnosticEventPayload` union.

### 3.3 Emit-site changes

**File:** `src/auto-reply/reply/agent-runner.ts`

At the `emitDiagnosticEvent({ type: "model.usage", ... })` call site (~line 443):

1. Add `operationName: "chat"` (always "chat" for the main reply path).
2. Add `finishReasons` extracted from the provider response.
3. Add `responseId` from the provider response if available.
4. Add `responseModel` from the provider response if available.
5. When `captureContent` is enabled AND `isDiagnosticsEnabled`:
   - Convert the session messages to `GenAiMessage[]` format.
   - Attach as `inputMessages`.
   - Convert the model response to `GenAiMessage[]` format.
   - Attach as `outputMessages`.
   - Attach `systemInstructions` if a system prompt was used.

**File:** `src/agents/tools/` (tool execution sites)

Emit `DiagnosticToolExecutionEvent` when a tool is invoked, wrapping
the execution with timing.

### 3.4 OTel plugin changes

**File:** `extensions/diagnostics-otel/src/service.ts`

#### 3.4.1 New metrics

```ts
// Required by spec
const genAiOperationDuration = meter.createHistogram("gen_ai.client.operation.duration", {
  unit: "s",
  description: "GenAI operation duration",
});

// Recommended by spec
const genAiTokenUsage = meter.createHistogram("gen_ai.client.token.usage", {
  unit: "{token}",
  description: "GenAI token usage",
});
```

#### 3.4.2 Updated `recordModelUsage`

Rename the span from `openclaw.model.usage` to the spec pattern:

```ts
const spanName = `${evt.operationName ?? "chat"} ${evt.model ?? "unknown"}`;
```

Add `gen_ai.*` attributes alongside existing `openclaw.*` attributes:

```ts
const spanAttrs: Record<string, string | number | string[]> = {
  // Existing openclaw.* attributes (keep all)
  "openclaw.channel": evt.channel ?? "unknown",
  "openclaw.provider": evt.provider ?? "unknown",
  "openclaw.model": evt.model ?? "unknown",
  "openclaw.sessionKey": evt.sessionKey ?? "",
  "openclaw.sessionId": evt.sessionId ?? "",
  "openclaw.tokens.input": usage.input ?? 0,
  "openclaw.tokens.output": usage.output ?? 0,
  "openclaw.tokens.cache_read": usage.cacheRead ?? 0,
  "openclaw.tokens.cache_write": usage.cacheWrite ?? 0,
  "openclaw.tokens.total": usage.total ?? 0,

  // New gen_ai.* attributes (spec-aligned)
  "gen_ai.operation.name": evt.operationName ?? "chat",
  "gen_ai.provider.name": mapProviderName(evt.provider),
  "gen_ai.request.model": evt.model ?? "unknown",
  "gen_ai.usage.input_tokens": usage.input ?? 0,
  "gen_ai.usage.output_tokens": usage.output ?? 0,
};

// Conditionally add optional gen_ai attributes
if (evt.responseModel) {
  spanAttrs["gen_ai.response.model"] = evt.responseModel;
}
if (evt.responseId) {
  spanAttrs["gen_ai.response.id"] = evt.responseId;
}
if (evt.finishReasons?.length) {
  spanAttrs["gen_ai.response.finish_reasons"] = evt.finishReasons;
}
if (evt.sessionKey) {
  spanAttrs["gen_ai.conversation.id"] = evt.sessionKey;
}
```

Add opt-in content attributes:

```ts
if (evt.inputMessages) {
  spanAttrs["gen_ai.input.messages"] = JSON.stringify(evt.inputMessages);
}
if (evt.outputMessages) {
  spanAttrs["gen_ai.output.messages"] = JSON.stringify(evt.outputMessages);
}
if (evt.systemInstructions) {
  spanAttrs["gen_ai.system_instructions"] = JSON.stringify(evt.systemInstructions);
}
```

Record standard metrics:

```ts
const metricAttrs = {
  "gen_ai.operation.name": evt.operationName ?? "chat",
  "gen_ai.provider.name": mapProviderName(evt.provider),
  "gen_ai.request.model": evt.model ?? "unknown",
};

if (evt.durationMs) {
  genAiOperationDuration.record(evt.durationMs / 1000, metricAttrs);
}
if (usage.input) {
  genAiTokenUsage.record(usage.input, {
    ...metricAttrs,
    "gen_ai.token.type": "input",
  });
}
if (usage.output) {
  genAiTokenUsage.record(usage.output, {
    ...metricAttrs,
    "gen_ai.token.type": "output",
  });
}
```

#### 3.4.3 New `recordToolExecution` handler

```ts
const recordToolExecution = (evt: Extract<DiagnosticEventPayload, { type: "tool.execution" }>) => {
  if (!tracesEnabled) return;

  const spanAttrs: Record<string, string | number> = {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": evt.toolName,
    "gen_ai.tool.type": evt.toolType ?? "function",
  };
  if (evt.toolCallId) {
    spanAttrs["gen_ai.tool.call.id"] = evt.toolCallId;
  }
  if (evt.channel) {
    spanAttrs["openclaw.channel"] = evt.channel;
  }

  const span = spanWithDuration(`execute_tool ${evt.toolName}`, spanAttrs, evt.durationMs);
  if (evt.error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: evt.error });
    spanAttrs["error.type"] = evt.error;
  }
  span.end();
};
```

#### 3.4.4 Provider name mapping

```ts
function mapProviderName(provider?: string): string {
  if (!provider) return "unknown";
  const p = provider.toLowerCase();
  if (p.includes("openai") || p === "orq") return "openai";
  if (p.includes("anthropic") || p.includes("claude")) return "anthropic";
  if (p.includes("google") || p.includes("gemini")) return "gcp.gemini";
  if (p.includes("bedrock")) return "aws.bedrock";
  if (p.includes("mistral")) return "mistral_ai";
  if (p.includes("deepseek")) return "deepseek";
  if (p.includes("groq")) return "groq";
  if (p.includes("cohere")) return "cohere";
  if (p.includes("perplexity")) return "perplexity";
  return provider;
}
```

### 3.5 Span kind

Set span kind to `CLIENT` for inference spans (the spec requires this):

```ts
import { SpanKind } from "@opentelemetry/api";

const span = tracer.startSpan(spanName, {
  kind: SpanKind.CLIENT,
  attributes: spanAttrs,
  ...(startTime ? { startTime } : {}),
});
```

Set span kind to `INTERNAL` for tool execution spans.

---

## 4. Output-Based Tests

All tests go in `extensions/diagnostics-otel/src/service.test.ts`.

### Test 1: GenAI span attributes on model.usage

```ts
test("model.usage emits gen_ai.* span attributes", async () => {
  const service = createDiagnosticsOtelService();
  await service.start(createTestCtx());

  emitDiagnosticEvent({
    type: "model.usage",
    channel: "webchat",
    provider: "openai",
    model: "gpt-5.2",
    operationName: "chat",
    responseId: "chatcmpl-abc123",
    responseModel: "gpt-5.2-2025-06-01",
    finishReasons: ["stop"],
    sessionKey: "agent:main:main",
    sessionId: "sess-001",
    usage: { input: 100, output: 50, cacheRead: 80, cacheWrite: 0, total: 230 },
    durationMs: 1500,
  });

  // Span was created with the spec-mandated name pattern
  const spanCall = telemetryState.tracer.startSpan.mock.calls[0];
  expect(spanCall[0]).toBe("chat gpt-5.2");

  // Span has gen_ai.* attributes
  const attrs = spanCall[1]?.attributes;
  expect(attrs["gen_ai.operation.name"]).toBe("chat");
  expect(attrs["gen_ai.provider.name"]).toBe("openai");
  expect(attrs["gen_ai.request.model"]).toBe("gpt-5.2");
  expect(attrs["gen_ai.usage.input_tokens"]).toBe(100);
  expect(attrs["gen_ai.usage.output_tokens"]).toBe(50);
  expect(attrs["gen_ai.response.id"]).toBe("chatcmpl-abc123");
  expect(attrs["gen_ai.response.model"]).toBe("gpt-5.2-2025-06-01");
  expect(attrs["gen_ai.response.finish_reasons"]).toEqual(["stop"]);
  expect(attrs["gen_ai.conversation.id"]).toBe("agent:main:main");

  // Existing openclaw.* attributes are preserved
  expect(attrs["openclaw.channel"]).toBe("webchat");
  expect(attrs["openclaw.provider"]).toBe("openai");
  expect(attrs["openclaw.model"]).toBe("gpt-5.2");
  expect(attrs["openclaw.tokens.input"]).toBe(100);
  expect(attrs["openclaw.tokens.output"]).toBe(50);
  expect(attrs["openclaw.tokens.cache_read"]).toBe(80);

  await service.stop?.();
});
```

### Test 2: gen_ai.client.operation.duration metric

```ts
test("model.usage records gen_ai.client.operation.duration in seconds", async () => {
  const service = createDiagnosticsOtelService();
  await service.start(createTestCtx());

  emitDiagnosticEvent({
    type: "model.usage",
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    usage: { input: 200, output: 100, total: 300 },
    durationMs: 3200,
  });

  const histogram = telemetryState.histograms.get("gen_ai.client.operation.duration");
  expect(histogram?.record).toHaveBeenCalledWith(
    3.2, // seconds, not ms
    expect.objectContaining({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-sonnet-4-5-20250929",
    }),
  );

  await service.stop?.();
});
```

### Test 3: gen_ai.client.token.usage metric split by type

```ts
test("model.usage records gen_ai.client.token.usage histogram split by input/output", async () => {
  const service = createDiagnosticsOtelService();
  await service.start(createTestCtx());

  emitDiagnosticEvent({
    type: "model.usage",
    provider: "openai",
    model: "gpt-5.2",
    usage: { input: 500, output: 120, total: 620 },
  });

  const histogram = telemetryState.histograms.get("gen_ai.client.token.usage");
  expect(histogram?.record).toHaveBeenCalledWith(
    500,
    expect.objectContaining({ "gen_ai.token.type": "input" }),
  );
  expect(histogram?.record).toHaveBeenCalledWith(
    120,
    expect.objectContaining({ "gen_ai.token.type": "output" }),
  );

  await service.stop?.();
});
```

### Test 4: Provider name mapping

```ts
test("maps provider names to gen_ai.provider.name enum values", async () => {
  const service = createDiagnosticsOtelService();
  await service.start(createTestCtx());

  const cases = [
    { input: "orq", expected: "openai" },
    { input: "anthropic", expected: "anthropic" },
    { input: "google-gemini", expected: "gcp.gemini" },
    { input: "aws-bedrock", expected: "aws.bedrock" },
    { input: "mistral", expected: "mistral_ai" },
    { input: "some-custom-provider", expected: "some-custom-provider" },
  ];

  for (const { input, expected } of cases) {
    telemetryState.tracer.startSpan.mockClear();
    emitDiagnosticEvent({
      type: "model.usage",
      provider: input,
      model: "test-model",
      usage: { input: 10, output: 5, total: 15 },
    });
    const attrs = telemetryState.tracer.startSpan.mock.calls[0]?.[1]?.attributes;
    expect(attrs?.["gen_ai.provider.name"]).toBe(expected);
  }

  await service.stop?.();
});
```

### Test 5: Opt-in content capture

```ts
test("records gen_ai.input.messages when captureContent is enabled", async () => {
  const service = createDiagnosticsOtelService();
  await service.start(createTestCtx({ captureContent: true }));

  const inputMessages = [
    {
      role: "user" as const,
      parts: [{ type: "text" as const, content: "Hello" }],
    },
  ];
  const outputMessages = [
    {
      role: "assistant" as const,
      parts: [{ type: "text" as const, content: "Hi there!" }],
      finish_reason: "stop",
    },
  ];

  emitDiagnosticEvent({
    type: "model.usage",
    provider: "openai",
    model: "gpt-5.2",
    usage: { input: 10, output: 5, total: 15 },
    inputMessages,
    outputMessages,
  });

  const attrs = telemetryState.tracer.startSpan.mock.calls[0]?.[1]?.attributes;
  expect(attrs["gen_ai.input.messages"]).toBe(JSON.stringify(inputMessages));
  expect(attrs["gen_ai.output.messages"]).toBe(JSON.stringify(outputMessages));

  await service.stop?.();
});
```

### Test 6: Content NOT captured when captureContent is false/default

```ts
test("does NOT record gen_ai.input.messages when captureContent is disabled", async () => {
  const service = createDiagnosticsOtelService();
  await service.start(createTestCtx()); // captureContent defaults to false

  emitDiagnosticEvent({
    type: "model.usage",
    provider: "openai",
    model: "gpt-5.2",
    usage: { input: 10, output: 5, total: 15 },
    inputMessages: [{ role: "user", parts: [{ type: "text", content: "secret" }] }],
  });

  const attrs = telemetryState.tracer.startSpan.mock.calls[0]?.[1]?.attributes;
  expect(attrs["gen_ai.input.messages"]).toBeUndefined();
  expect(attrs["gen_ai.output.messages"]).toBeUndefined();

  await service.stop?.();
});
```

### Test 7: Multimodal message parts

```ts
test("input messages with media parts use correct modality and type", async () => {
  const service = createDiagnosticsOtelService();
  await service.start(createTestCtx({ captureContent: true }));

  const inputMessages = [
    {
      role: "user" as const,
      parts: [
        { type: "text" as const, content: "What's in this image?" },
        {
          type: "uri" as const,
          modality: "image" as const,
          mime_type: "image/png",
          uri: "https://example.com/photo.png",
        },
      ],
    },
  ];

  emitDiagnosticEvent({
    type: "model.usage",
    provider: "openai",
    model: "gpt-5.2",
    usage: { input: 500, output: 50, total: 550 },
    inputMessages,
  });

  const attrs = telemetryState.tracer.startSpan.mock.calls[0]?.[1]?.attributes;
  const parsed = JSON.parse(attrs["gen_ai.input.messages"] as string);
  expect(parsed[0].parts).toHaveLength(2);
  expect(parsed[0].parts[0].type).toBe("text");
  expect(parsed[0].parts[1].type).toBe("uri");
  expect(parsed[0].parts[1].modality).toBe("image");
  expect(parsed[0].parts[1].mime_type).toBe("image/png");

  await service.stop?.();
});
```

### Test 8: Tool call in output messages

```ts
test("output messages with tool_call parts are recorded correctly", async () => {
  const service = createDiagnosticsOtelService();
  await service.start(createTestCtx({ captureContent: true }));

  const outputMessages = [
    {
      role: "assistant" as const,
      parts: [
        {
          type: "tool_call" as const,
          id: "call_abc",
          name: "get_weather",
          arguments: { location: "Paris" },
        },
      ],
      finish_reason: "tool_call",
    },
  ];

  emitDiagnosticEvent({
    type: "model.usage",
    provider: "openai",
    model: "gpt-5.2",
    finishReasons: ["tool_call"],
    usage: { input: 100, output: 20, total: 120 },
    outputMessages,
  });

  const attrs = telemetryState.tracer.startSpan.mock.calls[0]?.[1]?.attributes;
  expect(attrs["gen_ai.response.finish_reasons"]).toEqual(["tool_call"]);
  const parsed = JSON.parse(attrs["gen_ai.output.messages"] as string);
  expect(parsed[0].parts[0].type).toBe("tool_call");
  expect(parsed[0].parts[0].name).toBe("get_weather");
  expect(parsed[0].finish_reason).toBe("tool_call");

  await service.stop?.();
});
```

### Test 9: Tool execution span

```ts
test("tool.execution emits execute_tool span with gen_ai.tool.* attributes", async () => {
  const service = createDiagnosticsOtelService();
  await service.start(createTestCtx());

  emitDiagnosticEvent({
    type: "tool.execution",
    toolName: "web_search",
    toolType: "function",
    toolCallId: "call_xyz",
    channel: "webchat",
    durationMs: 850,
  });

  const spanCall = telemetryState.tracer.startSpan.mock.calls[0];
  expect(spanCall[0]).toBe("execute_tool web_search");

  const attrs = spanCall[1]?.attributes;
  expect(attrs["gen_ai.operation.name"]).toBe("execute_tool");
  expect(attrs["gen_ai.tool.name"]).toBe("web_search");
  expect(attrs["gen_ai.tool.type"]).toBe("function");
  expect(attrs["gen_ai.tool.call.id"]).toBe("call_xyz");
  expect(attrs["openclaw.channel"]).toBe("webchat");

  await service.stop?.();
});
```

### Test 10: Tool execution error sets span status

```ts
test("tool.execution with error sets ERROR span status", async () => {
  const service = createDiagnosticsOtelService();
  await service.start(createTestCtx());

  emitDiagnosticEvent({
    type: "tool.execution",
    toolName: "exec",
    toolCallId: "call_err",
    durationMs: 100,
    error: "timeout",
  });

  const span = telemetryState.tracer.startSpan.mock.results[0]?.value;
  expect(span.setStatus).toHaveBeenCalledWith(
    expect.objectContaining({ code: 2, message: "timeout" }),
  );

  await service.stop?.();
});
```

### Test 11: Span kind is CLIENT for inference, INTERNAL for tool execution

```ts
test("inference spans use SpanKind.CLIENT, tool spans use SpanKind.INTERNAL", async () => {
  const service = createDiagnosticsOtelService();
  await service.start(createTestCtx());

  emitDiagnosticEvent({
    type: "model.usage",
    provider: "openai",
    model: "gpt-5.2",
    usage: { input: 10, output: 5, total: 15 },
  });

  emitDiagnosticEvent({
    type: "tool.execution",
    toolName: "web_search",
    durationMs: 200,
  });

  const calls = telemetryState.tracer.startSpan.mock.calls;
  // SpanKind.CLIENT = 2, SpanKind.INTERNAL = 0
  expect(calls[0][1]?.kind).toBe(2); // CLIENT for inference
  expect(calls[1][1]?.kind).toBe(0); // INTERNAL for tool execution

  await service.stop?.();
});
```

### Test 12: Existing openclaw.\* metrics are still emitted

```ts
test("existing openclaw.* metrics are still emitted alongside gen_ai.*", async () => {
  const service = createDiagnosticsOtelService();
  await service.start(createTestCtx());

  emitDiagnosticEvent({
    type: "model.usage",
    provider: "openai",
    model: "gpt-5.2",
    usage: { input: 100, output: 50, total: 150 },
    durationMs: 2000,
    costUsd: 0.005,
  });

  // Existing openclaw metrics still work
  expect(telemetryState.counters.get("openclaw.tokens")?.add).toHaveBeenCalled();
  expect(telemetryState.counters.get("openclaw.cost.usd")?.add).toHaveBeenCalled();
  expect(telemetryState.histograms.get("openclaw.run.duration_ms")?.record).toHaveBeenCalled();

  // New gen_ai metrics also emitted
  expect(
    telemetryState.histograms.get("gen_ai.client.operation.duration")?.record,
  ).toHaveBeenCalled();
  expect(telemetryState.histograms.get("gen_ai.client.token.usage")?.record).toHaveBeenCalled();

  await service.stop?.();
});
```

### Test 13: finish_reason "length" indicates truncation

```ts
test("finish_reason length is recorded for truncated responses", async () => {
  const service = createDiagnosticsOtelService();
  await service.start(createTestCtx());

  emitDiagnosticEvent({
    type: "model.usage",
    provider: "openai",
    model: "gpt-5.2",
    finishReasons: ["length"],
    usage: { input: 10000, output: 4096, total: 14096 },
  });

  const attrs = telemetryState.tracer.startSpan.mock.calls[0]?.[1]?.attributes;
  expect(attrs["gen_ai.response.finish_reasons"]).toEqual(["length"]);

  await service.stop?.();
});
```

### Test helper

```ts
function createTestCtx(otelOverrides?: { captureContent?: boolean }) {
  return {
    config: {
      diagnostics: {
        enabled: true,
        otel: {
          enabled: true,
          endpoint: "http://otel-collector:4318",
          protocol: "http/protobuf",
          traces: true,
          metrics: true,
          logs: false,
          ...otelOverrides,
        },
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}
```

---

## 5. Implementation Order

1. **Types first:** Add `GenAiMessage`, `GenAiPart`, etc. types and extend
   `DiagnosticUsageEvent` in `diagnostic-events.ts`.
2. **Add `DiagnosticToolExecutionEvent`** to the event union.
3. **Config:** Add `captureContent` to the OTel config schema.
4. **OTel plugin:** Update `recordModelUsage` to emit dual-namespace
   attributes, standard metrics, and spec-compliant span names.
5. **OTel plugin:** Add `recordToolExecution` handler.
6. **Emit sites:** Enrich the `agent-runner.ts` emit call with
   `finishReasons`, `responseId`, `responseModel`, `operationName`.
7. **Emit sites:** Add content capture behind `captureContent` flag.
8. **Emit sites:** Add `tool.execution` events at tool invocation points.
9. **Tests:** Add all 13 tests.
10. **Verify:** Run `pnpm build && pnpm check && pnpm test`.

---

## 6. What's Explicitly Out of Scope

- **Agent-level spans** (`create_agent`, `invoke_agent`) - deferred to a
  follow-up PR.
- **MCP semantic conventions** - deferred.
- **Embedding spans** - not applicable (OpenClaw doesn't expose embeddings
  to the OTel pipeline today).
- **Streaming metrics** (`time_to_first_token`, `time_per_output_token`) -
  requires stream-level instrumentation, deferred.
- **Removing `openclaw.*` attributes** - explicitly not happening.
- **Cost in gen_ai namespace** - no standard exists; keep `openclaw.cost.usd`.
