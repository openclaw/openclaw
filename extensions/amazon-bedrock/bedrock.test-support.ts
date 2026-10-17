import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import type { Context, Model, UserMessage } from "openclaw/plugin-sdk/llm";
import { expect, vi } from "vitest";
import type { BedrockOptions } from "./bedrock-options.js";
import { streamSimpleBedrock } from "./stream.runtime.js";

export function bedrockModel(
  overrides: Partial<Model<"bedrock-converse-stream">> = {},
): Model<"bedrock-converse-stream"> {
  return {
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    id: "amazon.nova-micro-v1:0",
    name: "Nova Micro",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}
export const startEvent = { messageStart: { role: "assistant" } };
export const stopEvent = { messageStop: { stopReason: "end_turn" } };
export const userContext = (content = "Hello"): Context => ({
  messages: [{ role: "user", content, timestamp: 0 }],
});
export const runtimeUser = (content: UserMessage["content"], timestamp: number) => ({
  role: "user" as const,
  content,
  timestamp,
  runtimeContext: {},
});
export async function* streamEvents(events: unknown[]) {
  yield* events;
}
export function mockStream(events: unknown[] = [startEvent, stopEvent]) {
  return mockResponse(streamEvents(events));
}
export function mockResponse(
  stream: unknown,
  metadata: { httpStatusCode: number; requestId?: string } = { httpStatusCode: 200 },
) {
  return vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
    $metadata: metadata,
    stream,
  } as never);
}
export function expectDestroyedClient(
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
export function streamBedrockForTest(
  model: Model<"bedrock-converse-stream">,
  context: Context,
  options: BedrockOptions = {},
) {
  return streamSimpleBedrock(model, context, options as never);
}
export async function capturePayload(
  model: Model<"bedrock-converse-stream">,
  context: Context,
  options: BedrockOptions = {},
  validate?: (input: ConverseStreamCommand["input"]) => void,
) {
  const send = mockStream();
  if (validate) {
    send.mockImplementation((command) => {
      if (!(command instanceof ConverseStreamCommand)) {
        throw new Error("expected ConverseStreamCommand");
      }
      validate(command.input);
      return {
        $metadata: { httpStatusCode: 200 },
        stream: streamEvents([startEvent, stopEvent]),
      } as never;
    });
  }
  const result = await streamBedrockForTest(model, context, options).result();
  if (validate && result.stopReason !== "stop") {
    throw new Error(
      `Bedrock request fixture rejected replay: ${result.errorMessage ?? result.stopReason}`,
    );
  }
  const command = send.mock.calls.at(-1)?.[0];
  if (!(command instanceof ConverseStreamCommand)) {
    throw new Error("expected ConverseStreamCommand");
  }
  return command.input;
}
export async function collectStream(stream: ReturnType<typeof streamSimpleBedrock>) {
  const eventTypes: string[] = [];
  for await (const event of stream) {
    eventTypes.push(event.type);
  }
  return { eventTypes, result: await stream.result() };
}
export const toolStart = (contentBlockIndex: number, toolUseId: string, name = "read") => ({
  contentBlockStart: { contentBlockIndex, start: { toolUse: { toolUseId, name } } },
});
export const toolDelta = (contentBlockIndex: number, input: string) => ({
  contentBlockDelta: { contentBlockIndex, delta: { toolUse: { input } } },
});
export const textDelta = (text: string) => ({
  contentBlockDelta: { contentBlockIndex: 0, delta: { text } },
});
