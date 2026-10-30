import { describe, expect, it } from "vitest";
import { raceWithTimeout } from "../../../retry/src/index.js";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../transports/transport-utils.js";
import { parseOpenAIChatGptResponsesSse } from "./openai-chatgpt-responses-protocol.js";

const completedEvent = { type: "response.completed", response: { id: "resp_parser" } };
const parse = (body: BodyInit) => parseOpenAIChatGptResponsesSse(new Response(body));
const serializedCompletedEvent = JSON.stringify(completedEvent);
const precedingEvent = { type: "response.output_item.done" };
const settleWithin = <T>(promise: Promise<T>, ms: number) =>
  raceWithTimeout(promise, ms, () => {
    throw new Error("SSE operation did not settle");
  });

describe("ChatGPT Responses SSE frame boundaries", () => {
  it.each([
    [
      "multiline mixed line endings",
      `event: response.completed\r\n${JSON.stringify(completedEvent, null, 2)
        .split("\n")
        .map((line, index) => `data: ${line}${["\r\n", "\r", "\n"][index % 3]}`)
        .join("")}\r\n`,
      [completedEvent],
    ],
    [
      "final undelimited event",
      `data: ${JSON.stringify(precedingEvent)}\n\ndata: ${serializedCompletedEvent}`,
      [precedingEvent, completedEvent],
    ],
  ] as const)("parses %s", async (_name, body, expected) => {
    const events = [];
    for await (const event of parse(body)) {
      events.push(event);
    }
    expect(events).toEqual(expected);
  });

  it.each([
    ["dispatches chunk-split CR frames before EOF", ["\r", "\r"], false, 1_000],
    ["releases the reader despite pending upstream cancellation", ["\n\n"], true, 250],
  ] as const)("%s", async (_name, endings, stallCancel, timeout) => {
    const cleanup = new AbortController();
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        cleanup.signal.addEventListener("abort", () => controller.close(), { once: true });
        const chunks = [`data: ${serializedCompletedEvent}${endings[0]}`, ...endings.slice(1)];
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
      },
      cancel() {
        canceled = true;
        if (stallCancel) {
          return new Promise<void>(() => {});
        }
        return undefined;
      },
    });
    const iterator = parse(body);
    let receivedEvent = false;

    try {
      const result = await settleWithin(iterator.next(), timeout);
      receivedEvent = true;

      expect(result).toEqual({ done: false, value: completedEvent });
      expect(cleanup.signal.aborted).toBe(false);
      expect(canceled).toBe(false);
    } finally {
      if (!receivedEvent) {
        cleanup.abort();
      }
      await expect(settleWithin(iterator.return(undefined), timeout)).resolves.toEqual({
        done: true,
        value: undefined,
      });
    }

    expect(canceled).toBe(true);
    const replacementReader = body.getReader();
    replacementReader.releaseLock();
  });

  it("rejects a malformed EOF frame after a valid event", async () => {
    const iterator = parse(`data: ${serializedCompletedEvent}\n\ndata: {not-json`);
    await expect(iterator.next()).resolves.toEqual({ done: false, value: completedEvent });
    await expect(iterator.next()).rejects.toThrow(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE);
  });
});
