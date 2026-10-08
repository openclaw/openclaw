import {
  BedrockRuntimeClient,
  ConversationRole,
  StopReason as BedrockStopReason,
} from "@aws-sdk/client-bedrock-runtime";
import { onLlmRequestActivity } from "openclaw/plugin-sdk/provider-stream-shared";
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

async function* streamEvents(events: unknown[]) {
  for (const event of events) {
    yield event;
  }
}

function streamBedrockForTest(
  model: Parameters<typeof streamSimpleBedrock>[0],
  context: Parameters<typeof streamSimpleBedrock>[1],
  options: BedrockOptions = {},
) {
  return streamSimpleBedrock(model, context, options as never);
}

async function captureCommandInput(
  model: Parameters<typeof streamSimpleBedrock>[0],
  context: Parameters<typeof streamSimpleBedrock>[1],
  options: BedrockOptions = {},
  validateRequest?: (input: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const response = {
    $metadata: { httpStatusCode: 200 },
    stream: streamEvents([
      { messageStart: { role: ConversationRole.ASSISTANT } },
      { messageStop: { stopReason: BedrockStopReason.END_TURN } },
    ]),
  };
  const send = vi.spyOn(BedrockRuntimeClient.prototype, "send");
  if (validateRequest) {
    send.mockImplementation((command) => {
      const input = (command as unknown as { input?: Record<string, unknown> }).input;
      if (!input) {
        throw new Error("expected ConverseStreamCommand input");
      }
      validateRequest(input);
      return response as never;
    });
  } else {
    send.mockResolvedValue(response as never);
  }
  const result = await streamBedrockForTest(model, context, options).result();
  if (validateRequest && result.stopReason !== "stop") {
    throw new Error(
      `Bedrock request fixture rejected replay: ${result.errorMessage ?? result.stopReason}`,
    );
  }
  const command = send.mock.calls.at(-1)?.[0] as { input?: Record<string, unknown> } | undefined;
  if (!command?.input) {
    throw new Error("expected ConverseStreamCommand input");
  }
  return command.input;
}

async function captureClientRegion(
  model: Parameters<typeof streamSimpleBedrock>[0],
  options: BedrockOptions = {},
): Promise<string> {
  const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
    $metadata: { httpStatusCode: 200 },
    stream: streamEvents([
      { messageStart: { role: ConversationRole.ASSISTANT } },
      { messageStop: { stopReason: BedrockStopReason.END_TURN } },
    ]),
  } as never);

  await streamBedrockForTest(
    model,
    { messages: [{ role: "user", content: "Hello", timestamp: 0 }] } as never,
    options,
  ).result();

  const client = send.mock.contexts[0] as BedrockRuntimeClient;
  return client.config.region();
}

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

  const result = await streamBedrockForTest(
    bedrockModel({}),
    { messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
    { signal: controller.signal },
  ).result();

  expect(result).toMatchObject({ stopReason: "aborted", errorMessage: "synthetic abort" });
  expect(send).toHaveBeenCalledOnce();
  expect(destroy).toHaveBeenCalledOnce();
  expect(destroy.mock.contexts[0]).toBe(send.mock.contexts[0]);
  expect(destroy.mock.invocationCallOrder[0]).toBeGreaterThan(
    send.mock.invocationCallOrder[0] ?? 0,
  );
});

it.each([
  { label: "text", delta: { text: "ready" }, endEvent: "text_end" },
  {
    label: "redacted thinking",
    delta: { reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) } },
    endEvent: "thinking_end",
  },
])("finalizes the active $label block at the provider terminal boundary", async (scenario) => {
  vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
    $metadata: { httpStatusCode: 200 },
    stream: streamEvents([
      { messageStart: { role: ConversationRole.ASSISTANT } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: scenario.delta } },
      { messageStop: { stopReason: BedrockStopReason.END_TURN } },
    ]),
  } as never);

  const stream = streamSimpleBedrock(bedrockModel({}), {
    messages: [{ role: "user", content: "Continue", timestamp: 0 }],
  });
  const observed = [];
  for await (const event of stream) {
    observed.push(event.type);
  }
  const output = await stream.result();

  expect(observed.at(-2)).toBe(scenario.endEvent);
  expect(observed.at(-1)).toBe("done");
  expect(output.content[0]).not.toHaveProperty("index");
  expect(output.content[0]).not.toHaveProperty("partialJson");
  if (scenario.label === "redacted thinking") {
    expect(output.content[0]).toMatchObject({ redacted: true, thinkingSignature: "AQID" });
  }
});

