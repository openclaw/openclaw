import http from "node:http";
import type { AddressInfo } from "node:net";
import { assert, describe, expect, it } from "vitest";
import { createBoundedMistralFetcher, streamMistral } from "./mistral.js";
import { makeProviderModel } from "./provider-model.test-support.js";
import { serializeSse } from "./provider-stream.test-support.js";

const MAX = 16 * 1024 * 1024;
const TOTAL = 18 * 1024 * 1024;

async function withServer<T>(handler: http.RequestListener, run: (url: string) => Promise<T>) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function settleWithin<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("Mistral bounded-stream-read real wire proof (loopback http.createServer)", () => {
  it("caps an oversized body streamed chunked over real wire", async () => {
    const fetcher = createBoundedMistralFetcher(fetch);
    // Pending writes may retain this buffer, so keep its bytes unchanged.
    const chunk = Buffer.alloc(1024 * 1024);
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        let sent = 0;
        const tick = setInterval(() => {
          if (sent < 18) {
            res.write(chunk);
            sent++;
          } else {
            clearInterval(tick);
            res.end();
          }
        }, 1);
      },
      async (url) => {
        let captured: unknown;
        const response = await fetcher(url);
        try {
          await response.arrayBuffer();
        } catch (err) {
          captured = err;
        }
        assert.instanceOf(captured, Error);
        const match = captured.message.match(
          /mistral: stream body exceeds \d+ bytes \(got (\d+)\)/,
        );
        expect(match).not.toBeNull();
        // TCP framing can merge chunks, but the cap must fire before the full body.
        const got = Number(match?.[1]);
        expect(got).toBeGreaterThan(MAX);
        expect(got).toBeLessThan(TOTAL);
      },
    );
  });
});

describe("Mistral bounded-stream-read direct (synthetic ReadableStream)", () => {
  it("finishes wrapped response cancellation after handing cleanup upstream", async () => {
    let cancelStarted = false;
    const upstreamBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelStarted = true;
        return new Promise<void>(() => {});
      },
    });
    const fetcher = createBoundedMistralFetcher(
      async () => new Response(upstreamBody, { status: 200 }),
    );
    const wrapped = await fetcher("http://unused.invalid/");
    const reader = wrapped.body?.getReader();
    assert(reader, "bounded Mistral response did not expose a body reader");

    await expect(
      settleWithin(reader.cancel("done"), "wrapped response cancel"),
    ).resolves.toBeUndefined();
    expect(cancelStarted).toBe(true);
    reader.releaseLock();
  });
});

type MistralTerminalFixture = {
  finishReason: string | null;
  done: boolean;
  abort?: boolean;
  toolArguments?: string[];
  text?: string | Array<{ type: "text"; text: string }>;
  followupTexts?: Array<string | Array<{ type: "text"; text: string }>>;
};

async function streamMistralTerminalFixture(fixture: MistralTerminalFixture) {
  return withServer(
    (request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      const toolCalls = fixture.toolArguments?.map((args, index) => ({
        index,
        id: `call_${index}`,
        type: "function",
        function: { name: `tool_${index}`, arguments: args },
      }));
      const write = (content: MistralTerminalFixture["text"], initial = false) =>
        response.write(
          serializeSse([
            {
              id: "mistral-terminal-owner-proof",
              ...(initial ? { object: "chat.completion.chunk", created: 1 } : {}),
              model: "mistral-large-latest",
              choices: [
                {
                  index: 0,
                  delta: {
                    content: content ?? null,
                    ...(initial && toolCalls ? { tool_calls: toolCalls } : {}),
                  },
                  finish_reason: fixture.finishReason,
                },
              ],
              ...(initial
                ? { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }
                : {}),
            },
          ]),
        );
      write(fixture.text, true);
      for (const content of fixture.followupTexts ?? []) {
        write(content);
      }
      if (fixture.abort) {
        return;
      }
      response.end(fixture.done ? "data: [DONE]\n\n" : "");
    },
    async (baseUrl) => {
      const model = makeProviderModel("mistral-conversations", "mistral", "mistral-large-latest", {
        baseUrl,
        reasoning: false,
      });
      const abort = new AbortController();
      const stream = streamMistral(
        model,
        { messages: [{ role: "user", content: "Inspect only", timestamp: 1 }] },
        { apiKey: "redacted-fixture-token", ...(fixture.abort ? { signal: abort.signal } : {}) },
      );
      const events: string[] = [];
      const textIndexes: number[] = [];
      for await (const event of stream) {
        events.push(event.type);
        if (event.type === "text_delta") {
          assert.isDefined(event.partial);
          textIndexes.push(event.contentIndex);
        }
        if (fixture.abort && event.type === "toolcall_delta") {
          abort.abort(new Error("Operator canceled the incomplete tool"));
        }
      }
      return { result: await stream.result(), events, textIndexes };
    },
  );
}

