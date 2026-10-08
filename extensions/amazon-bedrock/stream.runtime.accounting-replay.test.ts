import { createServer } from "node:http";
import { crc32 } from "node:zlib";
// Bedrock provider-owner regressions cover reasoning replay, prompt caches, and token accounting.
import {
  BedrockRuntimeClient,
  CacheTTL,
  ConversationRole,
  ConverseStreamCommand,
  StopReason as BedrockStopReason,
} from "@aws-sdk/client-bedrock-runtime";
import {
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END,
} from "@openclaw/ai/internal/shared";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { AssistantMessageEvent, Context, Model } from "openclaw/plugin-sdk/llm";
import { withProviderAcceptanceObserver } from "openclaw/plugin-sdk/provider-transport-runtime";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BedrockOptions } from "./bedrock-options.js";
import { streamSimpleBedrock } from "./stream.runtime.js";

function bedrockModel(overrides: Record<string, unknown>) {
  return {
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    id: "amazon.nova-micro-v1:0",
    name: "Nova Micro",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    ...overrides,
  } as never;
}

function signedThinkingContext(modelId: string) {
  const highSurrogate = String.fromCharCode(0xd83d);
  return {
    messages: [
      {
        role: "assistant",
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
        model: modelId,
        content: [
          {
            type: "thinking",
            thinking: `private${highSurrogate}reasoning`,
            thinkingSignature: "sig-1",
          },
        ],
      },
    ],
  } as never;
}

async function* streamEvents(events: unknown[]) {
  yield* events;
}

function streamBedrockForTest(
  model: Parameters<typeof streamSimpleBedrock>[0],
  context: Parameters<typeof streamSimpleBedrock>[1],
  options: BedrockOptions = {},
) {
  return streamSimpleBedrock(model, context, options as never);
}

async function capturePayload(
  model: Parameters<typeof streamSimpleBedrock>[0],
  context: Parameters<typeof streamSimpleBedrock>[1],
  options: BedrockOptions = {},
) {
  const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
    $metadata: { httpStatusCode: 200 },
    stream: streamEvents([
      { messageStart: { role: ConversationRole.ASSISTANT } },
      { messageStop: { stopReason: BedrockStopReason.END_TURN } },
    ]),
  } as never);
  await streamBedrockForTest(model, context, options).result();
  const command = send.mock.calls.at(-1)?.[0];
  if (!(command instanceof ConverseStreamCommand)) {
    throw new Error("expected ConverseStreamCommand");
  }
  return command.input;
}