describe("Bedrock inbound image base64", () => {
  const model = () => bedrockModel({ input: ["text", "image"] });
  const userImage = (data: string) =>
    ({
      messages: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data }] }],
    }) as never;

  it("rejects malformed base64 and decodes a valid PNG without Node Buffer", async () => {
    const malformed = await streamBedrockForTest(model(), userImage("!!!not-base64!!!")).result();
    expect(malformed.errorMessage).toMatch(/Amazon Bedrock image content has malformed base64/);

    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const nodeBuffer = globalThis.Buffer;
    let input: Record<string, unknown>;
    try {
      Reflect.deleteProperty(globalThis, "Buffer");
      input = await captureCommandInput(model(), userImage(png));
    } finally {
      Reflect.set(globalThis, "Buffer", nodeBuffer);
    }
    const messages = input.messages as Array<{ content?: unknown }>;
    const content = messages[0]?.content as Array<{
      image?: { source?: { bytes?: Uint8Array } };
    }>;
    expect(content[0]?.image?.source?.bytes?.byteLength).toBeGreaterThan(0);
  });
});

describe("Bedrock profile endpoint resolution", () => {
  it("resolves a GovCloud inference-profile ARN ahead of the ambient region", async () => {
    vi.stubEnv("AWS_PROFILE", "");
    vi.stubEnv("AWS_REGION", "us-east-1");
    await expect(
      captureClientRegion(
        bedrockModel({
          id: "arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:application-inference-profile/profile-abc",
        }),
      ),
    ).resolves.toBe("us-gov-west-1");
  });

  it("lets configured profiles own standard endpoint resolution", async () => {
    const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: streamEvents([
        { messageStart: { role: ConversationRole.ASSISTANT } },
        { messageStop: { stopReason: BedrockStopReason.END_TURN } },
      ]),
    } as never);

    await streamBedrockForTest(
      bedrockModel({ baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com" }),
      { messages: [{ role: "user", content: "Hello", timestamp: 0 }] } as never,
      { profile: "prod-bedrock", region: "us-west-2" },
    ).result();

    const client = send.mock.contexts.at(-1) as BedrockRuntimeClient;
    expect(client.config.endpoint).toBeUndefined();
    await expect(client.config.region()).resolves.toBe("us-west-2");
  });
});

