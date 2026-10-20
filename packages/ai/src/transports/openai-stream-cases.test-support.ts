import type { AssistantMessageEventStreamLike } from "@openclaw/llm-core";
import { expect } from "vitest";
import type { AssistantMessage, AssistantMessageEvent, TextContent } from "../types.js";

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

export type TextOrDelta = AssistantMessageEvent & {
  partial?: AssistantMessage;
  contentIndex?: number;
  delta?: string;
};

/**
 * Mirrors the agent-core consumption contract
 * (agent-stream-response.ts resolveAssistantMessageUpdate): boundary events
 * with a partial replace the consumer state wholesale; text deltas append at
 * their content index. Deliberately guard-free — a correct stream never needs
 * the downstream replay guard. Returns the text observed before every append
 * so the caller can checkpoint intermediate states, not just the healed end.
 */
function consumeLikeAgentCore(events: readonly AssistantMessageEvent[]): {
  text: string;
  prevBeforeAppend: string[];
} {
  let state: AssistantMessage | null = null;
  const prevBeforeAppend: string[] = [];
  for (const event of events) {
    const typed = event as TextOrDelta;
    if (typed.partial) {
      state = typed.partial;
      continue;
    }
    if (event.type === "text_delta") {
      const content = [...(state?.content ?? [])];
      const idx = typed.contentIndex ?? 0;
      const current = content[idx] as TextContent | undefined;
      const prev = current?.type === "text" ? current.text : "";
      prevBeforeAppend.push(prev);
      content[idx] =
        current?.type === "text"
          ? { ...current, text: prev + (typed.delta ?? "") }
          : { type: "text", text: typed.delta ?? "" };
      state = { ...(state ?? { content: [] }), content } as AssistantMessage;
    }
  }
  const text = (state?.content ?? [])
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
  return { text, prevBeforeAppend };
}

export function expectReplaceAppendText(
  events: readonly AssistantMessageEvent[],
  wireText: string,
) {
  const consumer = consumeLikeAgentCore(events);
  // Intermediate prefixes catch aliased deltas even when the final snapshot heals them.
  const deltas = events
    .filter((event): event is typeof event & { delta: string } => event.type === "text_delta")
    .map((event) => event.delta);
  expect(consumer.prevBeforeAppend).toHaveLength(deltas.length);
  let accumulated = "";
  for (const [index, prev] of consumer.prevBeforeAppend.entries()) {
    expect(prev).toBe(accumulated);
    accumulated += deltas[index];
  }
  expect(accumulated).toBe(wireText);
  expect(consumer.text).toBe(wireText);
}
