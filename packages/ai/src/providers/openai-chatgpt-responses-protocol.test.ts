import { describe, expect, it } from "vitest";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../transports/transport-utils.js";
import { parseOpenAIChatGptResponsesSse } from "./openai-chatgpt-responses-protocol.js";

const completedEvent = {
  type: "response.completed",
  response: {
    id: "resp_parser",
    status: "completed",
    output: [],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  },
};
const serializedCompletedEvent = JSON.stringify(completedEvent);
const multilineDataLines = JSON.stringify(completedEvent, null, 2)
  .split("\n")
  .map((line) => `data: ${line}`);

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

describe("ChatGPT Responses SSE frame boundaries", () => {
  it.each([
    { label: "EOF without a delimiter", chunks: [`data: ${serializedCompletedEvent}`] },
    { label: "EOF after one LF", chunks: [`data: ${serializedCompletedEvent}\n`] },
    { label: "EOF after one CR", chunks: [`data: ${serializedCompletedEvent}\r`] },
    { label: "multiline EOF", chunks: [multilineDataLines.join("\r\n")] },
    {
      label: "chunk-split EOF",
      chunks: ["data: ", serializedCompletedEvent.slice(0, 20), serializedCompletedEvent.slice(20)],
    },
    { label: "LF", chunks: [`data: ${serializedCompletedEvent}\n\n`] },
    { label: "CRLF", chunks: [`data: ${serializedCompletedEvent}\r\n\r\n`] },
    { label: "lone CR", chunks: [`data: ${serializedCompletedEvent}\r\r`] },
    {
      label: "mixed line endings",
      chunks: [`event: response.completed\r\ndata: ${serializedCompletedEvent}\n\r\n`],
    },
    {
      label: "chunk-split CRLF",
      chunks: [
        `event: response.completed\r`,
        `\ndata: ${serializedCompletedEvent}\r`,
        "\n\r",
        "\n",
      ],
    },
    {
      label: "chunk-split lone CR",
      chunks: ["event: response.completed\r", `data: ${serializedCompletedEvent}\r`, "\r"],
    },
    { label: "multiline LF", chunks: [`${multilineDataLines.join("\n")}\n\n`] },
    { label: "multiline CRLF", chunks: [`${multilineDataLines.join("\r\n")}\r\n\r\n`] },
    { label: "multiline lone CR", chunks: [`${multilineDataLines.join("\r")}\r\r`] },
    {
      label: "multiline mixed line endings",
      chunks: [
        `event: response.completed\r\n${multilineDataLines
          .map(
            (line, index) => `${line}${index % 3 === 0 ? "\r\n" : index % 3 === 1 ? "\r" : "\n"}`,
          )
          .join("")}\r\n`,
      ],
    },
    {
      label: "multiline chunk-split CRLF",
      chunks: [...multilineDataLines.flatMap((line) => [`${line}\r`, "\n"]), "\r", "\n"],
    },
    {
      label: "multiline chunk-split lone CR",
      chunks: [...multilineDataLines.flatMap((line) => [line, "\r"]), "\r"],
    },
  ])("parses $label SSE frame boundaries", async ({ chunks }) => {
    let chunkIndex = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[chunkIndex++];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(chunk));
      },
    });
    const events = [];

    for await (const event of parseOpenAIChatGptResponsesSse(new Response(body))) {
      events.push(event);
    }

    expect(events).toEqual([completedEvent]);
  });

  it.each([
    { label: "lone CR", chunks: [`data: ${serializedCompletedEvent}\r\r`] },
    { label: "mixed LF and lone CR", chunks: [`data: ${serializedCompletedEvent}\n\r`] },
    { label: "mixed CRLF and lone CR", chunks: [`data: ${serializedCompletedEvent}\r\n\r`] },
    { label: "chunk-split lone CR", chunks: [`data: ${serializedCompletedEvent}\r`, "\r"] },
    {
      label: "chunk-split mixed LF and lone CR",
      chunks: [`data: ${serializedCompletedEvent}\n`, "\r"],
    },
  ])("dispatches a $label SSE frame before an open response closes", async ({ chunks }) => {
    const cleanup = new AbortController();
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        cleanup.signal.addEventListener("abort", () => controller.close(), { once: true });
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
      },
      cancel() {
        canceled = true;
      },
    });
    const iterator = parseOpenAIChatGptResponsesSse(new Response(body))[Symbol.asyncIterator]();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let receivedEvent = false;

    try {
      const result = await Promise.race([
        iterator.next(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error("SSE frame was not dispatched while the response remained open"));
          }, 1_000);
        }),
      ]);
      receivedEvent = true;

      expect(result).toEqual({ done: false, value: completedEvent });
      expect(cleanup.signal.aborted).toBe(false);
      expect(canceled).toBe(false);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (!receivedEvent) {
        cleanup.abort();
      }
      await iterator.return(undefined);
    }

    expect(canceled).toBe(true);
  });

  it("keeps a final undelimited event after a delimited event", async () => {
    const precedingEvent = { type: "response.output_item.done" };
    const response = new Response(
      `data: ${JSON.stringify(precedingEvent)}\n\ndata: ${serializedCompletedEvent}`,
    );
    const events = [];
    for await (const event of parseOpenAIChatGptResponsesSse(response)) {
      events.push(event);
    }
    expect(events).toEqual([precedingEvent, completedEvent]);
  });

  it("rejects a malformed EOF frame after a valid event", async () => {
    const iterator = parseOpenAIChatGptResponsesSse(
      new Response(`data: ${serializedCompletedEvent}\n\ndata: {not-json`),
    );
    await expect(iterator.next()).resolves.toEqual({ done: false, value: completedEvent });
    await expect(iterator.next()).rejects.toThrow(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE);
  });

  it.each(["", ": heartbeat", "data:", "data: [DONE]"])(
    "ignores the EOF residue %j without duplicating the preceding event",
    async (tail) => {
      const events = [];
      for await (const event of parseOpenAIChatGptResponsesSse(
        new Response(`data: ${serializedCompletedEvent}\n\n${tail}`),
      )) {
        events.push(event);
      }
      expect(events).toEqual([completedEvent]);
    },
  );

  it.each(["\n\n", ""])(
    "preserves consumer failures after a frame ending with %j",
    async (ending) => {
      const response = new Response(`data: ${serializedCompletedEvent}${ending}`);
      const iterator = parseOpenAIChatGptResponsesSse(response);
      const failure = new SyntaxError("consumer failed");
      await expect(iterator.next()).resolves.toEqual({ done: false, value: completedEvent });
      await expect(iterator.throw(failure)).rejects.toBe(failure);
      expect(response.body?.locked).toBe(false);
    },
  );

  it("releases the response reader when upstream cancellation remains pending", async () => {
    let cancelStarted = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${serializedCompletedEvent}\n\n`));
      },
      cancel() {
        cancelStarted = true;
        return new Promise<void>(() => {});
      },
    });
    const iterator = parseOpenAIChatGptResponsesSse(new Response(body))[Symbol.asyncIterator]();

    await expect(settleWithin(iterator.next(), "first response event")).resolves.toEqual({
      done: false,
      value: completedEvent,
    });
    await expect(
      settleWithin(iterator.return(undefined), "terminal iterator cleanup"),
    ).resolves.toEqual({ done: true, value: undefined });
    expect(cancelStarted).toBe(true);

    const replacementReader = body.getReader();
    replacementReader.releaseLock();
  });
});