describe("Mistral terminal ownership through the installed SDK and real HTTP/SSE", () => {
  it("preserves text and tool transitions across wire content forms", async () => {
    const { result, events, textIndexes } = await streamMistralTerminalFixture({
      text: [{ type: "text", text: "before" }],
      followupTexts: ["after"],
      finishReason: "tool_calls",
      done: true,
      toolArguments: ["{}"],
    });
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([
      { type: "text", text: "before" },
      expect.objectContaining({ type: "toolCall", name: "tool_0", arguments: {} }),
      { type: "text", text: "after" },
    ]);
    expect(textIndexes).toEqual([0, 2]);
    expect(events).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_end",
      "done",
    ]);
  });

  const partial = { type: "text", text: "Safe partial answer" };
  const eofError = "Mistral stream ended without a terminal finish reason";
  const unknownError = "Provider finish_reason: provider_guardrail";
  const badJson = expect.stringContaining("invalid JSON arguments");
  it.each([
    ["operator cancellation", null, false, true, "aborted", undefined, undefined],
    ["EOF", null, false, false, "error", eofError, "error"],
    ["unknown terminal", "provider_guardrail", true, false, "error", unknownError, "error"],
    ["malformed tool terminal", "tool_calls", true, false, "error", badJson, "error"],
    ["model_length alias", "model_length", true, false, "length", undefined, "done"],
  ] as const)(
    "never executes incomplete arguments after %s",
    async (_name, finishReason, done, abort, stopReason, errorMessage, terminalEvent) => {
      const { result, events } = await streamMistralTerminalFixture({
        finishReason,
        done,
        abort,
        toolArguments: ['{"action":"delete_all"'],
        ...(abort ? {} : { text: partial.text }),
      });
      expect(result.stopReason).toBe(stopReason);
      if (errorMessage !== undefined) {
        expect(result.errorMessage).toEqual(errorMessage);
      }
      if (terminalEvent) {
        expect(events).toContain(terminalEvent);
      }
      expect(events).not.toContain("toolcall_end");
      if (abort) {
        expect(result.content).not.toContainEqual(expect.objectContaining({ type: "toolCall" }));
      } else {
        expect(result.content).toEqual([partial]);
      }
    },
  );

  it("drops every pending parallel tool when a later call is truncated", async () => {
    const { result, events } = await streamMistralTerminalFixture({
      finishReason: "length",
      done: true,
      toolArguments: ['{"action":"inspect"}', '{"action":"delete_all"'],
    });
    expect(result.stopReason).toBe("length");
    expect(result.content).toEqual([]);
    expect(events).not.toContain("toolcall_end");
  });

  it("preserves unsafe integers in provider-confirmed tool arguments", async () => {
    const { result, events } = await streamMistralTerminalFixture({
      finishReason: "tool_calls",
      done: true,
      toolArguments: ['{"target":9223372036854775807}'],
    });
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "toolCall", arguments: { target: "9223372036854775807" } }),
    );
    expect(events).toContain("toolcall_end");
  });
});