async function captureMessages(
  model: Parameters<typeof streamSimpleBedrock>[0],
  context: Context,
  options: BedrockOptions = {},
) {
  return (await capturePayload(model, context, options)).messages ?? [];
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Bedrock reasoning replay", () => {
  it("preserves streamed redacted reasoning and replays its opaque bytes unchanged", async () => {
    const modelId = "anthropic.claude-haiku-4-5-20251001-v1:0";
    const opaqueReasoning = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    const model = bedrockModel({ id: modelId, name: "Claude Haiku 4.5" });
    const encodeOpaqueReasoning = vi.spyOn(globalThis, "btoa");
    const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: streamEvents([
        { messageStart: { role: ConversationRole.ASSISTANT } },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { reasoningContent: { redactedContent: opaqueReasoning.slice(0, 2) } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { reasoningContent: { redactedContent: opaqueReasoning.slice(2) } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: BedrockStopReason.END_TURN } },
      ]),
    } as never);

    const result = await streamBedrockForTest(model, {
      messages: [{ role: "user", content: "Think privately", timestamp: 0 }],
    } as never).result();

    expect(result.content).toEqual([
      {
        type: "thinking",
        thinking: "[Reasoning redacted]",
        thinkingSignature: "3q2+7w==",
        redacted: true,
      },
    ]);
    expect(encodeOpaqueReasoning).toHaveBeenCalledTimes(1);

    send.mockResolvedValueOnce({
      $metadata: { httpStatusCode: 200 },
      stream: streamEvents([
        { messageStart: { role: ConversationRole.ASSISTANT } },
        { messageStop: { stopReason: BedrockStopReason.END_TURN } },
      ]),
    } as never);
    await streamBedrockForTest(model, {
      messages: [result, { role: "user", content: "Continue", timestamp: 1 }],
    } as never).result();

    const replayCommand = send.mock.calls[1]?.[0] as {
      input?: { messages?: Array<{ content?: unknown[] }> };
    };
    expect(replayCommand.input?.messages?.[0]?.content).toEqual([
      { reasoningContent: { redactedContent: opaqueReasoning } },
    ]);
  });

  it("replays signed reasoning as plain text for non-Claude models", async () => {
    const modelId = "amazon.nova-micro-v1:0";
    const messages = await captureMessages(
      bedrockModel({ id: modelId, name: "Nova Micro" }),
      signedThinkingContext(modelId),
    );

    expect(messages[0]?.content).toEqual([{ text: "privatereasoning" }]);
  });

  it("preserves signature-only Fable reasoning blocks", async () => {
    const modelId = "anthropic.claude-fable-5";
    const messages = await captureMessages(bedrockModel({ id: modelId, name: "Claude Fable 5" }), {
      messages: [
        {
          role: "assistant",
          api: "bedrock-converse-stream",
          provider: "amazon-bedrock",
          model: modelId,
          content: [
            {
              type: "thinking",
              thinking: "",
              thinkingSignature: " sig-fable ",
            },
          ],
        },
      ],
    } as never);

    expect(messages[0]?.content).toEqual([
      {
        reasoningContent: {
          reasoningText: {
            text: "",
            signature: " sig-fable ",
          },
        },
      },
    ]);
  });

  it("drops synthetic reasoning placeholders from Claude replay", async () => {
    const modelId = "anthropic.claude-fable-5";
    const messages = await captureMessages(bedrockModel({ id: modelId, name: "Claude Fable 5" }), {
      messages: [
        {
          role: "assistant",
          api: "bedrock-converse-stream",
          provider: "amazon-bedrock",
          model: modelId,
          content: [
            {
              type: "thinking",
              thinking: "hidden compatibility reasoning",
              thinkingSignature: "reasoning_content",
            },
          ],
        },
      ],
    } as never);

    expect(messages).toEqual([]);
  });
});

