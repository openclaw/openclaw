import type { Model } from "@openclaw/llm-core";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { makeProviderModel } from "../providers/provider-model.test-support.js";
import { cleanupSessionResources } from "../session-resources.js";
import { createResponsesStreamWithRecovery } from "./openai-responses-replay-internal.js";
import { createOpenAIResponsesAssistantOutput } from "./openai-responses-replay-messages-internal.js";
import { processResponsesStream } from "./openai-responses-stream-internal.js";
import { completedResponse } from "./openai-stream-cases.test-support.js";

const model: Model<"openai-responses"> = makeProviderModel(
  "openai-responses",
  "openai",
  "fixture",
  {
    name: "Fixture",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    contextWindow: 8192,
    maxTokens: 256,
  },
);

afterEach(() => {
  cleanupSessionResources();
  vi.restoreAllMocks();
});

async function openFixtureStream(chunks: readonly Uint8Array[], failure?: Error) {
  let offset = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[offset++];
        if (chunk) {
          controller.enqueue(chunk);
        } else if (failure) {
          controller.error(failure);
        } else {
          controller.close();
        }
      },
    },
    { highWaterMark: 0 },
  );
  const client = new OpenAI({
    apiKey: "fixture-key",
    logLevel: "off",
    fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  });
  const request = { model: "fixture", stream: true, input: "fixture" } satisfies Parameters<
    typeof createResponsesStreamWithRecovery
  >[0]["request"];
  return createResponsesStreamWithRecovery({
    client,
    model,
    request,
    requestOptions: undefined,
    buildFullHistoryRequest: () => request,
  });
}

