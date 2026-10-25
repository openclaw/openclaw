import { expect, vi } from "vitest";
import type { AssistantMessage, Model, StreamFn } from "../../llm.js";
import type { AgentCoreCompletionRuntimeDeps } from "../../runtime-deps.js";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";
import { createMessageEntry } from "./compaction.test-support.js";
import { assistant, responseStream, user } from "./shard-fixtures.test-support.js";

export const entries = (...messages: AgentMessage[]) => messages.map(createMessageEntry);
export const userEntry = (content: string, index: number) =>
  createMessageEntry(user(content, index + 1), index);
export const modelReply = (model: Model, content: string | AssistantMessage["content"]) =>
  assistant(content, { api: model.api, provider: model.provider, model: model.id });

export function compactionEntry(
  index: number,
  summary: string,
  firstKeptEntryId: string,
  overrides: Partial<Extract<SessionTreeEntry, { type: "compaction" }>> = {},
): SessionTreeEntry {
  return {
    type: "compaction",
    id: `entry-${index}`,
    parentId: `entry-${index - 1}`,
    timestamp: new Date(index + 1).toISOString(),
    summary,
    firstKeptEntryId,
    tokensBefore: 200_000,
    ...overrides,
  };
}

export function contains(value: string, ...parts: string[]) {
  for (const part of parts) {
    expect(value).toContain(part);
  }
}
export function excludes(value: string, ...parts: string[]) {
  for (const part of parts) {
    expect(value).not.toContain(part);
  }
}

function promptText(context: Parameters<StreamFn>[1]) {
  const message = context.messages[0];
  if (message?.role !== "user") {
    throw new Error("expected a user summary prompt");
  }
  return typeof message.content === "string"
    ? message.content
    : message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

export function captureStream(reply: () => AssistantMessage) {
  let prompt = "";
  let systemPrompt = "";
  let maxOutputTokens: number | undefined;
  const streamFn = vi.fn<StreamFn>((_model, context, options) => {
    prompt = promptText(context);
    systemPrompt = context.systemPrompt ?? "";
    maxOutputTokens = options?.maxTokens;
    return responseStream(reply());
  });
  return { streamFn, readCapture: () => ({ prompt, systemPrompt, maxOutputTokens }) };
}

export function captureCompletion(reply: (prompt: string) => AssistantMessage) {
  const prompts: string[] = [];
  let systemPrompt = "";
  const runtime: AgentCoreCompletionRuntimeDeps = {
    completeSimple: async (_model, context) => {
      const prompt = promptText(context);
      prompts.push(prompt);
      systemPrompt = context.systemPrompt ?? "";
      return reply(prompt);
    },
  };
  return { prompts, runtime, systemPrompt: () => systemPrompt };
}
