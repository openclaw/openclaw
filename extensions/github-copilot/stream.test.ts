// Github Copilot tests cover stream plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { buildCopilotDynamicHeaders } from "./stream.js";
import {
  wrapCopilotAnthropicStream,
  wrapCopilotOpenAICompletionsStream,
  wrapCopilotOpenAIResponsesStream,
  wrapCopilotProviderStream,
} from "./stream.js";

function requireStreamFn(streamFn: ReturnType<typeof wrapCopilotProviderStream>) {
  expect(streamFn).toBeTypeOf("function");
  if (!streamFn) {
    throw new Error("expected stream fn");
  }
  return streamFn;
}

function requireFirstStreamOptions(mock: ReturnType<typeof vi.fn>, label: string) {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  const options = call[2];
  if (!options || typeof options !== "object") {
    throw new Error(`expected ${label} options`);
  }
  return options as { headers?: Record<string, unknown>; onPayload?: unknown };
}

const nativeResponsesModel = {
  provider: "github-copilot",
  api: "openai-responses",
  id: "gpt-5.5",
  compat: { nativeWebSearchTool: true },
};
const managedWebSearchTools = [{ type: "function", name: "web_search" }];
const codeModeTools = [
  { type: "function", name: "exec" },
  { type: "function", name: "wait" },
];

