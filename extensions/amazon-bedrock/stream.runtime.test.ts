import { crc32 } from "node:zlib";
import {
  BedrockRuntimeClient,
  CacheTTL,
  StopReason as BedrockStopReason,
} from "@aws-sdk/client-bedrock-runtime";
import {
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END,
} from "@openclaw/ai/internal/shared";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { AssistantMessage, AssistantMessageEvent, Context } from "openclaw/plugin-sdk/llm";
import { onLlmRequestActivity } from "openclaw/plugin-sdk/provider-stream-shared";
import { withProviderAcceptanceObserver } from "openclaw/plugin-sdk/provider-transport-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BedrockOptions } from "./bedrock-options.js";
import {
  bedrockModel,
  capturePayload,
  checkpoint,
  collectStream,
  expectDestroyedClient,
  mockResponse,
  mockStream,
  png,
  readTool,
  replayAssistant,
  runtimeUser,
  startEvent,
  stopEvent,
  streamBedrockForTest,
  textBlock,
  textDelta,
  toolDelta,
  toolResult,
  toolStart,
  userContext,
  wireText,
  wireUser,
} from "./bedrock.test-support.js";
import { streamSimpleBedrock } from "./stream.runtime.js";
async function collectEvents(events: unknown[], model = bedrockModel(), context = userContext()) {
  mockStream(events);
  return collectStream(streamSimpleBedrock(model, context));
}
const adaptiveFields = (effort: string) => ({
  thinking: { type: "adaptive", display: "summarized" },
  output_config: { effort },
});

const claudeModel = (id: string, overrides: Parameters<typeof bedrockModel>[0] = {}) =>
  bedrockModel({ id, name: id, contextWindow: 1_000_000, maxTokens: 128_000, ...overrides });
const fableModel = () =>
  claudeModel("production-fable", {
    name: "Production deployment",
    reasoning: false,
    params: { canonicalModelId: "claude-fable-5" },
  });
const opaqueProfile =
  "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/profile-abc";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("destroys the client after an aborted Bedrock request", async () => {
  const controller = new AbortController();
  const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockImplementation(() => {
    controller.abort();
    throw new Error("synthetic abort");
  });
  const destroy = vi.spyOn(BedrockRuntimeClient.prototype, "destroy");

  const result = await streamBedrockForTest(bedrockModel({}), userContext(), {
    signal: controller.signal,
  }).result();

  expect(result).toMatchObject({ stopReason: "aborted", errorMessage: "synthetic abort" });
  expectDestroyedClient(send, destroy);
});

it.each([
  { label: "text", delta: { text: "ready" }, endEvent: "text_end" },
  {
    label: "redacted thinking",
    delta: { reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) } },
    endEvent: "thinking_end",
  },
])("finalizes the active $label block at the provider terminal boundary", async (scenario) => {
  const { eventTypes: observed, result: output } = await collectEvents([
    startEvent,
    { contentBlockDelta: { contentBlockIndex: 0, delta: scenario.delta } },
    stopEvent,
  ]);

  expect(observed.slice(-2)).toEqual([scenario.endEvent, "done"]);
  expect(output.content[0]).not.toHaveProperty("index");
  expect(output.content[0]).not.toHaveProperty("partialJson");
  if (scenario.label === "redacted thinking") {
    expect(output.content[0]).toMatchObject({ redacted: true, thinkingSignature: "AQID" });
  }
});

it("rejects malformed base64 and decodes a valid PNG without Node Buffer", async () => {
  const model = () => bedrockModel({ input: ["text", "image"] });
  const userImage = (data: string) =>
    ({
      messages: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data }] }],
    }) as never;

  const malformed = await streamBedrockForTest(model(), userImage("!!!not-base64!!!")).result();
  expect(malformed.errorMessage).toMatch(/Amazon Bedrock image content has malformed base64/);

  const nodeBuffer = globalThis.Buffer;
  let input: Awaited<ReturnType<typeof capturePayload>>;
  try {
    Reflect.deleteProperty(globalThis, "Buffer");
    input = await capturePayload(model(), userImage(png));
  } finally {
    Reflect.set(globalThis, "Buffer", nodeBuffer);
  }
  expect(input.messages?.[0]?.content?.[0]?.image?.source?.bytes?.byteLength).toBeGreaterThan(0);
});