describe("Bedrock prompt cache ownership", () => {
  it.each([
    ["global.amazon.nova-2-lite-v1:0", true],
    ["amazon.nova-sonic-v1:0", false],
  ])("emits only supported Nova checkpoints for %s", async (id, supported) => {
    vi.stubEnv("OPENCLAW_CACHE_RETENTION", supported ? "long" : undefined);
    vi.stubEnv("AWS_BEDROCK_FORCE_CACHE", supported ? "1" : undefined);
    const tools = [
      { name: "lookup", description: "Lookup", parameters: { type: "object", properties: {} } },
      {
        name: "calculate",
        description: "Calculate",
        parameters: { type: "object", properties: {} },
      },
    ];
    for (const cacheRetention of [undefined, "short", "long", "none"] as const) {
      const payload = await capturePayload(
        bedrockModel({ id, name: "Nova Pro" }),
        {
          systemPrompt: `Stable workspace${SYSTEM_PROMPT_CACHE_BOUNDARY}Today: Monday`,
          messages: [{ role: "user", content: "Hello", timestamp: 0 }],
          tools,
        },
        cacheRetention === undefined ? {} : { cacheRetention },
      );
      if (supported && (cacheRetention === "short" || cacheRetention === "long")) {
        expect(payload.system).toEqual([
          { text: "Stable workspace" },
          { cachePoint: { type: "default" } },
          { text: "Today: Monday" },
        ]);
        expect(payload.messages?.[0]?.content).toEqual([
          { text: "Hello" },
          { cachePoint: { type: "default" } },
        ]);
      } else {
        expect(JSON.stringify(payload)).not.toContain("cachePoint");
        if (supported || cacheRetention === "none") {
          expect(payload.system).toEqual([{ text: "Stable workspace\nToday: Monday" }]);
        }
      }
      expect(payload.toolConfig?.tools?.map((tool) => tool.toolSpec?.name)).toEqual([
        "calculate",
        "lookup",
      ]);
      expect(tools.map((tool) => tool.name)).toEqual(["lookup", "calculate"]);
      expect(JSON.stringify(payload.toolConfig)).not.toContain("cachePoint");
    }
  });

  it.each(["direct"])(
    "advances the retained-carrier checkpoint through a tool loop (%s)",
    async (route) => {
      const canonicalModelId = "claude-fable-5-1";
      const model: Model<"bedrock-converse-stream"> = bedrockModel({
        id:
          route === "direct"
            ? `anthropic.${canonicalModelId}-v1:0`
            : "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/cache-test",
        name: "Test deployment",
        ...(route === "application-profile" ? { params: { canonicalModelId } } : {}),
      });
      const context: Context = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "OpenClaw runtime context:\nFirst request" },
              { type: "text", text: "Retained context one" },
            ],
            timestamp: 0,
            runtimeContext: {},
          },
          {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: [{ type: "text", text: "First answer" }],
            stopReason: "stop",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: 1,
          },
          {
            role: "user",
            content: [
              { type: "text", text: "OpenClaw runtime context:\nSecond request" },
              { type: "text", text: "Retained context two" },
            ],
            timestamp: 2,
            runtimeContext: {},
          },
        ],
        // Tool blocks require a toolConfig on the request; this context sends one.
        tools: [
          {
            name: "read",
            description: "Read a file",
            parameters: { type: "object", properties: {} },
          },
        ],
      };
      const first = await captureMessages(model, context, { cacheRetention: "short" });
      expect(first[2]?.content?.at(-1)).toEqual({ cachePoint: { type: "default" } });
      const previousAssistant = context.messages[1];
      if (previousAssistant?.role !== "assistant") {
        throw new Error("missing assistant fixture");
      }
      context.messages.push(
        {
          ...previousAssistant,
          content: [
            { type: "toolCall", id: "read_1", name: "read", arguments: { path: "README.md" } },
          ],
          stopReason: "toolUse",
          timestamp: 3,
        },
        {
          role: "toolResult",
          toolCallId: "read_1",
          toolName: "read",
          content: [{ type: "text", text: "Tool output" }],
          isError: false,
          timestamp: 4,
        },
      );
      const second = await captureMessages(model, context, { cacheRetention: "short" });
      expect(second[3]?.content).toEqual([
        { toolUse: { toolUseId: "read_1", name: "read", input: { path: "README.md" } } },
      ]);
      expect(second[2]?.content).toEqual([
        { text: "OpenClaw runtime context:\nSecond request" },
        { text: "Retained context two" },
      ]);
      expect(second[4]?.content?.at(-1)).toEqual({ cachePoint: { type: "default" } });
      expect(second.slice(0, 2)).toEqual(first.slice(0, 2));
    },
  );

  const model = () =>
    bedrockModel({ id: "anthropic.claude-haiku-4-5-20251001-v1:0", name: "Claude Haiku 4.5" });

  it("strips relocation markers from a prompt without a cache boundary", async () => {
    const payload = await capturePayload(
      model(),
      {
        systemPrompt: `${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY.trim()}Complete policy${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END.trim()}`,
        messages: [{ role: "user", content: "Hello", timestamp: 0 }],
      },
      { cacheRetention: "short" },
    );

    expect(payload.system).toEqual([
      { text: "Complete policy" },
      { cachePoint: { type: "default" } },
    ]);
    expect(payload.messages?.[0]?.content).toEqual([
      { text: "Hello" },
      { cachePoint: { type: "default" } },
    ]);
  });

  it.each([{ label: "v2026.9.7", facts: { runtimeContextCarrier: true } }])(
    "never includes a $label runtime-context carrier in a later cached prefix",
    async ({ facts }) => {
      const messages = await captureMessages(
        model(),
        {
          messages: [
            { role: "user", content: "stable operator request", timestamp: 0 },
            {
              role: "user",
              content: "OpenClaw runtime context:\nvolatile current-turn metadata",
              timestamp: 1,
              ...facts,
            },
            {
              role: "toolResult",
              toolCallId: "call_follow_up",
              toolName: "read",
              content: [{ type: "text", text: "later stable tool output" }],
              isError: false,
              timestamp: 2,
            },
          ],
          // Tool blocks require a toolConfig on the request; this context sends one.
          tools: [
            {
              name: "read",
              description: "Read a file",
              parameters: { type: "object", properties: {} },
            },
          ],
        } as never,
        { cacheRetention: "long" },
      );

      expect(messages[0]?.content).toEqual([
        { text: "stable operator request" },
        { cachePoint: { type: "default", ttl: "1h" } },
      ]);
      expect(messages[1]?.content).toEqual([
        { text: "OpenClaw runtime context:\nvolatile current-turn metadata" },
      ]);
      expect(messages[2]?.content).toEqual([
        {
          toolResult: {
            toolUseId: "call_follow_up",
            content: [{ text: "later stable tool output" }],
            status: "success",
          },
        },
      ]);
    },
  );
});