describe("Bedrock stop reasons", () => {
  it("rejects malformed terminal tool JSON before completing any sibling call", async () => {
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: streamEvents([
        { messageStart: { role: ConversationRole.ASSISTANT } },
        {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: "call_valid", name: "read" } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { toolUse: { input: '{"path":"README.md"}' } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 0 } },
        {
          contentBlockStart: {
            contentBlockIndex: 1,
            start: { toolUse: { toolUseId: "call_invalid", name: "read" } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 1,
            delta: { toolUse: { input: '{"path":"SECRET.md"' } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 1 } },
        { messageStop: { stopReason: BedrockStopReason.TOOL_USE } },
      ]),
    } as never);
    const stream = streamBedrockForTest(bedrockModel({}), {
      messages: [{ role: "user", content: "read", timestamp: 0 }],
    } as never);
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Provider completed tool call with malformed JSON arguments");
    expect(result.errorMessage).not.toContain("SECRET.md");
    expect(eventTypes).not.toContain("toolcall_end");
    expect(eventTypes).not.toContain("done");
  });

  it("rejects an active tool call that never receives contentBlockStop", async () => {
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: streamEvents([
        { messageStart: { role: ConversationRole.ASSISTANT } },
        {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: "call_unsealed", name: "read" } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { toolUse: { input: '{"path":"README.md"' } },
          },
        },
        { messageStop: { stopReason: BedrockStopReason.TOOL_USE } },
      ]),
    } as never);
    const stream = streamBedrockForTest(bedrockModel({}), {
      messages: [{ role: "user", content: "read", timestamp: 0 }],
    } as never);
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(eventTypes.at(-1)).toBe("error");
    expect(eventTypes).not.toContain("toolcall_end");
    expect(eventTypes).not.toContain("done");
    expect(result.content.some((block) => block.type === "toolCall")).toBe(false);
  });

  it("uses a complete tool input seeded at block start", async () => {
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: streamEvents([
        { messageStart: { role: ConversationRole.ASSISTANT } },
        {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: {
              toolUse: {
                toolUseId: "call_seeded",
                name: "read",
                input: { path: "README.md" },
              },
            },
          },
        },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: BedrockStopReason.TOOL_USE } },
      ]),
    } as never);

    const result = await streamBedrockForTest(bedrockModel({}), {
      messages: [{ role: "user", content: "read", timestamp: 0 }],
    } as never).result();

    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "toolCall", arguments: { path: "README.md" } }),
    );
  });

  it.each([
    {
      name: "text",
      events: [
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "truncated response" } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
      ],
      contentType: "text",
      retainsPartial: true,
    },
  ])(
    "reports truncated $name streams without a terminal messageStop",
    async ({ events, contentType, retainsPartial }) => {
      vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
        $metadata: { httpStatusCode: 200 },
        stream: streamEvents([{ messageStart: { role: ConversationRole.ASSISTANT } }, ...events]),
      } as never);

      const stream = streamBedrockForTest(bedrockModel({}), {
        messages: [{ role: "user", content: "Hello", timestamp: 0 }],
      } as never);
      const eventTypes: string[] = [];
      for await (const event of stream) {
        eventTypes.push(event.type);
      }
      const result = await stream.result();

      expect(eventTypes.at(-1)).toBe("error");
      expect(eventTypes).not.toContain("done");
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toBe("Bedrock stream ended before messageStop");
      expect(result.content).toEqual(
        retainsPartial ? [expect.objectContaining({ type: contentType })] : [],
      );
      if (retainsPartial) {
        expect(result.content[0]).not.toHaveProperty("index");
        expect(result.content[0]).not.toHaveProperty("partialJson");
      }
    },
  );

  it.each([BedrockStopReason.MALFORMED_TOOL_USE])(
    "reports the provider stop reason %s",
    async (stopReason) => {
      vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
        $metadata: { httpStatusCode: 200 },
        stream: streamEvents([
          { messageStart: { role: ConversationRole.ASSISTANT } },
          { messageStop: { stopReason } },
        ]),
      } as never);

      const result = await streamBedrockForTest(bedrockModel({}), {
        messages: [{ role: "user", content: "Hello", timestamp: 0 }],
      } as never).result();

      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toBe(stopReason);
    },
  );
});

describe("Bedrock thinking request composition", () => {
  const context = {
    messages: [{ role: "user", content: "Think carefully.", timestamp: 0 }],
  } as never;

  it.each([
    {
      name: "profile default",
      modelOverrides: {
        id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abcdefghijk",
        name: "US Claude Fable 5.1",
      },
      reasoning: undefined,
      expectedEffort: "medium",
    },
    {
      name: "Opus 5 default",
      modelOverrides: {
        id: "global.anthropic.claude-opus-5",
        name: "Claude Opus 5",
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      },
      reasoning: undefined,
      expectedEffort: "high",
    },
    {
      name: "Sonnet 5 explicit off",
      modelOverrides: {
        id: "us.anthropic.claude-sonnet-5",
        name: "Claude Sonnet 5",
        thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: "max" },
      },
      reasoning: "off" as const,
      expectedEffort: "low",
    },
  ])("sends $name policy in the final request", async (testCase) => {
    const options = testCase.reasoning === undefined ? {} : { reasoning: testCase.reasoning };
    const input = await captureCommandInput(
      bedrockModel({ ...testCase.modelOverrides, contextWindow: 1_000_000, maxTokens: 128_000 }),
      context,
      options,
    );

    expect(input.inferenceConfig).toEqual({ maxTokens: 128_000 });
    expect(input.additionalModelRequestFields).toEqual(
      testCase.expectedEffort === undefined
        ? undefined
        : {
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: testCase.expectedEffort },
          },
    );
  });

  it("disables legacy thinking when the output cap leaves no thinking budget", async () => {
    const input = await captureCommandInput(
      bedrockModel({
        id: "anthropic.claude-haiku-4-5-v1:0",
        name: "Claude Haiku 4.5",
        maxTokens: 1024,
      }),
      context,
      { reasoning: "minimal" },
    );

    expect(input.inferenceConfig).toEqual({ maxTokens: 1024 });
    expect(input.additionalModelRequestFields).toBeUndefined();
  });

  it.each([
    ["explicit request cap", 128_000, 32_000, 32_000, "high"],
    ["native model cap with thinking disabled", 128_000, undefined, 128_000, "off"],
  ] as const)(
    "uses the %s for adaptive-capable models",
    async (_name, modelMaxTokens, requestedMaxTokens, expected, reasoning) => {
      const input = await captureCommandInput(
        bedrockModel({
          id: "us.anthropic.claude-opus-4-8",
          name: "Claude Opus 4.8",
          contextWindow: 1_000_000,
          maxTokens: modelMaxTokens,
        }),
        context,
        {
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(requestedMaxTokens === undefined ? {} : { maxTokens: requestedMaxTokens }),
        },
      );

      expect(input.inferenceConfig).toEqual(expected === undefined ? {} : { maxTokens: expected });
      expect(input.additionalModelRequestFields).toEqual(
        reasoning !== "high"
          ? undefined
          : {
              thinking: { type: "adaptive", display: "summarized" },
              output_config: { effort: "high" },
            },
      );
    },
  );

  it("uses descriptive Claude names for opaque profile effort", async () => {
    const input = await captureCommandInput(
      bedrockModel({
        id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/profile-abc",
        name: "Claude Production Opus 4.8",
      }),
      context,
      { reasoning: "xhigh" },
    );

    expect(input.additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "xhigh" },
    });
  });
});

