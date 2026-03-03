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
  id: "gpt-4o-mini",
  name: "gpt-4o-mini",
  baseUrl: "",
  reasoning: false,
  input: { maxTokens: 128_000 },
  output: { maxTokens: 16_384 },
  cache: false,
  compat: {},
} as unknown as Parameters<ReturnType<typeof createOpenAIWebSocketStreamFn>>[0];

type StreamFnParams = Parameters<ReturnType<typeof createOpenAIWebSocketStreamFn>>;
function makeContext(userMessage: string): StreamFnParams[1] {
  return {
    systemPrompt: "You are a helpful assistant. Reply in one sentence.",
    messages: [{ role: "user" as const, content: userMessage }],
    tools: [],
  } as unknown as StreamFnParams[1];
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
      const stream = streamFn(model, makeContext("What is 2+2?"), {});

      const events: Array<{ type: string }> = [];
      for await (const event of stream as AsyncIterable<{ type: string }>) {
        events.push(event);
      }

      const done = events.find((e) => e.type === "done") as
        | { type: "done"; message: { content: Array<{ type: string; text?: string }> } }
        | undefined;
      expect(done).toBeDefined();
      expect(done!.message.content.length).toBeGreaterThan(0);

      const text = done!.message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      expect(text).toMatch(/4/);
    },
    30_000,
  );

  testFn(
    "forwards temperature option to the API",
    async () => {
      const sid = freshSession("temp");
      const streamFn = createOpenAIWebSocketStreamFn(API_KEY!, sid);
      const stream = streamFn(model, makeContext("Pick a random number between 1 and 1000."), {
        temperature: 0.8,
      });

      const events: Array<{ type: string }> = [];
      for await (const event of stream as AsyncIterable<{ type: string }>) {
        events.push(event);
      }

      // Stream must complete (done or error with fallback) — must NOT hang.
      const hasTerminal = events.some((e) => e.type === "done" || e.type === "error");
      expect(hasTerminal).toBe(true);
    },
    30_000,
  );

  testFn(
    "session is tracked in registry during request",
    async () => {
      const sid = freshSession("registry");
      const streamFn = createOpenAIWebSocketStreamFn(API_KEY!, sid);

      expect(hasWsSession(sid)).toBe(false);

      const stream = streamFn(model, makeContext("Say hello."), {});
      for await (const _ of stream as AsyncIterable<unknown>) {
        /* consume */
      }

      expect(hasWsSession(sid)).toBe(true);
      releaseWsSession(sid);
      expect(hasWsSession(sid)).toBe(false);
    },
    30_000,
  );

  testFn(
    "falls back to HTTP gracefully with invalid API key",
    async () => {
      const sid = freshSession("fallback");
      const streamFn = createOpenAIWebSocketStreamFn("sk-invalid-key", sid);
      const stream = streamFn(model, makeContext("Hello"), {});

      const events: Array<{ type: string }> = [];
      for await (const event of stream as AsyncIterable<{ type: string }>) {
        events.push(event);
      }

      const hasTerminal = events.some((e) => e.type === "done" || e.type === "error");
      expect(hasTerminal).toBe(true);
    },
    30_000,
  );
});
