import { crc32 } from "node:zlib";
import { BedrockRuntimeClient, CacheTTL } from "@aws-sdk/client-bedrock-runtime";
import {
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END,
} from "@openclaw/ai/internal/shared";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { AssistantMessage, AssistantMessageEvent, Context } from "openclaw/plugin-sdk/llm";
import { withProviderAcceptanceObserver } from "openclaw/plugin-sdk/provider-transport-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BedrockOptions } from "./bedrock-options.js";
import {
  bedrockModel,
  checkpoint,
  capturePayload,
  collectStream,
  expectDestroyedClient,
  mockResponse,
  png,
  replayAssistant,
  runtimeUser,
  mockStream,
  startEvent,
  stopEvent,
  streamEvents,
  streamBedrockForTest,
  userContext,
  textBlock,
  toolResult,
  wireText,
  wireUser,
  toolStart as startToolEvent,
  toolDelta as toolDeltaEvent,
} from "./bedrock.test-support.js";
import { streamSimpleBedrock } from "./stream.runtime.js";

function signedThinkingContext(
  modelId: string,
  thinking = `private${String.fromCharCode(0xd83d)}reasoning`,
  thinkingSignature = "sig-1",
) {
  return {
    messages: [replayAssistant(modelId, [{ type: "thinking", thinking, thinkingSignature }])],
  } as never;
}

const cacheContext = () => ({
  ...userContext(),
  systemPrompt: `Stable workspace${SYSTEM_PROMPT_CACHE_BOUNDARY}Today: Monday`,
});
const retainedContext = (turn: string, count: string, timestamp: number, extras: string[] = []) =>
  runtimeUser(
    [`OpenClaw runtime context:\n${turn} request`, `Retained context ${count}`, ...extras].map(
      textBlock,
    ),
    timestamp,
  );
