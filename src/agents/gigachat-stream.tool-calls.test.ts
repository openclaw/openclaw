import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

let initialAccessToken: { access_token: string } | undefined = { access_token: "test-token" };
let refreshedAccessToken = "refreshed-token";
const updateToken = vi.fn(async function (this: { _accessToken?: { access_token: string } }) {
  this._accessToken = { access_token: refreshedAccessToken };
});
const request = vi.fn();
const clientConfigs: Array<Record<string, unknown>> = [];

vi.mock("gigachat", () => {
  class MockGigaChat {
    _client = { request };
    _accessToken = initialAccessToken ? { ...initialAccessToken } : undefined;

    updateToken = updateToken;
    resetToken() {
      this._accessToken = undefined;
    }

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

function createSseByteStream(chunks: Buffer[]): Readable {
  return Readable.from(chunks);
}

describe("createGigachatStreamFn tool calling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientConfigs.length = 0;
    initialAccessToken = { access_token: "test-token" };
    refreshedAccessToken = "refreshed-token";
    vi.unstubAllEnvs();
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

    const stream = await streamFn(
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

    expect(updateToken).not.toHaveBeenCalled();
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

  it("preserves multibyte UTF-8 tool arguments split across stream chunks", async () => {
    const toolNameLine = Buffer.from(
      'data: {"choices":[{"delta":{"function_call":{"name":"llm_task"}}}]}\n',
      "utf8",
    );
    const argsLine = Buffer.from(
      'data: {"choices":[{"delta":{"function_call":{"arguments":"{\\"prompt\\":\\"привет\\"}"}}}]}\n',
      "utf8",
    );
    const splitAt = argsLine.indexOf("привет", 0, "utf8") + 1;

    request.mockResolvedValueOnce({
      status: 200,
      data: createSseByteStream([
        toolNameLine,
        argsLine.subarray(0, splitAt),
        argsLine.subarray(splitAt),
        Buffer.from("data: [DONE]\n", "utf8"),
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

    expect(event.content).toEqual([
      expect.objectContaining({
        type: "toolCall",
        name: "llm-task",
        arguments: { prompt: "привет" },
      }),
    ]);
  });

  it("preserves every streamed function call from a single assistant turn", async () => {
    request.mockResolvedValueOnce({
      status: 200,
      data: createSseStream([
        'data: {"choices":[{"delta":{"function_call":{"name":"llm_"}}}]}',
        'data: {"choices":[{"delta":{"function_call":{"name":"task"}}}]}',
        'data: {"choices":[{"delta":{"function_call":{"arguments":"{\\"prompt\\":\\"first\\"}"}},"finish_reason":"function_call"}]}',
        'data: {"choices":[{"delta":{"function_call":{"name":"__gpt2giga_user_search_web"}}}]}',
        'data: {"choices":[{"delta":{"function_call":{"arguments":"{\\"query\\":\\"second\\"}"}}}]}',
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

    expect(event.stopReason).toBe("toolUse");
    expect(event.content).toEqual([
      expect.objectContaining({
        type: "toolCall",
        name: "llm-task",
        arguments: { prompt: "first" },
      }),
      expect.objectContaining({
        type: "toolCall",
        name: "web_search",
        arguments: { query: "second" },
      }),
    ]);
  });

  it("rehydrates nested JSON-string tool arguments before dispatching them", async () => {
    const interactivePayload = {
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Approve", value: "approve" }],
        },
      ],
    };
    const argumentPayload = JSON.stringify({
      message: "Pick one",
      interactive: JSON.stringify(interactivePayload),
    });

    request.mockResolvedValueOnce({
      status: 200,
      data: createSseStream([
        `data: ${JSON.stringify({
          choices: [{ delta: { function_call: { name: "message", arguments: argumentPayload } } }],
        })}`,
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
          {
            name: "message",
            description: "Send a message",
            parameters: {
              type: "object",
              properties: {
                message: { type: "string" },
                interactive: {
                  type: "object",
                  properties: {
                    blocks: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          type: { type: "string" },
                          buttons: {
                            type: "array",
                            items: {
                              type: "object",
                              properties: {
                                label: { type: "string" },
                                value: { type: "string" },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      } as never,
      { apiKey: "token" } as never,
    );

    const event = await stream.result();

    expect(event.stopReason).toBe("toolUse");
    expect(event.content).toEqual([
      expect.objectContaining({
        type: "toolCall",
        name: "message",
        arguments: {
          message: "Pick one",
          interactive: interactivePayload,
        },
      }),
    ]);
  });

  it("parses a final SSE frame even when the stream closes without a trailing newline", async () => {
    request.mockResolvedValueOnce({
      status: 200,
      data: createSseByteStream([
        Buffer.from('data: {"choices":[{"delta":{"content":"final tail"}}]}', "utf8"),
      ]),
    });

    const streamFn = createGigachatStreamFn({
      baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
      authMode: "oauth",
    });

    const stream = await streamFn(
      { api: "gigachat", provider: "gigachat", id: "GigaChat-2-Max" } as never,
      { messages: [], tools: [] } as never,
      { apiKey: "token" } as never,
    );

    const event = await stream.result();

    expect(event.content).toEqual([{ type: "text", text: "final tail" }]);
  });

  it("reuses a cached token across turns for the same GigaChat credentials", async () => {
    initialAccessToken = undefined;
    refreshedAccessToken = "cached-after-refresh";
    request
      .mockResolvedValueOnce({
        status: 200,
        data: createSseStream([
          'data: {"choices":[{"delta":{"content":"first"}}]}',
          "data: [DONE]",
        ]),
      })
      .mockResolvedValueOnce({
        status: 200,
        data: createSseStream([
          'data: {"choices":[{"delta":{"content":"second"}}]}',
          "data: [DONE]",
        ]),
      });

    const streamFn = createGigachatStreamFn({
      baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
      authMode: "oauth",
    });

    const firstStream = await streamFn(
      { api: "gigachat", provider: "gigachat", id: "GigaChat-2-Max" } as never,
      { messages: [], tools: [] } as never,
      { apiKey: "token" } as never,
    );
    await expect(firstStream.result()).resolves.toMatchObject({
      content: [{ type: "text", text: "first" }],
    });

    const secondStream = await streamFn(
      { api: "gigachat", provider: "gigachat", id: "GigaChat-2-Max" } as never,
      { messages: [], tools: [] } as never,
      { apiKey: "token" } as never,
    );
    await expect(secondStream.result()).resolves.toMatchObject({
      content: [{ type: "text", text: "second" }],
    });

    expect(updateToken).toHaveBeenCalledTimes(1);
    expect(clientConfigs).toHaveLength(1);
    expect(request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer cached-after-refresh",
        }),
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer cached-after-refresh",
        }),
      }),
    );
  });

  it("refreshes once and retries the chat request after a 401", async () => {
    refreshedAccessToken = "fresh-token";
    request
      .mockResolvedValueOnce({
        status: 401,
        data: "expired token",
      })
      .mockResolvedValueOnce({
        status: 200,
        data: createSseStream([
          'data: {"choices":[{"delta":{"content":"recovered"}}]}',
          "data: [DONE]",
        ]),
      });

    const streamFn = createGigachatStreamFn({
      baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
      authMode: "oauth",
    });

    const stream = await streamFn(
      { api: "gigachat", provider: "gigachat", id: "GigaChat-2-Max" } as never,
      { messages: [], tools: [] } as never,
      { apiKey: "token" } as never,
    );

    await expect(stream.result()).resolves.toMatchObject({
      content: [{ type: "text", text: "recovered" }],
    });

    expect(updateToken).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer fresh-token",
        }),
      }),
    );
  });

  it("prefers the resolved GigaChat baseUrl over the env override", async () => {
    vi.stubEnv("GIGACHAT_BASE_URL", "https://env-host.example/api/v1");
    request.mockResolvedValueOnce({
      status: 200,
      data: createSseStream(['data: {"choices":[{"delta":{"content":"done"}}]}', "data: [DONE]"]),
    });

    const streamFn = createGigachatStreamFn({
      baseUrl: "https://resolved-host.example/api/v1",
      authMode: "oauth",
    });

    const stream = await streamFn(
      { api: "gigachat", provider: "gigachat", id: "GigaChat-2-Max" } as never,
      { messages: [], tools: [] } as never,
      { apiKey: "token" } as never,
    );

    const event = await stream.result();

    expect(event.content).toEqual([{ type: "text", text: "done" }]);
    expect(clientConfigs).toHaveLength(1);
    expect(clientConfigs[0]?.baseUrl).toBe("https://resolved-host.example/api/v1");
  });

  it("forwards resolved model headers and caller headers on the custom transport", async () => {
    request.mockResolvedValueOnce({
      status: 200,
      data: createSseStream(['data: {"choices":[{"delta":{"content":"done"}}]}', "data: [DONE]"]),
    });

    const streamFn = createGigachatStreamFn({
      baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
      authMode: "oauth",
    });

    const stream = await streamFn(
      {
        api: "gigachat",
        provider: "gigachat",
        id: "GigaChat-2-Max",
        headers: {
          "X-Model-Header": "model-value",
        },
      } as never,
      { messages: [], tools: [] } as never,
      {
        apiKey: "token",
        headers: {
          "X-Caller-Header": "caller-value",
        },
      } as never,
    );

    const event = await stream.result();

    expect(event.content).toEqual([{ type: "text", text: "done" }]);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          Accept: "text/event-stream",
          "X-Model-Header": "model-value",
          "X-Caller-Header": "caller-value",
        }),
      }),
    );
  });

  it("sanitizes historical assistant/tool result names and preserves structured JSON tool results", async () => {
    request.mockResolvedValueOnce({
      status: 200,
      data: createSseStream(['data: {"choices":[{"delta":{"content":"done"}}]}', "data: [DONE]"]),
    });

    const streamFn = createGigachatStreamFn({
      baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
      authMode: "oauth",
    });

    const stream = await streamFn(
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
            content: '{"summary":"He said “hi” — then left"}',
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
              content: '{"summary":"He said “hi” — then left"}',
            }),
          ],
        }),
      }),
    );
    expect(event.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("preserves exact Unicode punctuation in system, user, and assistant history text", async () => {
    request.mockResolvedValueOnce({
      status: 200,
      data: createSseStream(['data: {"choices":[{"delta":{"content":"done"}}]}', "data: [DONE]"]),
    });

    const systemPrompt = "Keep “curly quotes”, em dashes —, NBSP\u00A0gaps, and ellipses…";
    const userText = "User asked to preserve “exact” punctuation — including\u00A0spacing…";
    const assistantText = "Assistant replied with “quoted” text — unchanged\u00A0too…";

    const streamFn = createGigachatStreamFn({
      baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
      authMode: "oauth",
    });

    const stream = await streamFn(
      { api: "gigachat", provider: "gigachat", id: "GigaChat-2-Max" } as never,
      {
        systemPrompt,
        messages: [
          {
            role: "user",
            content: userText,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: assistantText }],
          },
        ],
        tools: [],
      } as never,
      { apiKey: "token" } as never,
    );

    await expect(stream.result()).resolves.toMatchObject({
      content: [{ type: "text", text: "done" }],
    });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          messages: [
            expect.objectContaining({ role: "system", content: systemPrompt }),
            expect.objectContaining({ role: "user", content: userText }),
            expect.objectContaining({ role: "assistant", content: assistantText }),
          ],
        }),
      }),
    );
  });

  it("preserves historical tool results as plain text when functions are disabled", async () => {
    vi.stubEnv("GIGACHAT_DISABLE_FUNCTIONS", "1");
    request.mockResolvedValueOnce({
      status: 200,
      data: createSseStream(['data: {"choices":[{"delta":{"content":"done"}}]}', "data: [DONE]"]),
    });

    const streamFn = createGigachatStreamFn({
      baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
      authMode: "oauth",
    });

    const stream = await streamFn(
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
            content: '{"summary":"tool output"}',
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

    await expect(stream.result()).resolves.toMatchObject({
      content: [{ type: "text", text: "done" }],
    });

    const requestPayload = request.mock.calls[0]?.[0]?.data as {
      messages?: Array<{ role: string; content?: string }>;
      functions?: unknown;
    };
    expect(requestPayload.functions).toBeUndefined();
    expect(requestPayload.messages).toEqual([
      expect.objectContaining({ role: "assistant", content: "[Called llm-task]" }),
      expect.objectContaining({
        role: "user",
        content: '[Tool Result: llm-task]\n{"summary":"tool output"}',
      }),
    ]);
  });

  it("downgrades mixed text and tool-call assistant turns when functions are disabled", async () => {
    vi.stubEnv("GIGACHAT_DISABLE_FUNCTIONS", "1");
    request.mockResolvedValueOnce({
      status: 200,
      data: createSseStream(['data: {"choices":[{"delta":{"content":"done"}}]}', "data: [DONE]"]),
    });

    const streamFn = createGigachatStreamFn({
      baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
      authMode: "oauth",
    });

    const stream = await streamFn(
      { api: "gigachat", provider: "gigachat", id: "GigaChat-2-Max" } as never,
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Thinking through it" },
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
            content: '{"summary":"tool output"}',
          },
        ],
        tools: [],
      } as never,
      { apiKey: "token" } as never,
    );

    await expect(stream.result()).resolves.toMatchObject({
      content: [{ type: "text", text: "done" }],
    });

    const requestPayload = request.mock.calls[0]?.[0]?.data as {
      messages?: Array<{ role: string; content?: string }>;
    };
    expect(requestPayload.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "Thinking through it\n\n[Called llm-task]",
      }),
      expect.objectContaining({
        role: "user",
        content: '[Tool Result: llm-task]\n{"summary":"tool output"}',
      }),
    ]);
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

    const stream = await streamFn(
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

    const stream = await streamFn(
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

    const stream = await streamFn(
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

  it("honors explicit basic auth scopes when metadata provides one", async () => {
    request.mockResolvedValueOnce({
      status: 200,
      data: createSseStream(['data: {"choices":[{"delta":{"content":"done"}}]}', "data: [DONE]"]),
    });

    const streamFn = createGigachatStreamFn({
      baseUrl: "https://gigachat.ift.sberdevices.ru/v1",
      authMode: "basic",
      scope: "GIGACHAT_API_B2B",
    });

    const stream = await streamFn(
      { api: "gigachat", provider: "gigachat", id: "GigaChat-2-Max" } as never,
      { messages: [], tools: [] } as never,
      { apiKey: "basic-user:basic-password" } as never,
    );

    await expect(stream.result()).resolves.toMatchObject({
      content: [{ type: "text", text: "done" }],
    });

    expect(clientConfigs).toHaveLength(1);
    expect(clientConfigs[0]).toMatchObject({
      user: "basic-user",
      password: "basic-password",
      scope: "GIGACHAT_API_B2B",
    });
    expect(clientConfigs[0]?.credentials).toBeUndefined();
  });

  it("falls back to the SDK default oauth scope when no metadata scope is available", async () => {
    request.mockResolvedValueOnce({
      status: 200,
      data: createSseStream(['data: {"choices":[{"delta":{"content":"done"}}]}', "data: [DONE]"]),
    });

    const streamFn = createGigachatStreamFn({
      baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
      authMode: "oauth",
    });

    const stream = await streamFn(
      { api: "gigachat", provider: "gigachat", id: "GigaChat-2-Max" } as never,
      { messages: [], tools: [] } as never,
      { apiKey: "oauth-credential" } as never,
    );

    await expect(stream.result()).resolves.toMatchObject({
      content: [{ type: "text", text: "done" }],
    });

    expect(clientConfigs).toHaveLength(1);
    expect(clientConfigs[0]?.credentials).toBe("oauth-credential");
    expect(clientConfigs[0]).not.toHaveProperty("scope");
  });

  it("runs outbound payload hooks before sending the chat request", async () => {
    request.mockResolvedValueOnce({
      status: 200,
      data: createSseStream(['data: {"choices":[{"delta":{"content":"done"}}]}', "data: [DONE]"]),
    });
    const onPayload = vi.fn((payload: unknown) => ({
      ...(payload as Record<string, unknown>),
      parallel_tool_calls: true,
    }));

    const streamFn = createGigachatStreamFn({
      baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
      authMode: "oauth",
    });

    const stream = await streamFn(
      { api: "gigachat", provider: "gigachat", id: "GigaChat-2-Max" } as never,
      { messages: [], tools: [] } as never,
      { apiKey: "token", onPayload } as never,
    );

    await expect(stream.result()).resolves.toMatchObject({
      content: [{ type: "text", text: "done" }],
    });

    expect(onPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "GigaChat-2-Max",
        stream: true,
      }),
      expect.objectContaining({
        id: "GigaChat-2-Max",
      }),
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          parallel_tool_calls: true,
          stream: true,
        }),
      }),
    );
  });
});
