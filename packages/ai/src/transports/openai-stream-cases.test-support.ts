import type { AssistantMessageEventStreamLike } from "@openclaw/llm-core";
import { expect } from "vitest";

export async function collectEventTypes(
  stream: AssistantMessageEventStreamLike,
  types: string[] = [],
) {
  for await (const event of stream) {
    types.push(event.type);
  }
  return types;
}

export function outputItem<T>(phase: "added" | "done", item: T, output_index = 0) {
  return { type: `response.output_item.${phase}`, output_index, item };
}

export function argumentDelta(item_id: string, delta: string, output_index = 0) {
  return { type: "response.function_call_arguments.delta", output_index, item_id, delta };
}

export function completedResponse<T>(
  id: string,
  output: T[],
  fields: Record<string, unknown> = {},
) {
  return { type: "response.completed", response: { id, status: "completed", output, ...fields } };
}

export function wireMessage(id: string, text: string) {
  return {
    type: "message" as const,
    id,
    role: "assistant" as const,
    status: "completed" as const,
    content: [{ type: "output_text" as const, text, annotations: [], logprobs: [] }],
  };
}

export function expectTypes(items: readonly { type?: string | null }[], types: readonly string[]) {
  expect(items.map((item) => item.type)).toEqual(types);
}

export function wireCall(id: string, name: string, args = "{}") {
  return {
    type: "function_call" as const,
    id: `fc_${id}`,
    call_id: `call_${id}`,
    name,
    arguments: args,
  };
}

export function userMessage(content: string, timestamp = 1) {
  return { role: "user" as const, content, timestamp };
}

export function wireUser(text: string) {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}