function wireToolResult(toolUseId: string, content: unknown[], status = "success") {
  return { toolResult: { toolUseId, status, content } };
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
    const opaqueReasoning = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    const model = bedrockModel({ id: "anthropic.claude-haiku-4-5-20251001-v1:0" });
    const encodeOpaqueReasoning = vi.spyOn(globalThis, "btoa");
    const send = mockStream([
      startEvent,
      ...[opaqueReasoning.slice(0, 2), opaqueReasoning.slice(2)].map((redactedContent) => ({
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { redactedContent } },
        },
      })),
      { contentBlockStop: { contentBlockIndex: 0 } },
      stopEvent,
    ]);

    const result = await streamBedrockForTest(model, userContext("Think privately")).result();

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
      stream: streamEvents([startEvent, stopEvent]),
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

  const nova = "amazon.nova-micro-v1:0";
  const fable = "anthropic.claude-fable-5";
  const signatureOnly = {
    reasoningContent: { reasoningText: { text: "", signature: " sig-fable " } },
  };
  it.each<[string, string | undefined, string | undefined, unknown[] | undefined]>([
    [nova, undefined, undefined, [{ text: "privatereasoning" }]],
    [fable, "", " sig-fable ", [signatureOnly]],
    [fable, "hidden compatibility reasoning", "reasoning_content", undefined],
  ])("replays %s reasoning (%s)", async (id, thinking, signature, expected) => {
    const messages = await captureMessages(
      bedrockModel({ id }),
      signedThinkingContext(id, thinking, signature),
    );
    expect(messages[0]?.content).toEqual(expected);
    if (!expected) {
      expect(messages).toEqual([]);
    }
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
        { ...cacheContext(), tools },
        cacheRetention === undefined ? {} : { cacheRetention },
      );
      if (supported && (cacheRetention === "short" || cacheRetention === "long")) {
        expect(payload.system).toEqual([
          wireText("Stable workspace"),
          checkpoint,
          wireText("Today: Monday"),
        ]);
        expect(payload.messages?.[0]?.content).toEqual([wireText("Hello"), checkpoint]);
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

  it.each([
    ["global.anthropic.claude-opus-5", "1h"],
    ["global.anthropic.claude-sonnet-5", "1h"],
    ["opaque-deployment", undefined],
  ])("uses the supported long-retention TTL for %s", async (id, ttl) => {
    vi.stubEnv("AWS_BEDROCK_FORCE_CACHE", id === "opaque-deployment" ? "1" : undefined);
    const payload = await capturePayload(
      bedrockModel({ id, name: "Test deployment" }),
      cacheContext(),
      { cacheRetention: "long" },
    );
    const longCheckpoint = { cachePoint: { type: "default", ...(ttl ? { ttl } : {}) } };
    expect(payload.system).toEqual([
      wireText("Stable workspace"),
      longCheckpoint,
      wireText("Today: Monday"),
    ]);
    expect(payload.messages?.[0]?.content).toEqual([wireText("Hello"), longCheckpoint]);
  });

  it("advances the retained-carrier checkpoint through a tool loop", async () => {
    const model = bedrockModel({
      id: "anthropic.claude-fable-5-1-v1:0",
      name: "Test deployment",
    });
    const previousAssistant = {
      ...replayAssistant(model.id, [textBlock("First answer")]),
      stopReason: "stop",
      usage: createZeroUsageFixture(),
      timestamp: 1,
    } satisfies Context["messages"][number];
    const context: Context = {
      messages: [
        retainedContext("First", "one", 0),
        previousAssistant,
        retainedContext(
          "Second",
          "two",
          2,
          Array.from({ length: 21 }, (_, index) => `Attached document block ${index}`),
        ),
      ],
    };
    const first = await captureMessages(model, context, { cacheRetention: "short" });
    expect([first[0]?.content?.at(-1), first[2]?.content?.at(-1)]).toEqual([
      checkpoint,
      checkpoint,
    ]);
    context.messages.push(
      {
        ...previousAssistant,
        content: [
          { type: "toolCall", id: "read_1", name: "read", arguments: { path: "README.md" } },
        ],
        stopReason: "toolUse",
        timestamp: 3,
      },
      toolResult("read_1", [textBlock("Tool output")], "read", false, 4),
    );
    const second = await captureMessages(model, context, { cacheRetention: "short" });
    expect(second[3]?.content).toEqual([
      { toolUse: { toolUseId: "read_1", name: "read", input: { path: "README.md" } } },
    ]);
    expect(second[2]?.content).toEqual(first[2]?.content);
    expect(second[4]?.content?.at(-1)).toEqual(checkpoint);
    expect(second[0]?.content).toEqual(
      ["OpenClaw runtime context:\nFirst request", "Retained context one"].map(wireText),
    );
    expect(second[1]).toEqual(first[1]);
  });

  const model = () =>
    bedrockModel({ id: "anthropic.claude-haiku-4-5-20251001-v1:0", name: "Claude Haiku 4.5" });

  it("strips relocation markers from a prompt without a cache boundary", async () => {
    const payload = await capturePayload(
      model(),
      {
        systemPrompt: `${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY.trim()}Complete policy${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END.trim()}`,
        ...userContext(),
      },
      { cacheRetention: "short" },
    );

    expect(payload.system).toEqual([wireText("Complete policy"), checkpoint]);
    expect(payload.messages?.[0]?.content).toEqual([wireText("Hello"), checkpoint]);
  });

  it("never includes a v2026.9.7 runtime-context carrier in a later cached prefix", async () => {
    const messages = await captureMessages(
      model(),
      {
        messages: [
          { role: "user", content: "stable operator request", timestamp: 0 },
          {
            role: "user",
            content: "OpenClaw runtime context:\nvolatile current-turn metadata",
            timestamp: 1,
            runtimeContextCarrier: true,
          },
          toolResult("call_follow_up", [textBlock("later stable tool output")], "read", false, 2),
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
      wireToolResult("call_follow_up", [{ text: "later stable tool output" }]),
    ]);
  });
});

it.each([
  [6, 4, 17, 82],
  [undefined, 0, 12.5, 77.5],
  [0, undefined, 12.5, 77.5],
] as const)(
  "preserves reported TTL buckets and prices one-hour writes for %s/%s",
  async (oneHour, fiveMinutes, cacheWriteCost, totalCost) => {
    mockStream([
      startEvent,
      {
        metadata: {
          usage: {
            inputTokens: 20,
            outputTokens: 5,
            totalTokens: 25,
            cacheReadInputTokens: 70,
            cacheWriteInputTokens: 10,
            cacheDetails: [
              { ttl: CacheTTL.ONE_HOUR, inputTokens: oneHour },
              { ttl: CacheTTL.FIVE_MINUTES, inputTokens: fiveMinutes },
            ],
          },
        },
      },
      stopEvent,
    ]);

    const result = await streamBedrockForTest(
      bedrockModel({
        cost: { input: 1_000_000, output: 2_000_000, cacheRead: 500_000, cacheWrite: 1_250_000 },
      }),
      userContext(),
    ).result();

    expect(result.usage).toMatchObject({
      input: 20,
      output: 5,
      cacheRead: 70,
      cacheWrite: 10,
      totalTokens: 105,
      contextUsage: { state: "available", promptTokens: 100, totalTokens: 105 },
      cost: { input: 20, output: 10, cacheRead: 35, cacheWrite: cacheWriteCost, total: totalCost },
    });
    expect(result.usage.cacheWrite1h).toBe(oneHour);
    expect(result.usage.cacheWrite5m).toBe(fiveMinutes);
    expect(Object.hasOwn(result.usage, "cacheWrite1h")).toBe(oneHour !== undefined);
    expect(Object.hasOwn(result.usage, "cacheWrite5m")).toBe(fiveMinutes !== undefined);
  },
);

it("lifts tool images into user content for OpenAI while preserving result associations", async () => {
  const image = { type: "image" as const, mimeType: "image/png", data: png };
  const context = {
    messages: [
      toolResult("call_first", [textBlock("first result"), image, image]),
      toolResult("call_second", [image], "inspect", true),
      toolResult("call_text", [textBlock("plain result")], "read"),
    ],
  };
  const before = structuredClone(context);
  const input = await capturePayload(
    bedrockModel({ id: "us.openai.gpt-5.6-sol", input: ["text", "image"] }),
    context,
  );
  const expectedImage = {
    image: { format: "png", source: { bytes: new Uint8Array(Buffer.from(png, "base64")) } },
  };
  const placeholder = (toolCallId: string) => ({
    text: `(see attached images labeled "Images from tool result ${toolCallId}")`,
  });
  expect(input.messages).toEqual([
    wireUser(
      wireToolResult("call_first", [{ text: "first result" }, placeholder("call_first")]),
      wireToolResult("call_second", [placeholder("call_second")], "error"),
      wireToolResult("call_text", [{ text: "plain result" }]),
      { text: "Images from tool result call_first:" },
      expectedImage,
      expectedImage,
      { text: "Images from tool result call_second:" },
      expectedImage,
    ),
  ]);
  expect(context).toEqual(before);

  const unaffected = await capturePayload(bedrockModel({ input: ["text", "image"] }), context);
  expect(unaffected.messages).toEqual([
    wireUser(
      wireToolResult("call_first", [{ text: "first result" }, expectedImage, expectedImage]),
      wireToolResult("call_second", [expectedImage], "error"),
      wireToolResult("call_text", [{ text: "plain result" }]),
    ),
  ]);
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
  startToolEvent(index, `call-${index}`, "write_document").contentBlockStart,
];
const toolDelta = (index: number, input: string): Frame => [
  "contentBlockDelta",
  toolDeltaEvent(index, input).contentBlockDelta,
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
  const result = createDeferred<AssistantMessage>();
  await withServer(
    (request, response) => {
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
    },
    async (baseUrl) => {
      try {
        const model = bedrockModel({ name: "Bedrock preview fixture", baseUrl, reasoning: false });
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
        result.resolve(await stream.result());
        expect(requests).toBe(1);
      } finally {
        abort.abort();
        release();
        signal.removeEventListener("abort", release);
      }
    },
  );
  return result.promise;
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

describe("Bedrock stream client lifecycle", () => {
  function streamDefaultBedrock(options: Parameters<typeof streamSimpleBedrock>[2] = {}) {
    return streamSimpleBedrock(bedrockModel(), userContext(), options);
  }

  it("destroys the client after a successful stream", async () => {
    const streamBlocked = createDeferred<void>();
    const streamReleased = createDeferred<void>();
    async function* successfulStream() {
      yield startEvent;
      streamBlocked.resolve();
      await streamReleased.promise;
      yield stopEvent;
    }
    const send = mockResponse(successfulStream(), {
      httpStatusCode: 200,
      requestId: "bedrock-request-1",
    });
    const destroy = vi.spyOn(BedrockRuntimeClient.prototype, "destroy");
    const acceptanceObserver = vi.fn();
    const onResponse = vi.fn();
    const options = withProviderAcceptanceObserver({ onResponse }, acceptanceObserver);

    const resultPromise = streamDefaultBedrock(options).result();
    await streamBlocked.promise;
    expect(destroy).not.toHaveBeenCalled();

    streamReleased.resolve();
    const result = await resultPromise;

    expect(result.stopReason).toBe("stop");
    const response = { status: 200, headers: { "x-amzn-requestid": "bedrock-request-1" } };
    expect(acceptanceObserver).toHaveBeenCalledWith({ kind: "http_response", ...response });
    expect(onResponse).toHaveBeenCalledWith(
      response,
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
    const send = mockResponse(responseIterator);
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

  it("keeps failures after tool-only output out of transport-drop recovery", async () => {
    async function* failingStream() {
      yield startEvent;
      yield startToolEvent(0, "call_lookup", "lookup");
      yield toolDeltaEvent(0, '{"query":"partial"}');
      yield { contentBlockStop: { contentBlockIndex: 0 } };
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    }
    const send = mockResponse(failingStream());
    const destroy = vi.spyOn(BedrockRuntimeClient.prototype, "destroy");

    const { eventTypes, result } = await collectStream(streamDefaultBedrock());

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "socket hang up",
      errorCode: "ECONNRESET",
    });
    expect(result.content).toEqual([]);
    expect(result.diagnostics).toBeUndefined();
    expect(eventTypes).not.toContain("toolcall_end");
    expect(eventTypes.at(-1)).toBe("error");
    expectDestroyedClient(send, destroy);
  });
});