describe("Responses SSE decoding", () => {
  it("decodes a long response once per wire chunk while preserving every delta", async () => {
    const expected = Array.from({ length: 3_000 }, (_, sequence_number) => ({
      type: "response.output_text.delta",
      sequence_number,
      delta: `fixture ${sequence_number}: 🌊 café`,
    }));
    const wire = new TextEncoder().encode(
      expected.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    );
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < wire.length; offset += 4_096) {
      chunks.push(wire.subarray(offset, offset + 4_096));
    }
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    const { stream } = await openFixtureStream(chunks);
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    expect(events).toEqual(expected);
    expect(decode.mock.calls.length).toBeLessThanOrEqual(chunks.length + 1);
  });

  it("keeps delimiter scan input linear for a large event split across small chunks", async () => {
    const expected = { type: "response.output_text.delta", delta: "x".repeat(1024 * 1024) };
    const wire = new TextEncoder().encode(`data: ${JSON.stringify(expected)}\n\ndata: [DONE]\n\n`);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < wire.length; offset += 1_024) {
      chunks.push(wire.subarray(offset, offset + 1_024));
    }
    const { stream } = await openFixtureStream(chunks);
    // oxlint-disable-next-line typescript/unbound-method -- Preserve native exec; each call restores its RegExp receiver.
    const exec = RegExp.prototype.exec;
    let scannedChars = 0;
    const scan = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (
      this: RegExp,
      input,
    ) {
      scannedChars += input.length;
      return exec.call(this, input);
    });
    const events = [];
    try {
      for await (const event of stream) {
        events.push(event);
      }
    } finally {
      scan.mockRestore();
    }
    expect(events).toEqual([expected]);
    expect(scannedChars).toBeLessThanOrEqual(wire.length * 3);
  });

  it.each([
    {
      name: "multiline JSON, mixed line endings, split UTF-8, and final EOF",
      wire:
        ': heartbeat\r\nevent: response.output_text.delta\rdata: {"type":\r\n' +
        'data: "response.output_text.delta",\ndata: "delta":"🌊"}\r\n\r\n' +
        'data: {"delta":"final"}',
      expected: [{ type: "response.output_text.delta", delta: "🌊" }, { delta: "final" }],
    },
    {
      name: "thread event envelopes including embedded error payloads",
      wire: 'event: thread.message.delta\ndata: {"error":{"message":"thread data"}}\n\n',
      expected: [{ event: "thread.message.delta", data: { error: { message: "thread data" } } }],
    },
    {
      name: "BOM at stream and later line starts",
      wire: '\uFEFFdata: {"delta":"first"}\n\n\uFEFFdata: {"delta":"second"}\n\n',
      expected: [{ delta: "first" }, { delta: "second" }],
    },
    {
      name: "BOM-only lines dispatch the preceding event",
      wire: 'data: {"delta":"first"}\n\uFEFF\ndata: {"delta":"second"}\n\n',
      expected: [{ delta: "first" }, { delta: "second" }],
    },
    {
      name: "only one initial BOM is removed",
      wire: '\uFEFF\uFEFFdata: {"delta":"ignored"}\n\ndata: {"delta":"kept"}\n\n',
      expected: [{ delta: "kept" }],
    },
    {
      name: "ignored fields and exact DONE stopping before malformed trailing data",
      wire:
        ": heartbeat\nid: fixture\nretry: 100\nevent:\n\n" +
        'event: custom\ndata: {"delta":"kept"}\n\ndata: [DONE]\n\ndata: PRIVATE-MALFORMED\n\n',
      expected: [{ delta: "kept" }],
    },
  ])("preserves $name", async ({ wire, expected }) => {
    const chunks = Array.from(new TextEncoder().encode(wire), (byte) => Uint8Array.of(byte));
    const { stream } = await openFixtureStream(chunks);
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    expect(events).toEqual(expected);
  });

  it.each([
    "data: PRIVATE-MALFORMED\n\n",
    "data: PRIVATE-MALFORMED",
    "event: response.output_text.delta\n\n",
    "data\n\n",
    "data:\n\n",
    "data: [DONE] \n\n",
  ])("sanitizes invalid SSE JSON (%j)", async (wire) => {
    const { stream } = await openFixtureStream([new TextEncoder().encode(wire)]);
    const read = async () => {
      for await (const event of stream) {
        throw new Error(`invalid fixture emitted ${JSON.stringify(event)}`);
      }
    };
    await expect(read()).rejects.toThrow(
      new SyntaxError("Error reading response: malformed server-sent event JSON."),
    );
  });

  it.each([
    {
      wire: 'event: error\ndata: {"message":"fixture failure","code":"fixture_code"}\n\n',
      payload: { message: "fixture failure", code: "fixture_code" },
      message: "fixture failure",
    },
    {
      wire: 'data: {"error":{"message":"fixture failure","code":"fixture_code"}}\n\n',
      payload: { message: "fixture failure", code: "fixture_code" },
      message: "fixture failure",
    },
    { wire: "event: error\ndata: null\n\n", payload: null, message: "(no status code or body)" },
    { wire: "event: error\ndata: 42\n\n", payload: 42, message: "42" },
    { wire: 'event: error\ndata: "failure"\n\n', payload: "failure", message: '"failure"' },
  ])("preserves SDK API errors ($wire)", async ({ wire, payload, message }) => {
    const { stream } = await openFixtureStream([new TextEncoder().encode(wire)]);
    const read = async () => {
      for await (const event of stream) {
        throw new Error(`error fixture emitted ${JSON.stringify(event)}`);
      }
    };
    const result = read();
    await expect(result).rejects.toBeInstanceOf(OpenAI.APIError);
    await expect(result).rejects.toMatchObject({ message, error: payload });
  });

  it.each([
    {
      name: "transport AbortError",
      failure: new DOMException("fixture abort", "AbortError"),
      aborted: true,
    },
    {
      name: "Expo transport abort",
      failure: new Error("FetchRequestCanceledException: fixture"),
      aborted: true,
    },
    { name: "read failure", failure: new Error("fixture read failure"), aborted: false },
    {
      name: "provider APIError named AbortError",
      failure: Object.assign(
        new OpenAI.APIError(undefined, { message: "fixture API failure" }, undefined, undefined),
        { name: "AbortError" },
      ),
      aborted: false,
    },
  ])("preserves $name after an emitted event", async ({ failure, aborted }) => {
    const { stream } = await openFixtureStream(
      [new TextEncoder().encode('data: {"delta":"before"}\n\n')],
      failure,
    );
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: { delta: "before" }, done: false });
    if (aborted) {
      await expect(iterator.next()).resolves.toMatchObject({ done: true });
    } else {
      await expect(iterator.next()).rejects.toBe(failure);
    }
  });
});

describe("Responses terminal body disposal", () => {
  it.each(["byte bound", "deadline", "shutdown", "caller cancellation"] as const)(
    "returns terminal immediately and cancels trailing bytes on %s",
    async (end) => {
      const deadline = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      const cancelled = createDeferred();
      const caller = new AbortController();
      let source: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller;
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify(completedResponse("fixture", []))}\n\n`,
            ),
          );
        },
        cancel: () => cancelled.resolve(),
      });
      const client = new OpenAI({
        apiKey: "fixture-key",
        fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
      });
      const request = {
        model: "fixture",
        stream: true,
        input: [{ role: "user", content: "fixture" }],
      } satisfies Parameters<typeof createResponsesStreamWithRecovery>[0]["request"];
      const { stream } = await createResponsesStreamWithRecovery({
        client,
        model,
        request,
        buildFullHistoryRequest: () => request,
        requestOptions: { signal: caller.signal },
      });
      const output = createOpenAIResponsesAssistantOutput(model);
      await processResponsesStream(stream, output, { push() {} }, model);
      expect(output.stopReason).toBe("stop");
      expect(timeout).toHaveBeenCalledWith(250);
      if (end === "byte bound") {
        if (!source) {
          throw new Error("missing fixture source");
        }
        source.enqueue(new Uint8Array(64 * 1024));
      } else if (end === "deadline") {
        deadline.abort();
      } else if (end === "shutdown") {
        cleanupSessionResources();
      } else {
        caller.abort();
      }
      await cancelled.promise;
    },
  );
});
