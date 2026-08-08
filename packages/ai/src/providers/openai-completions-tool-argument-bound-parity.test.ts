import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createOpenAICompletionsTransportStreamFn } from "../transports/openai-completions-transport.js";
import type { AssistantMessageEventStreamLike, Context, Model } from "../types.js";
import { streamOpenAICompletions } from "./openai-completions.js";

const TOOL_ARGUMENT_BYTE_LIMIT = 256_000;
const model = {
  id: "gpt-5.5",
  name: "Chat tool argument boundary proof",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} satisfies Model<"openai-completions">;
const context = {
  messages: [{ role: "user", content: "Use the lookup tool", timestamp: 1 }],
} satisfies Context;

type ToolCallDelta = {
  index: number;
  id?: string;
  type?: "function";
  function: { name?: string; arguments?: string };
};

type ArgumentScenario = {
  name: string;
  frames: ToolCallDelta[][];
  stopReason: "toolUse" | "error";
  argumentBytes?: number[];
};

function argumentsWithByteLength(bytes: number, fill = "a"): string {
  const prefix = '{"value":"';
  const suffix = '"}';
  const availableBytes = bytes - Buffer.byteLength(prefix + suffix, "utf8");
  const characterBytes = Buffer.byteLength(fill, "utf8");
  const repeated = fill.repeat(Math.floor(availableBytes / characterBytes));
  const remainder = "a".repeat(availableBytes % characterBytes);
  const value = `${prefix}${repeated}${remainder}${suffix}`;
  expect(Buffer.byteLength(value, "utf8")).toBe(bytes);
  return value;
}

function toolCall(index: number, argumentsValue: string, first = true): ToolCallDelta {
  return {
    index,
    ...(first ? { id: `call_${index}`, type: "function" as const } : {}),
    function: { ...(first ? { name: "lookup" } : {}), arguments: argumentsValue },
  };
}

function splitSurrogateArgumentFrames(bytes: number): ToolCallDelta[][] {
  const prefix = '{"value":"';
  const suffix = '"}';
  const emoji = "😀";
  const padding = bytes - Buffer.byteLength(prefix + suffix + emoji, "utf8");
  const value = `${prefix}${"a".repeat(padding)}${emoji}${suffix}`;
  expect(Buffer.byteLength(value, "utf8")).toBe(bytes);
  const surrogateBoundary = value.indexOf(emoji) + 1;
  return [
    [toolCall(0, value.slice(0, surrogateBoundary))],
    [toolCall(0, value.slice(surrogateBoundary), false)],
  ];
}

function unpairedSurrogateArguments(bytes: number): string {
  const prefix = '{"value":"';
  const suffix = '"}';
  const surrogate = "\uD83D";
  const padding = bytes - Buffer.byteLength(prefix + suffix + surrogate, "utf8");
  const value = `${prefix}${"a".repeat(padding)}${surrogate}${suffix}`;
  expect(Buffer.byteLength(value, "utf8")).toBe(bytes);
  return value;
}

function splitUnpairedSurrogateFrames(bytes: number): ToolCallDelta[][] {
  const value = unpairedSurrogateArguments(bytes);
  const surrogateBoundary = value.indexOf("\uD83D") + 1;
  return [
    [toolCall(0, value.slice(0, surrogateBoundary))],
    [toolCall(0, value.slice(surrogateBoundary), false)],
  ];
}

function installPinnedSdkSseFrames(frames: ToolCallDelta[][]): void {
  const body =
    frames
      .map((toolCalls, index) =>
        JSON.stringify({
          id: "chatcmpl-tool-argument-limit",
          object: "chat.completion.chunk",
          created: 1,
          model: model.id,
          choices: [
            {
              index: 0,
              delta: { tool_calls: toolCalls },
              finish_reason: index === frames.length - 1 ? "tool_calls" : null,
            },
          ],
        }),
      )
      .map((chunk) => `data: ${chunk}\n\n`)
      .join("") + "data: [DONE]\n\n";
  configureAiTransportHost({
    buildModelFetch: () => async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  });
}