describe("Bedrock token usage", () => {
  it("prices one-hour cache writes from the provider's authoritative TTL breakdown", async () => {
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: streamEvents([
        { messageStart: { role: ConversationRole.ASSISTANT } },
        {
          metadata: {
            usage: {
              inputTokens: 20,
              outputTokens: 5,
              totalTokens: 25,
              cacheReadInputTokens: 70,
              cacheWriteInputTokens: 10,
              cacheDetails: [
                { ttl: CacheTTL.ONE_HOUR, inputTokens: 6 },
                { ttl: CacheTTL.FIVE_MINUTES, inputTokens: 4 },
              ],
            },
          },
        },
        { messageStop: { stopReason: BedrockStopReason.END_TURN } },
      ]),
    } as never);

    const result = await streamBedrockForTest(
      bedrockModel({
        cost: { input: 1_000_000, output: 2_000_000, cacheRead: 500_000, cacheWrite: 1_250_000 },
      }),
      { messages: [{ role: "user", content: "Hello", timestamp: 0 }] } as never,
    ).result();

    expect(result.usage).toMatchObject({
      input: 20,
      output: 5,
      cacheRead: 70,
      cacheWrite: 10,
      cacheWrite1h: 6,
      totalTokens: 105,
      contextUsage: { state: "available", promptTokens: 100, totalTokens: 105 },
    });
    expect(result.usage.cost).toMatchObject({
      input: 20,
      output: 10,
      cacheRead: 35,
      cacheWrite: 17,
      total: 82,
    });
  });
});

describe("Bedrock tool-result images", () => {
  it.each(["us.openai.gpt-5.6-sol"])(
    "lifts tool images into user content for %s while preserving result associations",
    async (id) => {
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const image = { type: "image", mimeType: "image/png", data: png };
      const context = {
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_first",
            toolName: "inspect",
            content: [{ type: "text", text: "first result" }, image, image],
            isError: false,
          },
          {
            role: "toolResult",
            toolCallId: "call_second",
            toolName: "inspect",
            content: [image],
            isError: true,
          },
          {
            role: "toolResult",
            toolCallId: "call_text",
            toolName: "read",
            content: [{ type: "text", text: "plain result" }],
            isError: false,
          },
        ],
        // Tool blocks require a toolConfig on the request; this context sends one.
        tools: [
          {
            name: "inspect",
            description: "Inspect",
            parameters: { type: "object", properties: {} },
          },
        ],
      };
      const before = structuredClone(context);
      const input = await capturePayload(
        bedrockModel({ id, input: ["text", "image"] }),
        context as never,
      );
      const expectedImage = {
        image: { format: "png", source: { bytes: new Uint8Array(Buffer.from(png, "base64")) } },
      };
      const placeholder = (toolCallId: string) => ({
        text: `(see attached images labeled "Images from tool result ${toolCallId}")`,
      });
      expect(input.messages).toEqual([
        {
          role: ConversationRole.USER,
          content: [
            {
              toolResult: {
                toolUseId: "call_first",
                status: "success",
                content: [{ text: "first result" }, placeholder("call_first")],
              },
            },
            {
              toolResult: {
                toolUseId: "call_second",
                status: "error",
                content: [placeholder("call_second")],
              },
            },
            {
              toolResult: {
                toolUseId: "call_text",
                status: "success",
                content: [{ text: "plain result" }],
              },
            },
            { text: "Images from tool result call_first:" },
            expectedImage,
            expectedImage,
            { text: "Images from tool result call_second:" },
            expectedImage,
          ],
        },
      ]);
      expect(context).toEqual(before);

      const unaffected = await capturePayload(
        bedrockModel({ input: ["text", "image"] }),
        context as never,
      );
      expect(unaffected.messages).toEqual([
        {
          role: ConversationRole.USER,
          content: [
            {
              toolResult: {
                toolUseId: "call_first",
                status: "success",
                content: [{ text: "first result" }, expectedImage, expectedImage],
              },
            },
            { toolResult: { toolUseId: "call_second", status: "error", content: [expectedImage] } },
            {
              toolResult: {
                toolUseId: "call_text",
                status: "success",
                content: [{ text: "plain result" }],
              },
            },
          ],
        },
      ]);
    },
  );
});

