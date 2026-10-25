import {
  BedrockRuntimeClient,
  StopReason as BedrockStopReason,
} from "@aws-sdk/client-bedrock-runtime";
import { onLlmRequestActivity } from "openclaw/plugin-sdk/provider-stream-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bedrockModel,
  capturePayload as captureCommandInput,
  collectStream,
  expectDestroyedClient,
  mockResponse,
  mockStream,
  png,
  replayAssistant,
  startEvent as startMessage,
  stopEvent as stopMessage,
  streamBedrockForTest,
  toolStart,
  toolDelta,
  textDelta,
  userContext,
  toolResult,
  wireUser,
} from "./bedrock.test-support.js";
import { streamSimpleBedrock } from "./stream.runtime.js";
const adaptiveFields = (effort: string) => ({
  thinking: { type: "adaptive", display: "summarized" },
  output_config: { effort },
});

function findToolUse(input: Awaited<ReturnType<typeof captureCommandInput>>) {
  return input.messages?.flatMap((message) => message.content ?? []).find((block) => block.toolUse)
    ?.toolUse;
}

const claudeModel = (id: string, overrides: Parameters<typeof bedrockModel>[0] = {}) =>
  bedrockModel({ id, name: id, contextWindow: 1_000_000, maxTokens: 128_000, ...overrides });
const opaqueProfile =
  "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/profile-abc";
const lookup = {
  name: "lookup",
  description: "Lookup",
  parameters: { type: "object", properties: {} },
};

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
  mockStream([
    startMessage,
    { contentBlockDelta: { contentBlockIndex: 0, delta: scenario.delta } },
    stopMessage,
  ]);
  const { eventTypes: observed, result: output } = await collectStream(
    streamSimpleBedrock(bedrockModel({}), userContext("Continue")),
  );

  expect(observed.at(-2)).toBe(scenario.endEvent);
  expect(observed.at(-1)).toBe("done");
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
  let input: Awaited<ReturnType<typeof captureCommandInput>>;
  try {
    Reflect.deleteProperty(globalThis, "Buffer");
    input = await captureCommandInput(model(), userImage(png));
  } finally {
    Reflect.set(globalThis, "Buffer", nodeBuffer);
  }
  expect(input.messages?.[0]?.content?.[0]?.image?.source?.bytes?.byteLength).toBeGreaterThan(0);
});

describe("Bedrock tool-result replay", () => {
  it("drops model-bound opaque reasoning when switching between Claude models", async () => {
    const input = await captureCommandInput(
      bedrockModel({
        id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
        name: "Claude Sonnet 4.5",
      }),
      {
        messages: [
          replayAssistant("anthropic.claude-haiku-4-5-20251001-v1:0", [
            {
              type: "thinking",
              thinking: "[Reasoning redacted]",
              thinkingSignature: "3q2+7w==",
              redacted: true,
            },
            { type: "text", text: "Safe visible response" },
          ]),
        ],
      } as never,
    );

    expect(input.messages).toMatchObject([{ content: [{ text: "Safe visible response" }] }]);
  });

  it("coalesces tool results while replacing audio and dropping empty image husks", async () => {
    const input = await captureCommandInput(bedrockModel({ input: ["text", "image"] }), {
      messages: [
        toolResult(
          "call_audio",
          [{ type: "audio", mimeType: "audio/wav", data: "YXVkaW8=" }],
          "listen",
        ),
        toolResult("call_husk", [{ type: "image", mimeType: "image/png", data: "" }], "screenshot"),
        toolResult("call_text", [{ type: "text", text: "actual tool output" }], "read"),
      ],
    } as never);
    const messages = input.messages;

    expect(messages).toHaveLength(1);
    expect(messages?.[0]).toMatchObject(
      wireUser(
        { toolResult: { toolUseId: "call_audio", content: [{ text: "(see attached audio)" }] } },
        { toolResult: { toolUseId: "call_husk", content: [{ text: "(no output)" }] } },
        { toolResult: { toolUseId: "call_text", content: [{ text: "actual tool output" }] } },
      ),
    );
    expect(JSON.stringify(messages)).not.toContain('"image"');
    expect(JSON.stringify(messages)).not.toContain("see attached image");
  });
});

it("normalizes invalid stored arguments at the Bedrock request boundary", async () => {
  const context = {
    messages: [
      {
        ...replayAssistant("amazon.nova-micro-v1:0", [
          { type: "toolCall", id: "call_replay", name: "read", arguments: '{"path":' },
        ]),
        timestamp: 0,
      },
      toolResult("call_replay", [{ type: "text", text: "existing result" }], "read", false, 1),
      { role: "user", content: "continue", timestamp: 2 },
    ],
  } as never;
  const originalContext = JSON.stringify(context);
  const input = await captureCommandInput(bedrockModel({}), context);
  expect(findToolUse(input)?.input).toEqual({});
  expect(JSON.stringify(context)).toBe(originalContext);
});

describe("Bedrock profile endpoint resolution", () => {
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
});

describe("Bedrock stop reasons", () => {
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
      mockStream([startMessage, { messageStop: { stopReason: reason } }]);
      const { eventTypes, result } = await collectStream(
        streamSimpleBedrock(bedrockModel({}), userContext()),
      );

      expect(result.stopReason).toBe(stopReason);
      expect(result.errorMessage).toBe(errorMessage);
      expect(eventTypes.at(-1)).toBe(stopReason === "error" ? "error" : "done");
    },
  );

  it.each([true, false])("rejects invalid tool arguments with sealed=%s", async (sealed) => {
    mockStream([
      startMessage,
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
    const { eventTypes, result } = await collectStream(
      streamBedrockForTest(bedrockModel({}), userContext("read")),
    );

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
    mockStream([
      startMessage,
      textDelta("truncated response"),
      { contentBlockStop: { contentBlockIndex: 0 } },
    ]);
    const { eventTypes, result } = await collectStream(
      streamBedrockForTest(bedrockModel({}), userContext()),
    );
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
      const input = await captureCommandInput(model, context, options);
      expect(input.modelId).toBe(model.id);
      expect(input.inferenceConfig).toEqual(maxTokens === undefined ? {} : { maxTokens });
      expect(input.additionalModelRequestFields).toEqual(
        effort ? adaptiveFields(effort) : undefined,
      );
    },
  );
});

describe("Bedrock Fable contract", () => {
  const fableModel = () =>
    claudeModel("production-fable", {
      name: "Production deployment",
      reasoning: false,
      params: { canonicalModelId: "claude-fable-5" },
    });

  const context = () =>
    ({
      ...userContext("Reply briefly."),
      tools: [lookup],
    }) as never;

  it("sends always-adaptive high effort without unsupported request controls", async () => {
    const input = await captureCommandInput(fableModel(), context(), {
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
      yield startMessage;
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

  it("reports activity while Fable events are buffered", async () => {
    const metadata = {
      metadata: {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        metrics: { latencyMs: 1 },
      },
    };
    mockStream([startMessage, textDelta("buffered output"), metadata, metadata, stopMessage]);
    const controller = new AbortController();
    let activityCount = 0;
    const unsubscribe = onLlmRequestActivity(controller.signal, () => {
      activityCount += 1;
    });

    try {
      const stream = streamSimpleBedrock(fableModel(), context(), {
        signal: controller.signal,
      });
      await stream.result();
    } finally {
      unsubscribe();
    }

    expect(activityCount).toBe(5);
  });
});
