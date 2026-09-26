import { describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import {
  anthropicModel,
  context,
  anthropicEvents,
  createAnthropicResponse,
  registerParityHostLifecycle,
} from "../provider-transport-parity.test-support.js";
import { onLlmRequestActivity } from "../utils/llm-request-activity.js";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";

registerParityHostLifecycle();

async function runResponse(response: Response, signal?: AbortSignal) {
  configureAiTransportHost({
    ...getAiTransportHost(),
    buildModelFetch: () => async () => response,
  });
  const stream = await createAnthropicMessagesTransportStreamFn()(anthropicModel, context, {
    apiKey: "test-key",
    signal,
  });
  return stream.result();
}

describe("Anthropic SSE framing", () => {
  it.each(
    [
      { name: "LF", newline: "\n", blankLine: "\n" },
      { name: "CRLF", newline: "\r\n", blankLine: "\r\n" },
      { name: "CR", newline: "\r", blankLine: "\r" },
      { name: "LF/CRLF", newline: "\n", blankLine: "\r\n" },
      { name: "CRLF/LF", newline: "\r\n", blankLine: "\n" },
    ].flatMap(({ name, newline, blankLine }) =>
      [false, true].map((fragmented) => ({ name, newline, blankLine, fragmented })),
    ),
  )("parses $name framing (fragmented=$fragmented)", async ({ newline, blankLine, fragmented }) => {
    const body = anthropicEvents
      .map(
        (event) =>
          `event: ${event.type}${newline}data: ${JSON.stringify(event)}${newline}${blankLine}`,
      )
      .join("");
    const encoder = new TextEncoder();
    const result = await runResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of fragmented ? Array.from(body) : [body]) {
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    expect(result.stopReason).toBe("stop");
    expect(
      result.content.filter((block) => block.type === "text").map((block) => block.text),
    ).toEqual(["Hello world"]);
  });

  it.each([false, true])("handles an undelimited EOF event (malformed=%s)", async (malformed) => {
    const body = (await createAnthropicResponse(anthropicEvents).text()).trimEnd();
    const result = await runResponse(
      new Response(malformed ? body.slice(0, -1) : body, {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    expect(result.stopReason).toBe(malformed ? "error" : "stop");
    if (malformed) {
      expect(result.errorMessage).toContain("malformed_streaming_fragment");
    }
  });

  it("consumes complete CR frames before requesting more input", async () => {
    const prefix = (await createAnthropicResponse(anthropicEvents.slice(0, -2)).text()).replaceAll(
      "\n",
      "\r",
    );
    const terminal = (await createAnthropicResponse(anthropicEvents.slice(-2)).text()).replaceAll(
      "\n",
      "\r",
    );
    const encoder = new TextEncoder();
    const controller = new AbortController();
    const activity = vi.fn();
    const unsubscribe = onLlmRequestActivity(controller.signal, activity);
    let pulls = 0;
    let consumedBeforeNextRead = 0;
    try {
      const result = await runResponse(
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(source) {
                if (pulls++ === 0) {
                  source.enqueue(encoder.encode(prefix));
                } else {
                  consumedBeforeNextRead = activity.mock.calls.length;
                  source.enqueue(encoder.encode(terminal));
                  source.close();
                }
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-type": "text/event-stream" } },
        ),
        controller.signal,
      );
      expect(consumedBeforeNextRead).toBe(8);
      expect(result.stopReason).toBe("stop");
    } finally {
      unsubscribe();
    }
  });
});