function bedrockEvent(type: string, payload: unknown): Buffer {
  // Amazon event-stream frames carry string headers and CRCs over the prelude
  // and full message. Exercise the SDK decoder instead of mocking its output.
  const headers = Buffer.concat(
    Object.entries({
      ":message-type": "event",
      ":event-type": type,
      ":content-type": "application/json",
    }).map(([name, value]) => {
      const bytes = Buffer.alloc(1 + name.length + 3 + value.length);
      bytes.writeUInt8(name.length, 0);
      bytes.write(name, 1);
      bytes.writeUInt8(7, 1 + name.length);
      bytes.writeUInt16BE(value.length, 2 + name.length);
      bytes.write(value, 4 + name.length);
      return bytes;
    }),
  );
  const body = Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(16 + headers.length + body.length);
  frame.writeUInt32BE(frame.length, 0);
  frame.writeUInt32BE(headers.length, 4);
  frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
  headers.copy(frame, 12);
  body.copy(frame, 12 + headers.length);
  frame.writeUInt32BE(crc32(frame.subarray(0, -4)), frame.length - 4);
  return frame;
}

type Frame = readonly [type: string, payload: unknown];
const startMessage: Frame = ["messageStart", { role: "assistant" }];
const stopMessage: Frame = ["messageStop", { stopReason: "tool_use" }];
const startTool = (index: number): Frame => [
  "contentBlockStart",
  {
    contentBlockIndex: index,
    start: { toolUse: { toolUseId: `call-${index}`, name: "write_document" } },
  },
];
const toolDelta = (index: number, input: string): Frame => [
  "contentBlockDelta",
  {
    contentBlockIndex: index,
    delta: { toolUse: { input } },
  },
];
const stopTool = (index: number): Frame => ["contentBlockStop", { contentBlockIndex: index }];

