import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const updateToken = vi.fn(async () => {});
const request = vi.fn();

vi.mock("gigachat", () => {
  class MockGigaChat {
    _client = { request };
    _accessToken = { access_token: "test-token" };

    updateToken = updateToken;
  }

  return { GigaChat: MockGigaChat };
});

import { createGigachatStreamFn } from "./gigachat-stream.js";

function createSseStream(lines: string[]): Readable {
  return Readable.from(lines.map((line) => `${line}\n`));
}

describe("GigaChat leaked function-call prelude cleanup", () => {
  it.each([
    "assistant function callrecipient{",
    "assistant function callweather{",
    "assistant function call recipient {",
  ])("drops leaked assistant text prelude %p when a function call is present", async (prelude) => {
    request.mockResolvedValueOnce({
      status: 200,
      data: createSseStream([
        `data: {"choices":[{"delta":{"content":"${prelude}","role":"assistant"},"index":0}]}`,
        'data: {"choices":[{"delta":{"content":"","role":"assistant","function_call":{"name":"message","arguments":"{\\"action\\":\\"send\\",\\"message\\":\\"hello\\"}"}},"index":0}]}',
        "data: [DONE]",
      ]),
    });

    const streamFn = createGigachatStreamFn({
      baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
      authMode: "oauth",
    });

    const stream = await streamFn(
      { api: "gigachat", provider: "gigachat", id: "GigaChat-2-Max" } as never,
      {
        messages: [],
        tools: [
          { name: "message", description: "send", parameters: { type: "object", properties: {} } },
        ],
      } as never,
      { apiKey: "token" } as never,
    );

    const event = await stream.result();

    expect(updateToken).not.toHaveBeenCalled();
    expect(event.stopReason).toBe("toolUse");
    expect(event.content).toEqual([
      expect.objectContaining({
        type: "toolCall",
        name: "message",
        arguments: { action: "send", message: "hello" },
      }),
    ]);
  });
});
