import { expect, it } from "vitest";
import { createMockServerTestHarness, postJson } from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();

it.each([
  { prompt: "Telegram unsent failure QA check.", stream: false, partialText: "" },
  { prompt: "Telegram unsent failure QA check.", stream: true, partialText: "" },
  {
    prompt: "Telegram visible partial failure QA check.",
    stream: true,
    partialText: "TELEGRAM-VISIBLE-PARTIAL-BEFORE-FAILURE",
  },
])(
  "preserves Anthropic failure for $prompt (stream=$stream)",
  async ({ prompt, stream, partialText }) => {
    const response = await postJson(await startMockServer(), "/v1/messages", {
      model: "qa-model",
      max_tokens: 256,
      stream,
      messages: [{ role: "user", content: prompt }],
    });
    const body = await response.text();
    const expectedError = { type: "api_error", message: expect.any(String) };
    if (stream) {
      expect(response.status).toBe(200);
      const events = body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)));
      expect(events.at(-1)).toMatchObject({ type: "error", error: expectedError });
      expect(body).not.toContain("event: message_stop");
      expect(body).not.toContain('"stop_reason":"end_turn"');
      expect(
        events
          .filter((event) => event.type === "content_block_delta")
          .map((event) => event.delta.text)
          .join(""),
      ).toBe(partialText);
    } else {
      expect(response.status).toBe(500);
      expect(JSON.parse(body)).toEqual({ type: "error", error: expectedError });
    }
  },
);