it("resolves a GovCloud inference-profile ARN ahead of the ambient region", async () => {
  vi.stubEnv("AWS_PROFILE", "");
  vi.stubEnv("AWS_REGION", "us-east-1");
  const send = mockStream();
  await streamBedrockForTest(
    bedrockModel({
      id: "arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:application-inference-profile/profile-abc",
    }),
    userContext(),
  ).result();
  const client = send.mock.contexts[0] as BedrockRuntimeClient;
  await expect(client.config.region()).resolves.toBe("us-gov-west-1");
});

it("lets configured profiles own standard endpoint resolution", async () => {
  const send = mockStream();

  await streamBedrockForTest(
    bedrockModel({ baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com" }),
    userContext(),
    { profile: "prod-bedrock", region: "us-west-2" },
  ).result();

  const client = send.mock.contexts.at(-1) as BedrockRuntimeClient;
  expect(client.config.endpoint).toBeUndefined();
  await expect(client.config.region()).resolves.toBe("us-west-2");
});
it.each([
  [BedrockStopReason.STOP_SEQUENCE, "stop", undefined],
  [BedrockStopReason.MAX_TOKENS, "length", undefined],
  [BedrockStopReason.MODEL_CONTEXT_WINDOW_EXCEEDED, "length", undefined],
  ["unknown_provider_reason", "error", "unknown_provider_reason"],
  [undefined, "error", "An unknown error occurred"],
  [BedrockStopReason.MALFORMED_TOOL_USE, "error", BedrockStopReason.MALFORMED_TOOL_USE],
] as const)(
  "projects terminal reason %s through the public stream",
  async (reason, stopReason, errorMessage) => {
    const { eventTypes, result } = await collectEvents([
      startEvent,
      { messageStop: { stopReason: reason } },
    ]);

    expect(result.stopReason).toBe(stopReason);
    expect(result.errorMessage).toBe(errorMessage);
    expect(eventTypes.at(-1)).toBe(stopReason === "error" ? "error" : "done");
  },
);

it.each([true, false])("rejects invalid tool arguments with sealed=%s", async (sealed) => {
  const { eventTypes, result } = await collectEvents([
    startEvent,
    ...(sealed
      ? [
          toolStart(0, "call_valid"),
          toolDelta(0, '{"path":"README.md"}'),
          { contentBlockStop: { contentBlockIndex: 0 } },
        ]
      : []),
    toolStart(1, "call_invalid"),
    toolDelta(1, '{"path":"SECRET.md"'),
    ...(sealed ? [{ contentBlockStop: { contentBlockIndex: 1 } }] : []),
    { messageStop: { stopReason: BedrockStopReason.TOOL_USE } },
  ]);

  expect(result).toMatchObject({
    stopReason: "error",
    errorMessage: sealed
      ? "Provider completed tool call with malformed JSON arguments"
      : "Provider completed stream with an incomplete tool call",
  });
  expect(result.errorMessage).not.toContain("SECRET.md");
  expect(eventTypes.at(-1)).toBe("error");
  expect(eventTypes).not.toContain("toolcall_end");
  expect(eventTypes).not.toContain("done");
  expect(result.content.some((block) => block.type === "toolCall")).toBe(false);
});

it("reports truncated text streams without a terminal messageStop", async () => {
  const { eventTypes, result } = await collectEvents([
    startEvent,
    textDelta("truncated response"),
    { contentBlockStop: { contentBlockIndex: 0 } },
  ]);
  expect(eventTypes.at(-1)).toBe("error");
  expect(eventTypes).not.toContain("done");
  expect(result).toMatchObject({
    stopReason: "error",
    errorMessage: "Bedrock stream ended before messageStop",
  });
  expect(result.content).toEqual([expect.objectContaining({ type: "text" })]);
  expect(result.content[0]).not.toHaveProperty("index");
  expect(result.content[0]).not.toHaveProperty("partialJson");
});
describe("Bedrock thinking request composition", () => {
  const context = userContext("Think carefully.");
  const profile = claudeModel(opaqueProfile, { name: "US Claude Fable 5.1" });
  const opus = claudeModel("global.anthropic.claude-opus-5", {
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  });
  const sonnet = claudeModel("us.anthropic.claude-sonnet-5", {
    thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: "max" },
  });
  const legacy = claudeModel("anthropic.claude-haiku-4-5-v1:0", { maxTokens: 1024 });
  const adaptive = claudeModel("us.anthropic.claude-opus-4-8");
  const named = bedrockModel({ id: opaqueProfile, name: "Claude Production Opus 4.8" });
  const alias = (canonicalModelId: string, enabled: boolean) =>
    bedrockModel({
      id: "production-claude",
      name: "Production Claude",
      reasoning: false,
      params: { canonicalModelId },
      thinkingLevelMap: enabled ? { xhigh: "xhigh", max: "max" } : { xhigh: null, max: null },
    });
  const nativeAlias = alias("claude-opus-4-8", true);
  const clampedAlias = alias("claude-opus-4-6", false);

  it.each([
    ["profile default", profile, {}, 128_000, "medium"],
    ["Opus 5 default", opus, {}, 128_000, "high"],
    ["Sonnet 5 explicit off", sonnet, { reasoning: "off" }, 128_000, "low"],
    ["legacy budget exhausted", legacy, { reasoning: "minimal" }, 1024, undefined],
    ["explicit request cap", adaptive, { reasoning: "high", maxTokens: 32_000 }, 32_000, "high"],
    ["native cap with thinking off", adaptive, { reasoning: "off" }, 128_000, undefined],
    ["descriptive profile name", named, { reasoning: "xhigh" }, undefined, "xhigh"],
    ["native alias", nativeAlias, { reasoning: "xhigh", temperature: 0.2 }, undefined, "xhigh"],
    ["clamped alias", clampedAlias, { reasoning: "max", temperature: 0.2 }, undefined, "high"],
  ] as const)(
    "sends %s policy in the final request",
    async (_name, model, options, maxTokens, effort) => {
      const input = await capturePayload(model, context, options);
      expect(input.inferenceConfig).toEqual(maxTokens === undefined ? {} : { maxTokens });
      expect(input.additionalModelRequestFields).toEqual(
        effort ? adaptiveFields(effort) : undefined,
      );
    },
  );
});

describe("Bedrock Fable contract", () => {
  const context = () =>
    ({
      ...userContext("Reply briefly."),
      tools: [
        { name: "lookup", description: "Lookup", parameters: { type: "object", properties: {} } },
      ],
    }) as never;

  it("sends always-adaptive high effort without unsupported request controls", async () => {
    const input = await capturePayload(fableModel(), context(), {
      reasoning: "high",
      temperature: 0.2,
      toolChoice: "any",
    });
    expect(input).toMatchObject({
      modelId: "production-fable",
      inferenceConfig: {},
      messages: [
        {
          role: "user",
          content: [{ text: "Reply briefly." }, { cachePoint: { type: "default" } }],
        },
      ],
      toolConfig: { toolChoice: { auto: {} } },
      additionalModelRequestFields: adaptiveFields("high"),
      additionalModelResponseFieldPaths: ["/stop_details"],
    });
  });

  it("quarantines partial output when Mythos 5 returns a terminal refusal", async () => {
    const model = claudeModel("production-mythos", {
      name: "Production deployment",
      params: { canonicalModelId: "claude-mythos-5" },
    });
    mockStream([
      textDelta("discard this partial output"),
      {
        messageStop: {
          stopReason: "refusal",
          additionalModelResponseFields: {
            stop_details: {
              category: "cyber",
              explanation: "This request is not allowed.",
            },
          },
        },
      },
    ]);
    const { eventTypes, result } = await collectStream(streamSimpleBedrock(model, context()));

    expect(eventTypes).toEqual(["error"]);
    expect(result.content).toEqual([]);
    expect(result.errorMessage).toBe(
      "Anthropic refusal (category: cyber): This request is not allowed.",
    );
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        type: "provider_refusal",
        details: {
          provider: "amazon-bedrock",
          category: "cyber",
          explanation: "This request is not allowed.",
        },
      }),
    ]);
  });

  it.each([
    { label: "ends without messageStop", transportDrop: false },
    { label: "loses its connection", transportDrop: true },
  ])("discards partial output when the Fable stream $label", async ({ transportDrop }) => {
    async function* incompleteStream() {
      yield startEvent;
      yield textDelta("unsafe partial output");
      if (transportDrop) {
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      }
    }
    const send = mockResponse(incompleteStream());
    const destroy = vi.spyOn(BedrockRuntimeClient.prototype, "destroy");

    const { eventTypes, result } = await collectStream(
      streamSimpleBedrock(fableModel(), context()),
    );

    expect(eventTypes).toEqual(["error"]);
    expect(result.stopReason).toBe("error");
    expect(result.content).toEqual([]);
    expect(result.diagnostics).toBeUndefined();
    if (transportDrop) {
      expect(result.errorMessage).toBe("socket hang up");
      expect(result.errorCode).toBe("ECONNRESET");
    } else {
      expect(result.errorMessage).toContain("ended before messageStop");
    }
    expectDestroyedClient(send, destroy);
  });
});

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