async function readBedrockFrames(options: {
  frames: AsyncIterable<Frame>;
  signal: AbortSignal;
  observe: (event: AssistantMessageEvent) => void;
  queued?: boolean;
  release?: () => void;
}) {
  vi.stubEnv("AWS_BEDROCK_SKIP_AUTH", "1");
  vi.stubEnv("AWS_BEDROCK_FORCE_HTTP1", "1");
  const abort = new AbortController();
  const signal = AbortSignal.any([options.signal, abort.signal]);
  const release = () => options.release?.();
  signal.addEventListener("abort", release, { once: true });
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    request.resume();
    response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
    void (async () => {
      for await (const [type, payload] of options.frames) {
        response.write(bedrockEvent(type, payload));
      }
      response.end();
    })().catch((error: unknown) =>
      response.destroy(error instanceof Error ? error : new Error(String(error))),
    );
  });
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing loopback address");
    }
    const model = {
      id: "amazon.nova-micro-v1:0",
      name: "Bedrock preview fixture",
      provider: "amazon-bedrock",
      api: "bedrock-converse-stream",
      baseUrl: `http://127.0.0.1:${address.port}`,
      reasoning: false,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } satisfies Model<"bedrock-converse-stream">;
    const stream = streamSimpleBedrock(
      model,
      {
        messages: [{ role: "user", content: "Write the fixture.", timestamp: 0 }],
        tools: [
          {
            name: "write_document",
            description: "Write a synthetic document",
            parameters: Type.Object({ body: Type.String() }, { additionalProperties: true }),
          },
        ],
      },
      { signal },
    );
    if (options.queued) {
      await stream.result();
    }
    for await (const event of stream) {
      options.observe(event);
    }
    const result = await stream.result();
    expect(requests).toBe(1);
    return result;
  } finally {
    abort.abort();
    release();
    signal.removeEventListener("abort", release);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

it("bounds full-buffer preview work without losing raw deltas, progress, or terminal arguments", async ({
  signal,
}) => {
  const marker = "BEDROCK_PREVIEW_WORK:";
  const body = marker + "x".repeat(65_536);
  const expected = { body, tail: ["雪\n\\path", { ready: true }] };
  const raw = JSON.stringify(expected);
  const chunks: string[] = [];
  for (let offset = 0; offset < raw.length; offset += 256) {
    chunks.push(raw.slice(offset, offset + 256));
  }
  const acknowledgments = chunks.map(() => createDeferred<void>());
  async function* frames(): AsyncGenerator<Frame> {
    yield startMessage;
    yield startTool(0);
    for (const [index, chunk] of chunks.entries()) {
      yield toolDelta(0, chunk);
      // Observe the current preview before another delta mutates the same block.
      await acknowledgments[index]!.promise;
    }
    yield stopTool(0);
    yield stopMessage;
  }
  const probe = vi.spyOn(JSON, "parse");
  let parsedChars = 0;
  const collectWork = () => {
    for (const [text] of probe.mock.calls) {
      if (typeof text === "string" && text.startsWith(`{"body":"${marker}`)) {
        parsedChars += text.length;
      }
    }
    // The probe must not retain all historical argument prefixes itself.
    probe.mockClear();
  };
  const received: string[] = [];
  const previewLengths: number[] = [];
  const terminal: unknown[] = [];
  const result = await readBedrockFrames({
    frames: frames(),
    signal,
    release: () => acknowledgments.forEach((ack) => ack.resolve()),
    observe: (event) => {
      if (event.type === "toolcall_delta") {
        received.push(event.delta);
        const block = event.partial.content[event.contentIndex];
        previewLengths.push(
          block?.type === "toolCall" && typeof block.arguments.body === "string"
            ? block.arguments.body.length
            : 0,
        );
        collectWork();
        acknowledgments[received.length - 1]?.resolve();
      } else if (event.type === "toolcall_end") {
        terminal.push(event.toolCall.arguments);
      }
    },
  });
  collectWork();
  expect(received).toEqual(chunks);
  expect(Math.max(...previewLengths)).toBeGreaterThan(body.length / 2);
  expect(terminal).toEqual([expected]);
  expect(result.stopReason).toBe("toolUse");
  expect(parsedChars).toBeLessThan(raw.length * 4);
});

it.for([false, true])(
  "keeps interleaved calls independent with queued consumption=%s",
  async (queued, { signal }) => {
    const first = { body: "first:" + "a".repeat(1100), tail: { escaped: '"\n雪' } };
    const second = { body: "second:" + "b".repeat(550), id: "9007199254740993" };
    const firstRaw = JSON.stringify(first);
    const secondRaw = `{"body":${JSON.stringify(second.body)},"id":9007199254740993}`;
    const deltas = [
      { index: 3, input: firstRaw.slice(0, 1050) },
      { index: 8, input: secondRaw.slice(0, 530) },
      { index: 3, input: firstRaw.slice(1050) },
      { index: 8, input: secondRaw.slice(530) },
    ];
    const gates = deltas.map(() => createDeferred<void>());
    async function* frames(): AsyncGenerator<Frame> {
      yield startMessage;
      yield startTool(3);
      yield startTool(8);
      for (const [index, delta] of deltas.entries()) {
        yield toolDelta(delta.index, delta.input);
        if (!queued) {
          await gates[index]!.promise;
        }
      }
      yield stopTool(8);
      yield stopTool(3);
      yield stopMessage;
    }
    const received: Array<{ index: number; input: string }> = [];
    const observedPreviews: number[] = [];
    const terminal: Array<{ id: string; arguments: unknown }> = [];
    const result = await readBedrockFrames({
      frames: frames(),
      signal,
      queued,
      release: () => gates.forEach((gate) => gate.resolve()),
      observe: (event) => {
        if (event.type === "toolcall_delta") {
          const block = event.partial.content[event.contentIndex];
          expect(block?.type).toBe("toolCall");
          if (block?.type !== "toolCall") {
            throw new Error("Missing active tool call");
          }
          received.push({ index: Number(block.id.slice(5)), input: event.delta });
          observedPreviews.push(
            typeof block.arguments.body === "string" ? block.arguments.body.length : 0,
          );
          gates[received.length - 1]?.resolve();
        } else if (event.type === "toolcall_end") {
          expect(event.toolCall).not.toHaveProperty("partialJson");
          expect(event.toolCall).not.toHaveProperty("index");
          terminal.push({ id: event.toolCall.id, arguments: event.toolCall.arguments });
        }
      },
    });
    expect(received).toEqual(deltas);
    expect(observedPreviews[0]).toBeGreaterThan(1000);
    expect(observedPreviews[1]).toBeGreaterThan(500);
    expect(terminal).toEqual([
      { id: "call-8", arguments: second },
      { id: "call-3", arguments: first },
    ]);
    expect(result.stopReason).toBe("toolUse");
  },
);

function expectDestroyedClient(
  send: ReturnType<typeof vi.spyOn>,
  destroy: ReturnType<typeof vi.spyOn>,
) {
  expect(send).toHaveBeenCalledOnce();
  expect(destroy).toHaveBeenCalledOnce();
  expect(destroy.mock.contexts[0]).toBe(send.mock.contexts[0]);
  expect(destroy.mock.invocationCallOrder[0]).toBeGreaterThan(
    send.mock.invocationCallOrder[0] ?? 0,
  );
}

describe("Bedrock stream client lifecycle", () => {
  function streamDefaultBedrock(options: Parameters<typeof streamSimpleBedrock>[2] = {}) {
    return streamSimpleBedrock(
      bedrockModel({}),
      { messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
      options,
    );
  }

  it("destroys the client after a successful stream", async () => {
    let markStreamBlocked!: () => void;
    const streamBlocked = new Promise<void>((resolve) => {
      markStreamBlocked = resolve;
    });
    let releaseStream!: () => void;
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    async function* successfulStream() {
      yield { messageStart: { role: ConversationRole.ASSISTANT } };
      markStreamBlocked();
      await streamReleased;
      yield { messageStop: { stopReason: BedrockStopReason.END_TURN } };
    }
    const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200, requestId: "bedrock-request-1" },
      stream: successfulStream(),
    } as never);
    const destroy = vi.spyOn(BedrockRuntimeClient.prototype, "destroy");
    const acceptanceObserver = vi.fn();
    const onResponse = vi.fn();
    const options = withProviderAcceptanceObserver({ onResponse }, acceptanceObserver);

    const resultPromise = streamDefaultBedrock(options).result();
    await streamBlocked;
    expect(destroy).not.toHaveBeenCalled();

    releaseStream();
    const result = await resultPromise;

    expect(result.stopReason).toBe("stop");
    expect(acceptanceObserver).toHaveBeenCalledWith({
      kind: "http_response",
      status: 200,
      headers: { "x-amzn-requestid": "bedrock-request-1" },
    });
    expect(onResponse).toHaveBeenCalledWith(
      { status: 200, headers: { "x-amzn-requestid": "bedrock-request-1" } },
      expect.objectContaining({ provider: "amazon-bedrock" }),
    );
    expectDestroyedClient(send, destroy);
  });

  it("cancels an unread stream when provider acceptance fails", async () => {
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const responseIterator = {
      next: vi.fn(() => new Promise<IteratorResult<never>>(() => {})),
      return: close,
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: responseIterator,
    } as never);
    const destroy = vi.spyOn(BedrockRuntimeClient.prototype, "destroy");
    const hookError = new Error("acceptance observer failed");
    const options = withProviderAcceptanceObserver({}, () => {
      throw hookError;
    });

    const result = await streamDefaultBedrock(options).result();

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "acceptance observer failed",
    });
    expect(close).toHaveBeenCalledOnce();
    expectDestroyedClient(send, destroy);
  });

  it("records a transport-failure diagnostic when the request fails before any output", async () => {
    const send = vi
      .spyOn(BedrockRuntimeClient.prototype, "send")
      .mockRejectedValue(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    const destroy = vi.spyOn(BedrockRuntimeClient.prototype, "destroy");

    const result = await streamDefaultBedrock().result();

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "socket hang up",
      errorCode: "ECONNRESET",
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        type: "provider_transport_failure",
        details: { eventsEmitted: false, phase: "before_message_stream_start" },
      }),
    ]);
    expectDestroyedClient(send, destroy);
  });

  it.each([
    {
      label: "tool-only output",
      blocks: [
        {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: "call_lookup", name: "lookup" } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { toolUse: { input: '{"query":"partial"}' } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 0 } },
      ],
      content: [],
    },
  ])("keeps failures after $label out of transport-drop recovery", async ({ blocks, content }) => {
    async function* failingStream() {
      yield { messageStart: { role: ConversationRole.ASSISTANT } };
      yield* blocks;
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    }
    const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: failingStream(),
    } as never);
    const destroy = vi.spyOn(BedrockRuntimeClient.prototype, "destroy");

    const stream = streamDefaultBedrock();
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "socket hang up",
      errorCode: "ECONNRESET",
    });
    expect(result.content).toEqual(content);
    expect(result.diagnostics).toBeUndefined();
    expect(eventTypes).not.toContain("toolcall_end");
    expect(eventTypes.at(-1)).toBe("error");
    expectDestroyedClient(send, destroy);
  });
});
