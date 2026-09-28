// Mistral provider tests cover bounded-stream-read helper (`createBoundedMistralFetcher`).
import http from "node:http";
import type { AddressInfo } from "node:net";
import { assert, describe, expect, it } from "vitest";
import type { AssistantMessageEvent, Context, Model } from "../types.js";
import { createBoundedMistralFetcher, streamMistral } from "./mistral.js";

const MAX = 16 * 1024 * 1024;
const TOTAL = 18 * 1024 * 1024;

async function readAllChunks(body: ReadableStream<Uint8Array> | null): Promise<{ total: number }> {
  if (!body) {
    return { total: 0 };
  }
  const reader = body.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      total += value.byteLength;
    }
  }
  return { total };
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
    const fetcher = createBoundedMistralFetcher(MAX);
    const CHUNK = 1024 * 1024;
    // Pending writes may retain this buffer, so keep its bytes unchanged.
    const chunk = Buffer.alloc(CHUNK);
    const server = http.createServer((req, res) => {
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
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const port = (server.address() as AddressInfo).port;

    let captured: Error | undefined;
    try {
      const response = await fetcher(`http://127.0.0.1:${port}/`);
      // Wire framing merges TCP packets, so the reported size at throw time
      // is between MAX (cap) and TOTAL (cap + last merged packet). Both
      // bounds prove (a) cap fired (got > MAX) and (b) we did not buffer
      // beyond the server's full 18 MiB (got < TOTAL).
      try {
        await readAllChunks(response.body);
      } catch (err) {
        captured = err as Error;
      }
      expect(captured).toBeInstanceOf(Error);
      const match = (captured as Error).message.match(
        /mistral: stream body exceeds \d+ bytes \(got (\d+)\)/,
      );
      expect(match).not.toBeNull();
      const got = Number(match?.[1]);
      expect(got).toBeGreaterThan(MAX);
      expect(got).toBeLessThan(TOTAL);
      // Print to vitest stdout for PR-body real behavior proof capture.
      console.log(
        `[mistral bounded-stream proof] oversized path: cap=${MAX} reported=${got} server_total=${TOTAL}`,
      );
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it("returns a Response with exact bytes for normal-size responses on real wire", async () => {
    const fetcher = createBoundedMistralFetcher(MAX);
    const bodyText = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n';
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(bodyText);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const port = (server.address() as AddressInfo).port;

    try {
      const response = await fetcher(`http://127.0.0.1:${port}/`);
      expect(response.status).toBe(200);
      const { total } = await readAllChunks(response.body);
      expect(total).toBe(Buffer.byteLength(bodyText, "utf8"));
      console.log(
        `[mistral bounded-stream proof] normal path: cap=${MAX} returned=${total} body=${JSON.stringify(bodyText)}`,
      );
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
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
      MAX,
      async () => new Response(upstreamBody, { status: 200 }),
    );
    const wrapped = await fetcher("http://unused.invalid/");
    const reader = wrapped.body?.getReader();
    if (!reader) {
      throw new Error("bounded Mistral response did not expose a body reader");
    }

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
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    const toolCalls = fixture.toolArguments?.map((args, index) => ({
      index,
      id: `call_${index}`,
      type: "function",
      function: { name: `tool_${index}`, arguments: args },
    }));
    response.write(
      `data: ${JSON.stringify({
        id: "mistral-terminal-owner-proof",
        object: "chat.completion.chunk",
        created: 1,
        model: "mistral-large-latest",
        choices: [
          {
            index: 0,
            delta: {
              content: fixture.text ?? null,
              ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: fixture.finishReason,
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      })}\n\n`,
    );
    for (const content of fixture.followupTexts ?? []) {
      response.write(
        `data: ${JSON.stringify({
          id: "mistral-terminal-owner-proof",
          model: "mistral-large-latest",
          choices: [
            {
              index: 0,
              delta: { content },
              finish_reason: fixture.finishReason,
            },
          ],
        })}\n\n`,
      );
    }
    if (fixture.abort) {
      return;
    }
    response.end(fixture.done ? "data: [DONE]\n\n" : "");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const model = {
    id: "mistral-large-latest",
    name: "Mistral terminal owner",
    api: "mistral-conversations",
    provider: "mistral",
    baseUrl: `http://127.0.0.1:${port}`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  } satisfies Model<"mistral-conversations">;
  const context = {
    messages: [{ role: "user", content: "Inspect only", timestamp: 1 }],
  } satisfies Context;
  try {
    const abort = new AbortController();
    const stream = streamMistral(model, context, {
      apiKey: "redacted-fixture-token",
      ...(fixture.abort ? { signal: abort.signal } : {}),
    });
    const events: string[] = [];
    const textIndexes: number[] = [];
    const textBlocks: unknown[] = [];
    const messageEvents: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      events.push(event.type);
      messageEvents.push(event);
      if (event.type === "text_delta") {
        assert.isDefined(event.partial);
        textIndexes.push(event.contentIndex);
        textBlocks.push(event.partial.content[event.contentIndex]);
      }
      if (fixture.abort && event.type === "toolcall_delta") {
        abort.abort(new Error("Operator canceled the incomplete tool"));
      }
    }
    return { result: await stream.result(), events, textIndexes, textBlocks, messageEvents };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("Mistral terminal ownership through the installed SDK and real HTTP/SSE", () => {
  it.each(["string", "text chunks"] as const)(
    "coalesces %s wire deltas without changing event identity",
    async (representation) => {
      const inputs = ["", "a", "😀", "\ud800x", "\ud83d", "\ude00", "z"];
      const contents = inputs.map((text) =>
        representation === "string" ? text : [{ type: "text" as const, text }],
      );
      const { result, events, textIndexes, textBlocks, messageEvents } =
        await streamMistralTerminalFixture({
          text: contents[0],
          followupTexts: contents.slice(1),
          finishReason: "stop",
          done: true,
        });
      const deltas = messageEvents.filter((event) => event.type === "text_delta");
      expect(result.stopReason).toBe("stop");
      expect(result.content).toEqual([{ type: "text", text: "a😀xz" }]);
      expect(deltas.map((event) => event.delta)).toEqual(["", "a", "😀", "x", "", "", "z"]);
      expect(textIndexes).toEqual(inputs.map(() => 0));
      expect(textBlocks.every((block) => block === result.content[0])).toBe(true);
      expect(
        deltas.every(
          (event) => event.partial === result && event.partial.content[0] === result.content[0],
        ),
      ).toBe(true);
      expect(events).toEqual([
        "start",
        "text_start",
        ...inputs.map(() => "text_delta"),
        "text_end",
        "done",
      ]);
    },
  );

  it.each([
    { text: "before", followupTexts: [[{ type: "text", text: "after" }]] },
    { text: [{ type: "text", text: "before" }], followupTexts: ["after"] },
  ] satisfies Array<Pick<MistralTerminalFixture, "text" | "followupTexts">>)(
    "preserves text and tool transitions across wire content forms: %j",
    async (fixture) => {
      const { result, events, textIndexes } = await streamMistralTerminalFixture({
        ...fixture,
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
    },
  );

  it("discards unfinished tool arguments when the operator cancels generation", async () => {
    const { result, events } = await streamMistralTerminalFixture({
      finishReason: null,
      done: false,
      abort: true,
      toolArguments: ['{"action":"delete_all"'],
    });
    expect(result.stopReason).toBe("aborted");
    expect(events).not.toContain("toolcall_end");
    expect(result.content).not.toContainEqual(expect.objectContaining({ type: "toolCall" }));
  });

  it.each([
    { name: "EOF without a provider terminal", finishReason: null, done: false },
    { name: "DONE without a provider terminal", finishReason: null, done: true },
    { name: "a filtered provider terminal", finishReason: "content_filter", done: true },
    { name: "an unknown provider terminal", finishReason: "provider_guardrail", done: true },
    { name: "malformed arguments on a tool terminal", finishReason: "tool_calls", done: true },
  ] as const)("rejects $name without executable calls", async (fixture) => {
    const { result, events } = await streamMistralTerminalFixture({
      ...fixture,
      toolArguments: ['{"action":"delete_all"'],
      text: "Safe partial answer",
    });
    expect(result.stopReason).toBe("error");
    if (fixture.finishReason === null) {
      expect(result.errorMessage).toBe("Mistral stream ended without a terminal finish reason");
    } else if (fixture.finishReason === "tool_calls") {
      expect(result.errorMessage).toContain("invalid JSON arguments");
    } else {
      expect(result.errorMessage).toBe(`Provider finish_reason: ${fixture.finishReason}`);
    }
    expect(events).toContain("error");
    expect(events).not.toContain("toolcall_end");
    expect(result.content).not.toContainEqual(expect.objectContaining({ type: "toolCall" }));
    expect(result.content).toContainEqual({ type: "text", text: "Safe partial answer" });
  });

  it.each([
    { finishReason: "length", stopReason: "length" },
    { finishReason: "model_length", stopReason: "length" },
    { finishReason: "stop", stopReason: "stop" },
  ] as const)(
    "preserves a $finishReason terminal and visible text without finalizing partial tools",
    async ({ finishReason, stopReason }) => {
      const { result, events } = await streamMistralTerminalFixture({
        finishReason,
        done: true,
        toolArguments: ['{"action":"delete_all"'],
        text: "Safe partial answer",
      });
      expect(result.stopReason).toBe(stopReason);
      expect(result.content).toEqual([{ type: "text", text: "Safe partial answer" }]);
      expect(events).not.toContain("toolcall_end");
      expect(events).toContain("done");
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

  it("keeps a complete provider-confirmed tool executable", async () => {
    const { result, events } = await streamMistralTerminalFixture({
      finishReason: "tool_calls",
      done: true,
      toolArguments: ['{"action":"inspect"}'],
    });
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "toolCall", arguments: { action: "inspect" } }),
    );
    expect(events).toContain("toolcall_end");
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

  it.each(["null", "[]", "42"] as const)(
    "rejects a provider-confirmed non-object JSON argument: %s",
    async (argumentsJson) => {
      const { result, events } = await streamMistralTerminalFixture({
        finishReason: "tool_calls",
        done: true,
        toolArguments: [argumentsJson],
      });
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("invalid JSON arguments");
      expect(events).not.toContain("toolcall_end");
      expect(result.content).not.toContainEqual(expect.objectContaining({ type: "toolCall" }));
    },
  );

  it("preserves a legitimate empty tool-argument object", async () => {
    const { result, events } = await streamMistralTerminalFixture({
      finishReason: "tool_calls",
      done: true,
      toolArguments: ["{}"],
    });
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toContainEqual(expect.objectContaining({ arguments: {} }));
    expect(events).toContain("toolcall_end");
  });

  it("keeps a completed stop response without tools unchanged", async () => {
    const { result, events } = await streamMistralTerminalFixture({
      finishReason: "stop",
      done: true,
      text: "Visible answer",
    });
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "Visible answer" }]);
    expect(events).toContain("done");
  });
});
