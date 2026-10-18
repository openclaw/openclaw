import http from "node:http";
import type { AddressInfo } from "node:net";
import { assert, describe, expect, it } from "vitest";
import { withTestTimeout } from "../../../../test/helpers/promise.js";
import type { Context } from "../types.js";
import { createBoundedMistralFetcher, streamMistral } from "./mistral.js";
import { makeProviderModel } from "./provider-model.test-support.js";

const MAX = 16 * 1024 * 1024;
const TOTAL = 18 * 1024 * 1024;

async function listen(server: http.Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const close = (server: http.Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

it("caps an oversized body streamed chunked over real wire", async () => {
  const fetcher = createBoundedMistralFetcher(MAX);
  const CHUNK = 1024 * 1024;
  // Pending writes may retain this buffer, so keep its bytes unchanged.
  const chunk = Buffer.alloc(CHUNK);
  const server = http.createServer((_req, res) => {
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
  const url = await listen(server);

  try {
    const response = await fetcher(`${url}/`);
    // TCP merges packets: the overflow must land between the cap and the full body.
    assert.isNotNull(response.body);
    const captured = await response.body
      .pipeTo(new WritableStream<Uint8Array>())
      .catch((error: unknown) => error);
    assert.instanceOf(captured, Error);
    const match = captured.message.match(/mistral: stream body exceeds \d+ bytes \(got (\d+)\)/);
    expect(match).not.toBeNull();
    const got = Number(match?.[1]);
    expect(got).toBeGreaterThan(MAX);
    expect(got).toBeLessThan(TOTAL);
  } finally {
    await close(server);
  }
});

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
  assert.isNotNull(wrapped.body);
  const reader = wrapped.body.getReader();

  const cancellation = withTestTimeout(
    reader.cancel("done"),
    250,
    "wrapped response cancel did not settle",
  );
  await expect(cancellation).resolves.toBeUndefined();
  expect(cancelStarted).toBe(true);
  reader.releaseLock();
});

type MistralTerminalFixture = {
  finishReason: string | null;
  done: boolean;
  abort?: boolean;
  toolArguments?: string[];
  text?: string | Array<{ type: "text"; text: string }>;
  followupTexts?: Array<string | Array<{ type: "text"; text: string }>>;
};

async function runTerminal(overrides: Partial<MistralTerminalFixture>) {
  const fixture = {
    finishReason: "tool_calls",
    done: true,
    toolArguments: ['{"action":"delete_all"'],
    ...overrides,
  };
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    const toolCalls = fixture.toolArguments?.map((args, index) => ({
      index,
      id: `call_${index}`,
      type: "function",
      function: { name: `tool_${index}`, arguments: args },
    }));
    const write = (delta: Record<string, unknown>) =>
      response.write(
        `data: ${JSON.stringify({
          id: "mistral-terminal-owner-proof",
          model: "mistral-large-latest",
          choices: [{ index: 0, delta, finish_reason: fixture.finishReason }],
        })}\n\n`,
      );
    write({ content: fixture.text ?? null, ...(toolCalls ? { tool_calls: toolCalls } : {}) });
    for (const content of fixture.followupTexts ?? []) {
      write({ content });
    }
    if (fixture.abort) {
      return;
    }
    response.end(fixture.done ? "data: [DONE]\n\n" : "");
  });
  const baseUrl = await listen(server);
  const model = makeProviderModel("mistral-conversations", "mistral", "mistral-large-latest", {
    name: "Mistral terminal owner",
    baseUrl,
    reasoning: false,
  });
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
  } finally {
    server.closeAllConnections();
    await close(server);
  }
}

describe("Mistral terminal ownership through the installed SDK and real HTTP/SSE", () => {
  it("preserves text and tool transitions across wire content forms", async () => {
    const { result, events, textIndexes } = await runTerminal({
      text: [{ type: "text", text: "before" }],
      followupTexts: ["after"],
      toolArguments: ["{}"],
    });
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([
      { type: "text", text: "before" },
      expect.objectContaining({ type: "toolCall", name: "tool_0", arguments: {} }),
      { type: "text", text: "after" },
    ]);
    expect(textIndexes).toEqual([0, 2]);
    expect(events).toEqual(
      "start text_start text_delta text_end toolcall_start toolcall_delta text_start text_delta text_end toolcall_end done".split(
        " ",
      ),
    );
  });

  it("discards unfinished tool arguments when the operator cancels generation", async () => {
    const { result, events } = await runTerminal({
      finishReason: null,
      done: false,
      abort: true,
    });
    expect(result.stopReason).toBe("aborted");
    expect(events).not.toContain("toolcall_end");
    expect(result.content).not.toContainEqual(expect.objectContaining({ type: "toolCall" }));
  });

  it.each([
    { name: "EOF without a provider terminal", finishReason: null, done: false },
    { name: "an unknown provider terminal", finishReason: "provider_guardrail", done: true },
    { name: "malformed arguments on a tool terminal", finishReason: "tool_calls", done: true },
  ] as const)("rejects $name without executable calls", async (fixture) => {
    const { result, events } = await runTerminal({
      ...fixture,
      text: "Safe partial answer",
    });
    const errorMessage =
      fixture.finishReason === "tool_calls"
        ? expect.stringContaining("invalid JSON arguments")
        : fixture.finishReason === null
          ? "Mistral stream ended without a terminal finish reason"
          : `Provider finish_reason: ${fixture.finishReason}`;
    expect(result).toMatchObject({ stopReason: "error", errorMessage });
    expect(events).toContain("error");
    expect(events).not.toContain("toolcall_end");
    expect(result.content).not.toContainEqual(expect.objectContaining({ type: "toolCall" }));
    expect(result.content).toContainEqual({ type: "text", text: "Safe partial answer" });
  });

  it.each([
    {
      finishReason: "model_length",
      text: "Safe partial answer",
      toolArguments: ['{"action":"delete_all"'],
      content: [{ type: "text", text: "Safe partial answer" }],
    },
    {
      finishReason: "length",
      text: undefined,
      toolArguments: ['{"action":"inspect"}', '{"action":"delete_all"'],
      content: [],
    },
  ])(
    "preserves $finishReason without finalizing partial tools",
    async ({ content, ...fixture }) => {
      const { result, events } = await runTerminal(fixture);
      expect(result.stopReason).toBe("length");
      expect(result.content).toEqual(content);
      expect(events).not.toContain("toolcall_end");
      expect(events).toContain("done");
    },
  );

  it("preserves unsafe integers in provider-confirmed tool arguments", async () => {
    const { result, events } = await runTerminal({
      toolArguments: ['{"target":9223372036854775807}'],
    });
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "toolCall", arguments: { target: "9223372036854775807" } }),
    );
    expect(events).toContain("toolcall_end");
  });
});