const scenarios: ArgumentScenario[] = [
  {
    name: "accepts the existing exact ASCII byte limit",
    frames: [[toolCall(0, argumentsWithByteLength(TOOL_ARGUMENT_BYTE_LIMIT))]],
    stopReason: "toolUse",
    argumentBytes: [TOOL_ARGUMENT_BYTE_LIMIT],
  },
  {
    name: "rejects a single modern argument one byte above the limit",
    frames: [[toolCall(0, argumentsWithByteLength(TOOL_ARGUMENT_BYTE_LIMIT + 1))]],
    stopReason: "error",
  },
  {
    name: "rejects an oversized modern argument split across SDK chunks",
    frames: (() => {
      const value = argumentsWithByteLength(TOOL_ARGUMENT_BYTE_LIMIT + 1);
      return [[toolCall(0, value.slice(0, 128_000))], [toolCall(0, value.slice(128_000), false)]];
    })(),
    stopReason: "error",
  },
  {
    name: "measures multibyte arguments by UTF-8 bytes rather than UTF-16 characters",
    frames: [[toolCall(0, argumentsWithByteLength(TOOL_ARGUMENT_BYTE_LIMIT + 1, "é"))]],
    stopReason: "error",
  },
  {
    name: "accepts an exact-limit surrogate pair split between SDK deltas",
    frames: splitSurrogateArgumentFrames(TOOL_ARGUMENT_BYTE_LIMIT),
    stopReason: "toolUse",
    argumentBytes: [TOOL_ARGUMENT_BYTE_LIMIT],
  },
  {
    name: "rejects an oversized surrogate pair split between SDK deltas",
    frames: splitSurrogateArgumentFrames(TOOL_ARGUMENT_BYTE_LIMIT + 1),
    stopReason: "error",
  },
  {
    name: "preserves split-surrogate accounting across an empty intermediate delta",
    frames: (() => {
      const [first, second] = splitSurrogateArgumentFrames(TOOL_ARGUMENT_BYTE_LIMIT);
      return [first, [toolCall(0, "", false)], second];
    })(),
    stopReason: "toolUse",
    argumentBytes: [TOOL_ARGUMENT_BYTE_LIMIT],
  },
  {
    name: "counts a terminal orphan high surrogate as its UTF-8 replacement",
    frames: [[toolCall(0, unpairedSurrogateArguments(TOOL_ARGUMENT_BYTE_LIMIT))]],
    stopReason: "toolUse",
  },
  {
    name: "rejects an oversized terminal orphan high surrogate",
    frames: [[toolCall(0, unpairedSurrogateArguments(TOOL_ARGUMENT_BYTE_LIMIT + 1))]],
    stopReason: "error",
  },
  {
    name: "counts a pending high surrogate followed by a non-low character as replacement",
    frames: splitUnpairedSurrogateFrames(TOOL_ARGUMENT_BYTE_LIMIT),
    stopReason: "toolUse",
  },
  {
    name: "rejects an oversized pending high surrogate followed by a non-low character",
    frames: splitUnpairedSurrogateFrames(TOOL_ARGUMENT_BYTE_LIMIT + 1),
    stopReason: "error",
  },
  {
    name: "keeps interleaved surrogate accounting independent across SDK tool indices",
    frames: (() => {
      const [first, second] = splitSurrogateArgumentFrames(TOOL_ARGUMENT_BYTE_LIMIT);
      return [[...first, toolCall(1, argumentsWithByteLength(200_000))], second];
    })(),
    stopReason: "toolUse",
    argumentBytes: [TOOL_ARGUMENT_BYTE_LIMIT, 200_000],
  },
  {
    name: "keeps two complete modern calls independently bounded",
    frames: [
      [
        toolCall(0, argumentsWithByteLength(200_000)),
        toolCall(1, argumentsWithByteLength(200_000)),
      ],
    ],
    stopReason: "toolUse",
    argumentBytes: [200_000, 200_000],
  },
];

const createManagedStream = createOpenAICompletionsTransportStreamFn();

function createManagedFixtureStream(): AssistantMessageEventStreamLike {
  const stream = createManagedStream(model, context, { apiKey: "fixture-token" });
  if (stream instanceof Promise) {
    throw new Error("OpenAI Chat Completions transport must return its stream synchronously");
  }
  return stream;
}

let previousHost: ReturnType<typeof getAiTransportHost>;

beforeEach(() => {
  previousHost = getAiTransportHost();
});

afterEach(() => {
  configureAiTransportHost(previousHost);
});

describe.each([
  {
    name: "package",
    createStream: () => streamOpenAICompletions(model, context, { apiKey: "fixture-token" }),
  },
  { name: "managed", createStream: createManagedFixtureStream },
])("$name Chat tool argument ownership", ({ createStream }) => {
  it.each(scenarios)("$name", async ({ frames, stopReason, argumentBytes }) => {
    installPinnedSdkSseFrames(frames);
    const result = await createStream().result();

    expect(result.stopReason).toBe(stopReason);
    if (stopReason === "error") {
      expect(result.errorMessage).toContain("Exceeded tool-call argument buffer limit");
      expect(result.content.some((block) => block.type === "toolCall")).toBe(false);
      return;
    }
    if (argumentBytes) {
      expect(
        result.content
          .filter((block) => block.type === "toolCall")
          .map((block) => Buffer.byteLength(JSON.stringify(block.arguments), "utf8")),
      ).toEqual(argumentBytes);
    }
  });
});