describe("Bedrock reasoning replay", () => {
  it("preserves streamed redacted reasoning and replays its opaque bytes unchanged", async () => {
    const opaqueReasoning = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    const model = bedrockModel({ id: "anthropic.claude-haiku-4-5-20251001-v1:0" });
    const encodeOpaqueReasoning = vi.spyOn(globalThis, "btoa");
    mockStream([
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

    const replay = await captureMessages(model, {
      messages: [result, { role: "user", content: "Continue", timestamp: 1 }],
    });
    expect(replay[0]?.content).toEqual([
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
  const nova = "global.amazon.nova-2-lite-v1:0";
  const sonic = "amazon.nova-sonic-v1:0";
  const longPoint = { cachePoint: { type: "default", ttl: "1h" } };
  it.each([
    [nova, undefined, "none", true],
    [nova, "short", "short", true],
    [nova, "long", "short", true],
    [nova, "none", "none", true],
    [sonic, undefined, "split", false],
    [sonic, "none", "none", false],
    ["global.anthropic.claude-opus-5", "long", "long", false],
    ["global.anthropic.claude-sonnet-5", "long", "long", false],
    ["opaque-deployment", "long", "short", true],
  ] as const)("applies %s retention=%s checkpoints", async (id, retention, mode, force) => {
    vi.stubEnv("AWS_BEDROCK_FORCE_CACHE", force ? "1" : undefined);
    vi.stubEnv("OPENCLAW_CACHE_RETENTION", id === nova ? "long" : undefined);
    const tools = ["lookup", "calculate"].map((name) => ({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
    }));
    const payload = await capturePayload(
      bedrockModel({ id, name: "Test deployment" }),
      { ...cacheContext(), tools },
      retention === undefined ? {} : { cacheRetention: retention },
    );
    const point = mode === "long" ? longPoint : mode === "short" ? checkpoint : undefined;
    expect(payload.system).toEqual(
      mode === "none"
        ? [wireText("Stable workspace\nToday: Monday")]
        : [wireText("Stable workspace"), ...(point ? [point] : []), wireText("Today: Monday")],
    );
    expect(payload.messages?.[0]?.content).toEqual([wireText("Hello"), ...(point ? [point] : [])]);
    expect(payload.toolConfig?.tools?.map((tool) => tool.toolSpec?.name)).toEqual([
      "calculate",
      "lookup",
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(["lookup", "calculate"]);
    expect(JSON.stringify(payload.toolConfig)).not.toContain("cachePoint");
    if (!point) {
      expect(JSON.stringify(payload)).not.toContain("cachePoint");
    }
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
      tools: [readTool],
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
        tools: [readTool],
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

it.each([
  "us.openai.gpt-5.6-sol",
  "global.openai.gpt-6-sol",
  "global.openai.gpt-6.1-sol",
  "global.moonshotai.kimi-k3",
])("lifts %s tool images into user content, keeping result associations", async (id) => {
  const image = { type: "image" as const, mimeType: "image/png", data: png };
  const context = {
    messages: [
      toolResult("call_first", [textBlock("first result"), image, image]),
      toolResult("call_second", [image], "inspect", true),
      toolResult("call_text", [textBlock("plain result")], "read"),
    ],
    tools: [readTool],
  };
  const before = structuredClone(context);
  const input = await capturePayload(bedrockModel({ id, input: ["text", "image"] }), context);
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
    }).map(([name, value]) =>
      Buffer.from([
        name.length,
        ...Buffer.from(name),
        7,
        value.length >> 8,
        value.length & 255,
        ...Buffer.from(value),
      ]),
    ),
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
const wireStart: Frame = ["messageStart", { role: "assistant" }];
const wireStop: Frame = ["messageStop", { stopReason: "tool_use" }];
const wireToolStart = (index: number): Frame => [
  "contentBlockStart",
  toolStart(index, `call-${index}`, "write_document").contentBlockStart,
];
const wireToolDelta = (index: number, input: string): Frame => [
  "contentBlockDelta",
  toolDelta(index, input).contentBlockDelta,
];
const wireToolStop = (index: number): Frame => ["contentBlockStop", { contentBlockIndex: index }];

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
  const result = createDeferred<AssistantMessage>();
  await withServer(
    (request, response) => {
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
            ...userContext("Write the fixture."),
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
      } finally {
        abort.abort();
        release();
        signal.removeEventListener("abort", release);
      }
    },
  );
  return result.promise;
}

it.for([false, true])(
  "bounds preview work and keeps interleaved calls independent with queued consumption=%s",
  async (queued, { signal }) => {
    const marker = "BEDROCK_PREVIEW_WORK:";
    const first = {
      body: marker + "a".repeat(65_536),
      tail: ["雪\n\\path", { escaped: '"\n雪', ready: true }],
    };
    const second = { body: "second:" + "b".repeat(550), id: "9007199254740993" };
    const firstRaw = JSON.stringify(first);
    const secondRaw = `{"body":${JSON.stringify(second.body)},"id":9007199254740993}`;
    const deltas = [
      { index: 3, input: firstRaw.slice(0, 1050) },
      { index: 8, input: secondRaw.slice(0, 530) },
      { index: 8, input: secondRaw.slice(530) },
      ...Array.from({ length: Math.ceil((firstRaw.length - 1050) / 256) }, (_, index) => ({
        index: 3,
        input: firstRaw.slice(1050 + index * 256, 1050 + (index + 1) * 256),
      })),
    ];
    const probe = vi.spyOn(JSON, "parse");
    let parsedChars = 0;
    const collectWork = () => {
      for (const [text] of probe.mock.calls) {
        if (typeof text === "string" && text.startsWith(`{"body":"${marker}`)) {
          parsedChars += text.length;
        }
      }
      // Do not retain every historical argument prefix in the measuring spy.
      probe.mockClear();
    };
    const gates = deltas.map(() => createDeferred<void>());
    async function* frames(): AsyncGenerator<Frame> {
      yield wireStart;
      yield wireToolStart(3);
      yield wireToolStart(8);
      for (const [index, delta] of deltas.entries()) {
        yield wireToolDelta(delta.index, delta.input);
        if (!queued) {
          await gates[index]!.promise;
        }
      }
      yield wireToolStop(8);
      yield wireToolStop(3);
      yield wireStop;
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
          collectWork();
          gates[received.length - 1]?.resolve();
        } else if (event.type === "toolcall_end") {
          expect(event.toolCall).not.toHaveProperty("partialJson");
          expect(event.toolCall).not.toHaveProperty("index");
          terminal.push({ id: event.toolCall.id, arguments: event.toolCall.arguments });
        }
      },
    });
    collectWork();
    expect(received).toEqual(deltas);
    expect(observedPreviews[0]).toBeGreaterThan(1000);
    expect(observedPreviews[1]).toBeGreaterThan(500);
    expect(Math.max(...observedPreviews)).toBeGreaterThan(first.body.length / 2);
    expect(parsedChars).toBeLessThan(firstRaw.length * 4);
    expect(terminal).toEqual([
      { id: "call-8", arguments: second },
      { id: "call-3", arguments: first },
    ]);
    expect(result.stopReason).toBe("toolUse");
  },
);

describe("Bedrock stream client lifecycle", () => {
  function streamDefaultBedrock(
    options: Parameters<typeof streamSimpleBedrock>[2] = {},
    model = bedrockModel(),
  ) {
    return streamSimpleBedrock(model, userContext(), options);
  }

  it("reports buffered Fable activity and destroys its client only after success", async () => {
    const streamBlocked = createDeferred<void>();
    const streamReleased = createDeferred<void>();
    async function* successfulStream() {
      yield startEvent;
      streamBlocked.resolve();
      await streamReleased.promise;
      yield textDelta("buffered output");
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      const metadata = { metadata: { usage, metrics: { latencyMs: 1 } } };
      yield metadata;
      yield metadata;
      yield stopEvent;
    }
    const send = mockResponse(successfulStream(), {
      httpStatusCode: 200,
      requestId: "bedrock-request-1",
    });
    const destroy = vi.spyOn(BedrockRuntimeClient.prototype, "destroy");
    const acceptanceObserver = vi.fn();
    const onResponse = vi.fn();
    const controller = new AbortController();
    let activityCount = 0;
    const unsubscribe = onLlmRequestActivity(controller.signal, () => {
      activityCount += 1;
    });
    const options = withProviderAcceptanceObserver(
      { onResponse, signal: controller.signal },
      acceptanceObserver,
    );

    const resultPromise = streamDefaultBedrock(options, fableModel()).result();
    await streamBlocked.promise;
    expect(destroy).not.toHaveBeenCalled();

    streamReleased.resolve();
    const result = await resultPromise.finally(unsubscribe);

    expect(result.stopReason).toBe("stop");
    expect(activityCount).toBe(5);
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
      yield toolStart(0, "call_lookup", "lookup");
      yield toolDelta(0, '{"query":"partial"}');
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