async function runCopilotProviderPayload(params: {
  payload: Record<string, unknown>;
  ctx?: Record<string, unknown>;
  model?: Record<string, unknown>;
  options?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  let finalPayload: unknown = params.payload;
  const baseStreamFn = vi.fn(async (model, _context, options) => {
    finalPayload = (await options?.onPayload?.(params.payload, model)) ?? params.payload;
    return { async *[Symbol.asyncIterator]() {} } as never;
  });
  const wrapped = requireStreamFn(
    wrapCopilotProviderStream({ streamFn: baseStreamFn, ...params.ctx } as never),
  );
  await wrapped(
    (params.model ?? nativeResponsesModel) as never,
    { messages: [{ role: "user", content: "hi" }] } as never,
    params.options as never,
  );
  return finalPayload as Record<string, unknown>;
}

describe("wrapCopilotAnthropicStream", () => {
  it("adds Copilot headers, strips thinking replay, and marks cache for Claude payloads", () => {
    const payloads: Array<{
      messages: Array<Record<string, unknown>>;
    }> = [];
    const baseStreamFn = vi.fn((model, _context, options) => {
      const payload = {
        messages: [
          { role: "system", content: "system prompt" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "draft", cache_control: { type: "ephemeral" } },
              { type: "redacted_thinking", data: "opaque" },
              { type: "text", text: "visible reply" },
            ],
          },
        ],
      };
      options?.onPayload?.(payload, model);
      payloads.push(payload);
      return {
        async *[Symbol.asyncIterator]() {},
      } as never;
    });

    const wrapped = requireStreamFn(wrapCopilotAnthropicStream(baseStreamFn));
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", image: "data:image/png;base64,abc" },
        ],
      },
    ] as Parameters<typeof buildCopilotDynamicHeaders>[0]["messages"];
    const context = { messages };
    const expectedCopilotHeaders = buildCopilotDynamicHeaders({
      messages,
      hasImages: true,
    });
    expect(expectedCopilotHeaders["Accept-Encoding"]).toBe("identity");

    void wrapped(
      {
        provider: "github-copilot",
        api: "anthropic-messages",
        id: "claude-sonnet-4.6",
      } as never,
      context as never,
      {
        headers: { "X-Test": "1" },
      },
    );

    expect(baseStreamFn).toHaveBeenCalledOnce();
    const options = requireFirstStreamOptions(baseStreamFn, "Copilot Anthropic stream");
    if (!options?.onPayload) {
      throw new Error("expected Copilot Anthropic stream options");
    }
    expect(options).toEqual({
      headers: {
        ...expectedCopilotHeaders,
        "X-Test": "1",
      },
      onPayload: options.onPayload,
    });
    expect(payloads[0]?.messages).toEqual([
      {
        role: "system",
        content: [{ type: "text", text: "system prompt", cache_control: { type: "ephemeral" } }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "visible reply" }],
      },
    ]);
  });

  it("keeps a non-empty assistant turn when Copilot replay only contains thinking", () => {
    const payloads: Array<{
      messages: Array<Record<string, unknown>>;
    }> = [];
    const baseStreamFn = vi.fn((model, _context, options) => {
      const payload = {
        messages: [
          { role: "user", content: "use the tool result" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "private" },
              { type: "redacted_thinking", data: "opaque" },
            ],
          },
          { role: "user", content: [{ type: "tool_result", content: "done" }] },
        ],
      };
      options?.onPayload?.(payload, model);
      payloads.push(payload);
      return {
        async *[Symbol.asyncIterator]() {},
      } as never;
    });

    const wrapped = requireStreamFn(wrapCopilotAnthropicStream(baseStreamFn));
    void wrapped(
      {
        provider: "github-copilot",
        api: "anthropic-messages",
        id: "claude-haiku-4.5",
      } as never,
      { messages: [{ role: "user", content: "hi" }] } as never,
      {},
    );

    expect(payloads[0]?.messages).toEqual([
      { role: "user", content: "use the tool result" },
      { role: "assistant", content: [{ type: "text", text: "[assistant reasoning omitted]" }] },
      { role: "user", content: [{ type: "tool_result", content: "done" }] },
    ]);
  });

  it("leaves non-Anthropic Copilot models untouched", () => {
    const baseStreamFn = vi.fn(() => ({ async *[Symbol.asyncIterator]() {} }) as never);
    const wrapped = requireStreamFn(wrapCopilotAnthropicStream(baseStreamFn));
    const model = {
      provider: "github-copilot",
      api: "openai-responses",
      id: "gpt-4.1",
    } as never;
    const context = { messages: [{ role: "user", content: "hi" }] } as never;
    const options = { headers: { Existing: "1" } };

    void wrapped(model, context, options as never);

    expect(baseStreamFn.mock.calls).toEqual([[model, context, options]]);
  });

  it("adds Copilot headers, sanitizes reasoning replay, and rewrites message IDs before payload send", () => {
    const reasoningId = Buffer.from(`reasoning-${"x".repeat(24)}`).toString("base64");
    const overlongReasoningId = `5PX6gLHXT5wE+Y2tPmUV4gn+${"B".repeat(384)}`;
    const messageId = Buffer.from(`message-${"y".repeat(24)}`).toString("base64");
    const payloads: Array<{ input: Array<Record<string, unknown>> }> = [];
    const baseStreamFn = vi.fn((_model, _context, options) => {
      const payload = {
        input: [
          { id: reasoningId, type: "reasoning", encrypted_content: "valid-encrypted-payload" },
          { type: "reasoning", encrypted_content: "idless-encrypted-payload", summary: [] },
          {
            id: overlongReasoningId,
            type: "reasoning",
            encrypted_content: "invalid-encrypted-payload",
            summary: [],
          },
          { id: messageId, type: "message" },
        ],
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {
        async *[Symbol.asyncIterator]() {},
      } as never;
    });

    const wrapped = requireStreamFn(wrapCopilotOpenAIResponsesStream(baseStreamFn));
    const messages = [
      {
        role: "toolResult",
        content: [
          { type: "text", text: "look" },
          { type: "image", image: "data:image/png;base64,abc" },
        ],
      },
    ] as Parameters<typeof buildCopilotDynamicHeaders>[0]["messages"];
    const expectedCopilotHeaders = buildCopilotDynamicHeaders({
      messages,
      hasImages: true,
    });

    void wrapped(
      {
        provider: "github-copilot",
        api: "openai-responses",
        id: "gpt-5.4",
      } as never,
      { messages } as never,
      { headers: { "X-Test": "1" } },
    );

    expect(baseStreamFn).toHaveBeenCalledOnce();
    const options = requireFirstStreamOptions(baseStreamFn, "Copilot Responses stream");
    if (!options?.onPayload) {
      throw new Error("expected Copilot Responses stream options");
    }
    expect(options).toEqual({
      headers: {
        ...expectedCopilotHeaders,
        "X-Test": "1",
      },
      onPayload: options.onPayload,
    });
    expect(payloads[0]?.input[0]?.id).toBe(reasoningId);
    expect(payloads[0]?.input.map((item) => item.type)).toEqual([
      "reasoning",
      "reasoning",
      "message",
    ]);
    expect(payloads[0]?.input[1]?.id).toBeUndefined();
    expect(payloads[0]?.input[2]?.id).toMatch(/^msg_[a-f0-9]{16}$/);
  });

  it("preserves Copilot payload invariants in replacement payloads", async () => {
    const connectionBoundId = Buffer.from(`message-${"y".repeat(24)}`).toString("base64");
    const returnedPayload = await runCopilotProviderPayload({
      payload: { input: [] },
      options: {
        onPayload: async () => ({
          input: [{ id: connectionBoundId, type: "message" }],
          tools: managedWebSearchTools,
        }),
      },
    });

    expect(returnedPayload).toMatchObject({
      input: [{ id: expect.stringMatching(/^msg_[a-f0-9]{16}$/) }],
      tools: [{ type: "web_search" }],
    });
  });

  it("does not restore native search after an outer hook filters the final payload", async () => {
    const returnedPayload = await runCopilotProviderPayload({
      payload: {
        reasoning: { effort: "minimal" },
        tools: managedWebSearchTools,
      },
      options: {
        openclawCodeModeToolSurface: true,
        onPayload: async (payload: unknown) => {
          const finalPayload = payload as Record<string, unknown>;
          finalPayload.tools = codeModeTools;
          return finalPayload;
        },
      },
    });

    expect(returnedPayload).toEqual({
      reasoning: { effort: "minimal" },
      tools: codeModeTools,
    });
  });

  it("adds Copilot headers for Chat Completions models", () => {
    const baseStreamFn = vi.fn(() => ({ async *[Symbol.asyncIterator]() {} }) as never);
    const wrapped = requireStreamFn(wrapCopilotOpenAICompletionsStream(baseStreamFn));
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", data: "abc", mimeType: "image/png" },
        ],
      },
    ] as Parameters<typeof buildCopilotDynamicHeaders>[0]["messages"];
    const expectedCopilotHeaders = buildCopilotDynamicHeaders({
      messages,
      hasImages: true,
    });

    void wrapped(
      {
        provider: "github-copilot",
        api: "openai-completions",
        id: "gemini-3.1-pro-preview",
      } as never,
      { messages } as never,
      { headers: { "X-Test": "1" } },
    );

    const options = requireFirstStreamOptions(baseStreamFn, "Copilot Chat Completions stream");
    expect(options).toEqual({
      headers: {
        ...expectedCopilotHeaders,
        "X-Test": "1",
      },
    });
  });

  it("adapts provider stream context without changing wrapper behavior", () => {
    const baseStreamFn = vi.fn(() => ({ async *[Symbol.asyncIterator]() {} }) as never);

    const wrapped = requireStreamFn(
      wrapCopilotProviderStream({
        streamFn: baseStreamFn,
      } as never),
    );

    void wrapped(
      {
        provider: "github-copilot",
        api: "openai-responses",
        id: "gpt-4.1",
      } as never,
      { messages: [{ role: "user", content: "hi" }] } as never,
      {},
    );

    expect(baseStreamFn).toHaveBeenCalledOnce();
  });

  it("keeps managed web search when native search is not eligible", async () => {
    const cases = [
      { ctx: { nativeWebSearchAllowedByToolPolicy: false } },
      { ctx: { config: { tools: { web: { search: { provider: "brave" } } } } } },
      { model: { provider: "github-copilot", api: "openai-responses", id: "gpt-future" } },
      { payload: { tools: [] } },
    ];
    const results = await Promise.all(
      cases.map(async (entry) => {
        const payload = entry.payload ?? { tools: managedWebSearchTools };
        return (await runCopilotProviderPayload({ ...entry, payload })).tools;
      }),
    );
    expect(results).toEqual([
      managedWebSearchTools,
      managedWebSearchTools,
      managedWebSearchTools,
      [],
    ]);
  });

  it("does not claim provider transport before OpenClaw chooses one", () => {
    expect(
      wrapCopilotProviderStream({
        streamFn: undefined,
      } as never),
    ).toBeUndefined();
  });
});
