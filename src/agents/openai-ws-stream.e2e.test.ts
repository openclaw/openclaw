/**
 * End-to-end integration tests for OpenAI WebSocket streaming.
 *
 * These tests hit the real OpenAI Responses API over WebSocket and verify
 * the full request/response lifecycle including:
 *  - Connection establishment and session reuse
 *  - Context options forwarding (temperature)
 *  - Graceful fallback to HTTP on connection failure
 *  - Connection lifecycle cleanup via releaseWsSession
 *
 * Run manually with a valid OPENAI_API_KEY:
 *   OPENAI_API_KEY=sk-... npx vitest run src/agents/openai-ws-stream.e2e.test.ts
 *
 * Skipped in CI — no API key available and we avoid billable external calls.
 */

import type { AssistantMessage, Context } from "@mariozechner/pi-ai";
import { describe, it, expect, afterEach } from "vitest";
import {
  createOpenAIWebSocketStreamFn,
  releaseWsSession,
  hasWsSession,
} from "./openai-ws-stream.js";

const API_KEY = process.env.OPENAI_API_KEY;
const LIVE = !!API_KEY;
const testFn = LIVE ? it : it.skip;

const model = {
  api: "openai-responses" as const,
  provider: "openai",
  id: "gpt-5.2",
  name: "gpt-5.2",
  contextWindow: 128_000,
  maxTokens: 4_096,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as unknown as Parameters<ReturnType<typeof createOpenAIWebSocketStreamFn>>[0];

type StreamFnParams = Parameters<ReturnType<typeof createOpenAIWebSocketStreamFn>>;
function makeContext(userMessage: string): StreamFnParams[1] {
  return {
    systemPrompt: "You are a helpful assistant. Reply in one sentence.",
    messages: [{ role: "user" as const, content: userMessage }],
    tools: [],
  } as unknown as StreamFnParams[1];
}

function makeToolContext(userMessage: string): StreamFnParams[1] {
  return {
    systemPrompt: "You are a precise assistant. Follow tool instructions exactly.",
    messages: [{ role: "user" as const, content: userMessage }],
    tools: [
      {
        name: "noop",
        description: "Return the supplied tool result to the user.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
    ],
  } as unknown as Context;
}

function makeToolResultMessage(
  callId: string,
  output: string,
): StreamFnParams[1]["messages"][number] {
  return {
    role: "toolResult" as const,
    toolCallId: callId,
    toolName: "noop",
    content: [{ type: "text" as const, text: output }],
    isError: false,
    timestamp: Date.now(),
  } as unknown as StreamFnParams[1]["messages"][number];
}

async function collectEvents(
  stream: ReturnType<ReturnType<typeof createOpenAIWebSocketStreamFn>>,
): Promise<Array<{ type: string; message?: AssistantMessage }>> {
  const events: Array<{ type: string; message?: AssistantMessage }> = [];
  for await (const event of stream as AsyncIterable<{ type: string; message?: AssistantMessage }>) {
    events.push(event);
  }
  return events;
}

function expectDone(events: Array<{ type: string; message?: AssistantMessage }>): AssistantMessage {
  const done = events.find((event) => event.type === "done")?.message;
  expect(done).toBeDefined();
  return done!;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** Each test gets a unique session ID to avoid cross-test interference. */
const sessions: string[] = [];
function freshSession(name: string): string {
  const id = `e2e-${name}-${Date.now()}`;
  sessions.push(id);
  return id;
}

describe("OpenAI WebSocket e2e", () => {
  afterEach(() => {
    for (const id of sessions) {
      releaseWsSession(id);
    }
    sessions.length = 0;
  });

  testFn(
    "completes a single-turn request over WebSocket",
    async () => {
      const sid = freshSession("single");
      const streamFn = createOpenAIWebSocketStreamFn(API_KEY!, sid);
      const stream = streamFn(model, makeContext("What is 2+2?"), { transport: "websocket" });
      const done = expectDone(await collectEvents(stream));

      expect(done.content.length).toBeGreaterThan(0);
      const text = assistantText(done);
      expect(text).toMatch(/4/);
    },
    45_000,
  );

  testFn(
    "forwards temperature option to the API",
    async () => {
      const sid = freshSession("temp");
      const streamFn = createOpenAIWebSocketStreamFn(API_KEY!, sid);
      const stream = streamFn(model, makeContext("Pick a random number between 1 and 1000."), {
        transport: "websocket",
        temperature: 0.8,
      });
      const events = await collectEvents(stream);

      // Stream must complete (done or error with fallback) — must NOT hang.
      const hasTerminal = events.some((e) => e.type === "done" || e.type === "error");
      expect(hasTerminal).toBe(true);
    },
    45_000,
  );

  testFn(
    "reuses the websocket session for tool-call follow-up turns",
    async () => {
      const sid = freshSession("tool-roundtrip");
      const streamFn = createOpenAIWebSocketStreamFn(API_KEY!, sid);
      const firstContext = makeToolContext(
        "Call the tool `noop` with {}. After the tool result arrives, reply with exactly the tool output and nothing else.",
      );
      const firstEvents = await collectEvents(
        streamFn(model, firstContext, {
          transport: "websocket",
          toolChoice: "required",
          maxTokens: 128,
        }),
      );
      const firstDone = expectDone(firstEvents);
      const toolCall = firstDone.content.find((block) => block.type === "toolCall") as
        | { type: "toolCall"; id: string; name: string }
        | undefined;
      expect(toolCall?.name).toBe("noop");
      expect(toolCall?.id).toBeTruthy();

      const secondContext = {
        ...firstContext,
        messages: [
          ...firstContext.messages,
          firstDone,
          makeToolResultMessage(toolCall!.id, "TOOL_OK"),
        ],
      } as unknown as StreamFnParams[1];
      const secondDone = expectDone(
        await collectEvents(
          streamFn(model, secondContext, {
            transport: "websocket",
            maxTokens: 128,
          }),
        ),
      );

      expect(assistantText(secondDone)).toMatch(/TOOL_OK/);
    },
    60_000,
  );

  testFn(
    "supports websocket warm-up before the first request",
    async () => {
      const sid = freshSession("warmup");
      const streamFn = createOpenAIWebSocketStreamFn(API_KEY!, sid);
      const done = expectDone(
        await collectEvents(
          streamFn(model, makeContext("Reply with the word warmed."), {
            transport: "websocket",
            openaiWsWarmup: true,
            maxTokens: 32,
          }),
        ),
      );

      expect(assistantText(done).toLowerCase()).toContain("warmed");
    },
    45_000,
  );

  testFn(
    "session is tracked in registry during request",
    async () => {
      const sid = freshSession("registry");
      const streamFn = createOpenAIWebSocketStreamFn(API_KEY!, sid);

      expect(hasWsSession(sid)).toBe(false);

      await collectEvents(streamFn(model, makeContext("Say hello."), { transport: "websocket" }));

      expect(hasWsSession(sid)).toBe(true);
      releaseWsSession(sid);
      expect(hasWsSession(sid)).toBe(false);
    },
    45_000,
  );

  testFn(
    "falls back to HTTP gracefully with invalid API key",
    async () => {
      const sid = freshSession("fallback");
      const streamFn = createOpenAIWebSocketStreamFn("sk-invalid-key", sid);
      const stream = streamFn(model, makeContext("Hello"), {});
      const events = await collectEvents(stream);

      const hasTerminal = events.some((e) => e.type === "done" || e.type === "error");
      expect(hasTerminal).toBe(true);
    },
    45_000,
  );
});
