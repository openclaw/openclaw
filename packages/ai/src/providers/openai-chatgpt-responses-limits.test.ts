import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../types.js";
import { streamOpenAICodexResponses } from "./openai-chatgpt-responses.js";
import {
  chatgptModel as model,
  chatgptContext as context,
  completedResponse,
  resetChatgptTransport,
} from "./openai-chatgpt-responses.test-helpers.js";

const apiKey = `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }),
).toString("base64url")}.signature`;

const run = () => streamOpenAICodexResponses(model, context, { apiKey, transport: "sse" }).result();
function mockResponse(body: ReadableStream<Uint8Array>, init: ResponseInit = {}) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(body, init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
function repeatedBody(chunk: Uint8Array, onCancel?: () => Promise<void>) {
  const state: { pullCount: number; canceled: boolean; cancelReason?: unknown } = {
    pullCount: 0,
    canceled: false,
  };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++state.pullCount > 32) {
        controller.close();
      } else {
        controller.enqueue(chunk);
      }
    },
    cancel(reason) {
      state.canceled = true;
      state.cancelReason = reason;
      return onCancel?.();
    },
  });
  return { body, state };
}

afterEach(resetChatgptTransport);

describe("OpenAI ChatGPT Responses resource limits", () => {
  it("bounds non-OK response bodies without awaiting cancellation before formatting API errors", async () => {
    vi.useFakeTimers();
    const cancellation = Promise.withResolvers<void>();
    const byteLimit = 16 * 1024;
    const prefix = "usage limit ";
    const chunk = new TextEncoder().encode(
      `${prefix}${"x".repeat(byteLimit - prefix.length - 2)}😀tail`,
    );
    const { body: overflowing, state } = repeatedBody(chunk, () => cancellation.promise);
    const fetchMock = mockResponse(overflowing, { status: 400, statusText: "Bad Request" });

    let result: AssistantMessage | undefined;
    const pending = run().then((message) => {
      result = message;
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(result).toBeDefined();
      expect(result?.stopReason).toBe("error");
      expect(result?.errorMessage).toContain("usage limit");
      expect(result?.errorMessage).not.toContain("�");
      expect(result?.errorMessage).not.toContain("tail");
      expect(result?.errorMessage?.length).toBeLessThanOrEqual(byteLimit);
      expect(state.canceled).toBe(true);
      expect(overflowing.locked).toBe(false);
      expect(state.pullCount).toBeGreaterThanOrEqual(1);
      expect(state.pullCount).toBeLessThanOrEqual(3);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      // Drain the fixture even on the baseline, whose outcome still awaits cancellation.
      cancellation.resolve();
      await pending;
    }
  });

  it.each([1, 320])("accepts over 16 MiB with %i complete frames per read", async (batchSize) => {
    const pad = "x".repeat(64 * 1024);
    const progressFrame = new TextEncoder().encode(
      `data: ${JSON.stringify({ type: "response.in_progress", pad })}\n\n`.repeat(batchSize),
    );
    const completedFrame = new TextEncoder().encode(
      `data: ${JSON.stringify(completedResponse("resp_long"))}\n\n`,
    );
    const progressFrames = 320 / batchSize; // ~20 MiB total
    let sent = 0;
    const longStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent < progressFrames) {
          sent += 1;
          controller.enqueue(progressFrame);
          return;
        }
        controller.enqueue(completedFrame);
        controller.close();
      },
    });
    mockResponse(longStream, { status: 200, headers: { "content-type": "text/event-stream" } });
    const result = await run();

    expect(sent * progressFrame.byteLength).toBeGreaterThan(16 * 1024 * 1024);
    expect(result.errorMessage).toBeUndefined();
    expect(result.stopReason).toBe("stop");
  });

  it.each([
    { label: "complete in one read", ending: "\n\n", split: false, char: "x" },
    { label: "delimiter in the limit-crossing read", ending: "\r\n\r\n", split: true, char: "x" },
    { label: "EOF", ending: "", split: false, char: "x" },
    {
      label: "UTF-8 byte overflow below the character cap",
      ending: "\n\n",
      split: true,
      char: "😀",
    },
  ])("rejects oversized frames: $label", async ({ ending, split, char }) => {
    const byteLimit = 16 * 1024 * 1024;
    const frame = new TextEncoder().encode(
      `data: ${JSON.stringify({ type: "response.in_progress", pad: char.repeat(byteLimit / Buffer.byteLength(char)) })}${ending}`,
    );
    const chunks = split ? [frame.subarray(0, byteLimit), frame.subarray(byteLimit)] : [frame];
    let cancelReason: unknown;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk) {
            controller.enqueue(chunk);
          } else {
            controller.close();
          }
        },
        cancel(reason) {
          cancelReason = reason;
          return new Promise<void>(() => {});
        },
      },
      // Keep the source open until the parser requests EOF so cancellation is observable.
      { highWaterMark: 0 },
    );
    mockResponse(body);
    const result = await run();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("OpenAI ChatGPT Responses SSE frame exceeded 16777216 bytes");
    expect(cancelReason).toBeInstanceOf(Error);
    expect(body.locked).toBe(false);
  });

  it("bounds an unterminated streamed success frame without content-length", async () => {
    // 1 MiB chunks with no frame boundary; the pending-frame bound is 16 MiB so
    // the reader cancels well before draining the full 32 MiB body.
    const chunkBytes = 1024 * 1024;
    const { body: overflowing, state } = repeatedBody(new Uint8Array(chunkBytes));
    const fetchMock = mockResponse(overflowing, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const result = await run();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(
      /OpenAI ChatGPT Responses SSE frame exceeded 16777216 bytes/,
    );
    expect(state.cancelReason).toBeInstanceOf(Error);
    expect(state.pullCount).toBeGreaterThanOrEqual(17);
    expect(state.pullCount).toBeLessThanOrEqual(20);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
