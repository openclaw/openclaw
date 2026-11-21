import { expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import {
  anthropicModel,
  context,
  anthropicEvents,
  registerParityHostLifecycle,
} from "../provider-transport-parity.test-support.js";
import { onLlmRequestActivity } from "../utils/llm-request-activity.js";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";

registerParityHostLifecycle();
const encoder = new TextEncoder();
function frame(events = anthropicEvents, newline = "\n", blankLine = newline) {
  return events
    .map(
      (event) =>
        `event: ${event.type}${newline}data: ${JSON.stringify(event)}${newline}${blankLine}`,
    )
    .join("");
}
function chunks(parts: string[], beforeNext = () => {}) {
  let index = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(source) {
        if (index > 0) {
          beforeNext();
        }
        source.enqueue(encoder.encode(parts[index++]));
        if (index === parts.length) {
          source.close();
        }
      },
    },
    { highWaterMark: 0 },
  );
}

async function runResponse(body: BodyInit, signal?: AbortSignal) {
  configureAiTransportHost({
    ...getAiTransportHost(),
    buildModelFetch: () => async () =>
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
  });
  const stream = await createAnthropicMessagesTransportStreamFn()(anthropicModel, context, {
    apiKey: "test-key",
    signal,
  });
  return stream.result();
}

it.each([
  ["\n", "\n"],
  ["\r\n", "\r\n"],
  ["\r", "\r"],
  ["\n", "\r\n"],
  ["\r\n", "\n"],
])("parses fragmented %j/%j framing", async (newline, blankLine) => {
  const result = await runResponse(chunks(frame(anthropicEvents, newline, blankLine).split("")));
  expect(result.stopReason).toBe("stop");
  expect(
    result.content.filter((block) => block.type === "text").map((block) => block.text),
  ).toEqual(["Hello world"]);
});

it.each([false, true])("handles an undelimited EOF event (malformed=%s)", async (malformed) => {
  const body = frame().trimEnd();
  const result = await runResponse(malformed ? body.slice(0, -1) : body);
  expect(result.stopReason).toBe(malformed ? "error" : "stop");
  if (malformed) {
    expect(result.errorMessage).toContain("malformed_streaming_fragment");
  }
});

it("consumes complete CR frames before requesting more input", async () => {
  const prefix = frame(anthropicEvents.slice(0, -2), "\r");
  const terminal = frame(anthropicEvents.slice(-2), "\r");
  const controller = new AbortController();
  const activity = vi.fn();
  const unsubscribe = onLlmRequestActivity(controller.signal, activity);
  let consumedBeforeNextRead = 0;
  try {
    const result = await runResponse(
      chunks([prefix, terminal], () => {
        consumedBeforeNextRead = activity.mock.calls.length;
      }),
      controller.signal,
    );
    expect(consumedBeforeNextRead).toBe(8);
    expect(result.stopReason).toBe("stop");
  } finally {
    unsubscribe();
  }
});

it("assembles a fragmented large frame once while enforcing the pending limit", async () => {
  const padding = "x".repeat(1024 * 1024);
  const wire = `: ${padding}\n\n${frame()}`;
  const parts = wire.match(/.{1,1024}/gs) ?? [];
  const join = Array.prototype.join;
  let joinedChars = 0;
  const spy = vi.spyOn(Array.prototype, "join").mockImplementation(function (
    this: unknown[],
    separator,
  ) {
    for (const part of this) {
      if (typeof part === "string") {
        joinedChars += part.length;
      }
    }
    return join.call(this, separator);
  });
  let result;
  try {
    result = await runResponse(chunks(parts));
  } finally {
    spy.mockRestore();
  }
  expect(result.stopReason).toBe("stop");
  expect(
    result.content.filter((block) => block.type === "text").map((block) => block.text),
  ).toEqual(["Hello world"]);
  expect(joinedChars).toBeLessThan(wire.length * 4);
});
