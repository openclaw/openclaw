import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateToken = vi.fn(async () => {});
const request = vi.fn();
const clientConfigs: Array<Record<string, unknown>> = [];

vi.mock("gigachat", () => {
  class MockGigaChat {
    _client = { request };
    _accessToken = { access_token: "test-token" };

    updateToken = updateToken;

    constructor(config: Record<string, unknown>) {
      clientConfigs.push(config);
    }
  }

  return { GigaChat: MockGigaChat };
});

import { createGigachatStreamFn } from "./gigachat-stream.js";

function createSseStream(lines: string[]): Readable {
  return Readable.from(lines.map((line) => `${line}\n`));
}

describe("createGigachatStreamFn tool calling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientConfigs.length = 0;
  });

  it("round-trips sanitized tool names for streamed function calls", async () => {
    request.mockResolvedValueOnce({
      status: 200,
      data: createSseStream([
        'data: {"choices":[{"delta":{"function_call":{"name":"llm_task"}}}]}',
        'data: {"choices":[{"delta":{"function_call":{"arguments":"{\\"prompt\\":\\"hi\\"}"}}}]}',
        "data: [DONE]",
      ]),
    });

    const streamFn = createGigachatStreamFn({
      baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
      authMode: "oauth",
    });

    const stream = streamFn(
      { api: "gigachat", provider: "gigachat", id: "GigaChat-2-Max" } as never,
      {
        messages: [],
        tools: [
          {
            name: "llm-task",
            description: "Run a task",
            parameters: {
              type: "object",
              properties: {
                prompt: { type: "string" },
              },
            },
          },
        ],
      } as never,
      { apiKey: "token" } as never,
    );

    const event = await stream.result();

    expect(updateToken).toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          functions: [
            expect.objectContaining({
              name: "llm_task",
            }),
          ],
        }),
      }),
    );
    expect(event.role).toBe("assistant");
    expect(event.stopReason).toBe("toolUse");
    expect(event.content).toEqual([
      expect.objectContaining({
        type: "toolCall",
        name: "llm-task",
        arguments: { prompt: "hi" },
      }),
    ]);
  });

  it("sanitizes historical assistant/tool result names in the outbound request", async () => {
    request.mockResolvedValueOnce({
      status: 200,
      data: createSseStream(['data: {"choices":[{"delta":{"content":"done"}}]}', "data: [DONE]"]),
    });

    const streamFn = createGigachatStreamFn({
      baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
      authMode: "oauth",
    });

    const stream = streamFn(
      { api: "gigachat", provider: "gigachat", id: "GigaChat-2-Max" } as never,
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "llm-task",
                arguments: { prompt: "hi" },
              },
            ],
          },
          {
            role: "toolResult",
            toolName: "llm-task",
            content: "ok",
          },
        ],
        tools: [
          {
            name: "llm-task",
            description: "Run a task",
            parameters: {
              type: "object",
              properties: {
                prompt: { type: "string" },
              },
            },
          },
        ],
      } as never,
      { apiKey: "token" } as never,
    );

    const event = await stream.result();

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          messages: [
            expect.objectContaining({
              role: "assistant",
              function_call: expect.objectContaining({ name: "llm_task" }),
            }),
            expect.objectContaining({
              role: "function",
              name: "llm_task",
            }),
          ],
        }),
      }),
    );
    expect(event.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("preserves all historical tool calls from a single assistant turn", async () => {
    request.mockResolvedValueOnce({
      status: 200,
      data: createSseStream(['data: {"choices":[{"delta":{"content":"done"}}]}', "data: [DONE]"]),
    });
    const streamFn = createGigachatStreamFn({
      baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
      authMode: "oauth",
    });

    const stream = streamFn(
      { api: "gigachat", provider: "gigachat", id: "GigaChat-2-Max" } as never,
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Working on it" },
              {
                type: "toolCall",
                id: "call_1",
                name: "llm-task",
                arguments: { prompt: "first" },
              },
              {
                type: "toolCall",
                id: "call_2",
                name: "web_search",
                arguments: { query: "second" },
              },
            ],
          },
        ],
        tools: [
          {
            name: "llm-task",
            description: "Run a task",
            parameters: {
              type: "object",
              properties: {
                prompt: { type: "string" },
              },
            },
          },
          {
            name: "web_search",
            description: "Search the web",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
            },
          },
        ],
      } as never,
      { apiKey: "token" } as never,
    );

    const event = await stream.result();

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          messages: [
            expect.objectContaining({
              role: "assistant",
              content: "Working on it",
              function_call: expect.objectContaining({ name: "llm_task" }),
            }),
            expect.objectContaining({
              role: "assistant",
              content: "",
              function_call: expect.objectContaining({ name: "gpt2giga_user_search_web" }),
            }),
          ],
        }),
      }),
    );
    expect(event.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("rejects tool-name sanitization collisions before sending the request", async () => {
    const streamFn = createGigachatStreamFn({
      baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
      authMode: "oauth",
    });

    const stream = streamFn(
      { api: "gigachat", provider: "gigachat", id: "GigaChat-2-Max" } as never,
      {
        messages: [],
        tools: [
          {
            name: "llm-task",
            description: "Run a task",
            parameters: { type: "object", properties: {} },
          },
          {
            name: "llm_task",
            description: "Run another task",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as never,
      { apiKey: "token" } as never,
    );

    const event = await stream.result();

    expect(event.stopReason).toBe("error");
    expect(event.errorMessage).toBe(
      'GigaChat tool name collision after sanitization: "llm_task" and "llm-task" both map to "llm_task"',
    );
    expect(event.content).toEqual([]);
    expect(updateToken).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("honors oauth auth mode even when credentials contain a colon", async () => {
    request.mockResolvedValueOnce({
      status: 200,
      data: createSseStream(['data: {"choices":[{"delta":{"content":"done"}}]}', "data: [DONE]"]),
    });

    const streamFn = createGigachatStreamFn({
      baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
      authMode: "oauth",
      scope: "GIGACHAT_API_PERS",
    });

    const stream = streamFn(
      { api: "gigachat", provider: "gigachat", id: "GigaChat-2-Max" } as never,
      {
        messages: [],
        tools: [],
      } as never,
      { apiKey: "oauth:credential:with:colon" } as never,
    );

    const event = await stream.result();

    expect(event.content).toEqual([{ type: "text", text: "done" }]);
    expect(clientConfigs).toHaveLength(1);
    expect(clientConfigs[0]).toMatchObject({
      credentials: "oauth:credential:with:colon",
      scope: "GIGACHAT_API_PERS",
    });
    expect(clientConfigs[0]?.user).toBeUndefined();
    expect(clientConfigs[0]?.password).toBeUndefined();
  });
});