describe("Bedrock Fable contract", () => {
  function fableModel() {
    return bedrockModel({
      id: "production-fable",
      name: "Production deployment",
      reasoning: false,
      params: { canonicalModelId: "claude-fable-5" },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
  }

  function context() {
    return {
      messages: [{ role: "user", content: "Reply briefly.", timestamp: 0 }],
      tools: [
        {
          name: "lookup",
          description: "Lookup",
          parameters: { type: "object", properties: {} },
        },
      ],
    } as never;
  }

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
      additionalModelRequestFields: {
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
      },
      additionalModelResponseFieldPaths: ["/stop_details"],
    });
  });

  it.each([
    [
      "Mythos 5",
      () =>
        bedrockModel({
          id: "production-mythos",
          name: "Production deployment",
          params: { canonicalModelId: "claude-mythos-5" },
          contextWindow: 1_000_000,
          maxTokens: 128_000,
        }),
    ],
  ])("quarantines partial output when %s returns a terminal refusal", async (_name, model) => {
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: streamEvents([
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { text: "discard this partial output" },
          },
        },
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
      ]),
    } as never);

    const stream = streamSimpleBedrock(model(), context());
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

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
      yield { messageStart: { role: ConversationRole.ASSISTANT } };
      yield {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { text: "unsafe partial output" },
        },
      };
      if (transportDrop) {
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      }
    }
    const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: incompleteStream(),
    } as never);
    const destroy = vi.spyOn(BedrockRuntimeClient.prototype, "destroy");

    const stream = streamSimpleBedrock(fableModel(), context());
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();

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
    expect(send).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy.mock.contexts[0]).toBe(send.mock.contexts[0]);
  });

  it("reports activity while Fable events are buffered", async () => {
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
      stream: streamEvents([
        { messageStart: { role: ConversationRole.ASSISTANT } },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { text: "buffered output" },
          },
        },
        {
          metadata: {
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            metrics: { latencyMs: 1 },
          },
        },
        {
          metadata: {
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            metrics: { latencyMs: 1 },
          },
        },
        { messageStop: { stopReason: "end_turn" } },
      ]),
    } as never);
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

describe("Bedrock canonical Claude aliases", () => {
  it.each([
    {
      canonicalModelId: "claude-opus-4-8",
      reasoning: "xhigh" as const,
      thinkingLevelMap: { xhigh: "xhigh" as const, max: "max" as const },
      expectedEffort: "xhigh",
    },
    {
      canonicalModelId: "claude-opus-4-6",
      reasoning: "max" as const,
      thinkingLevelMap: { xhigh: null, max: null },
      expectedEffort: "high",
    },
  ])(
    "uses adaptive thinking and omits temperature for $canonicalModelId aliases",
    async ({ canonicalModelId, reasoning, thinkingLevelMap, expectedEffort }) => {
      const model = bedrockModel({
        id: "production-claude",
        name: "Production Claude",
        reasoning: false,
        params: { canonicalModelId },
        thinkingLevelMap,
      });

      const input = await captureCommandInput(
        model,
        { messages: [{ role: "user", content: "Reply briefly.", timestamp: 0 }] },
        { reasoning, temperature: 0.2 },
      );
      expect(input).toMatchObject({
        modelId: "production-claude",
        inferenceConfig: {},
        additionalModelRequestFields: {
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: expectedEffort },
        },
      });
    },
  );
});
