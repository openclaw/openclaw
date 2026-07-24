// Github Copilot tests cover stream plugin behavior.
import type { Context } from "openclaw/plugin-sdk/llm";
import { buildCopilotIdeHeaders, COPILOT_INTEGRATION_ID } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it, vi } from "vitest";
import { wrapCopilotAnthropicStream, wrapCopilotProviderStream } from "./stream.js";

type ResponsesTestPayload = { input: Array<Record<string, unknown>> };

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

function buildExpectedCopilotHeaders(
  initiator: "agent" | "user",
  hasImages: boolean,
): Record<string, string> {
  return {
    ...buildCopilotIdeHeaders(),
    "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
    "Openai-Organization": "github-copilot",
    "x-initiator": initiator,
    ...(hasImages ? { "Copilot-Vision-Request": "true" } : {}),
  };
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
    ] as Context["messages"];
    const context = { messages };
    const expectedCopilotHeaders = buildExpectedCopilotHeaders("user", true);
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
    const messageId = Buffer.from(`message-${"y".repeat(24)}`).toString("base64");
    const payloads: ResponsesTestPayload[] = [];
    const baseStreamFn = vi.fn((_model, _context, options) => {
      const payload = {
        input: [
          { id: "rs_active", type: "reasoning", encrypted_content: "native-encrypted" },
          { type: "reasoning", status: null, encrypted_content: "idless-encrypted", summary: [] },
          { id: reasoningId, type: "reasoning", encrypted_content: "valid-encrypted-payload" },
          {
            id: "thinking_0",
            type: "reasoning",
            encrypted_content: "invalid-encrypted-payload",
            summary: [],
          },
          { id: "msg_signed", type: "message", role: "assistant" },
          { id: messageId, type: "message" },
        ],
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {
        async *[Symbol.asyncIterator]() {},
      } as never;
    });

    const wrapped = requireStreamFn(wrapCopilotProviderStream({ streamFn: baseStreamFn } as never));
    const messages = [
      {
        role: "toolResult",
        content: [
          { type: "text", text: "look" },
          { type: "image", image: "data:image/png;base64,abc" },
        ],
      },
    ] as Context["messages"];
    const expectedCopilotHeaders = buildExpectedCopilotHeaders("agent", true);

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
    expect(payloads[0]?.input[0]?.id).toBe("rs_active");
    expect(payloads[0]?.input.map((item) => item.type)).toEqual([
      "reasoning",
      "reasoning",
      "reasoning",
      "message",
      "message",
    ]);
    expect(payloads[0]?.input[1]?.id).toBeUndefined();
    expect(payloads[0]?.input[2]?.id).toBeUndefined();
    expect(payloads[0]?.input[3]?.id).toBeUndefined();
    expect(payloads[0]?.input[4]?.id).toMatch(/^msg_[a-f0-9]{16}$/);
    expect(payloads[0]?.input.slice(0, 3).every((item) => item.encrypted_content)).toBe(true);
  });

  it("sanitizes all sync and async Copilot Responses hook outcomes", async () => {
    const model = {
      provider: "github-copilot",
      api: "openai-responses",
      id: "gpt-5.4",
    } as never;
    const context = { messages: [{ role: "user", content: "hi" }] } as never;

    for (const asyncHook of [false, true]) {
      for (const replace of [false, true]) {
        const connectionBoundId = Buffer.from(`message-${"y".repeat(24)}`).toString("base64");
        let originalPayload: ResponsesTestPayload = { input: [] };
        let hookResult: unknown;
        const baseStreamFn = vi.fn((_model, _context, options) => {
          originalPayload = { input: [] };
          hookResult = options?.onPayload?.(originalPayload, _model);
          return {
            async *[Symbol.asyncIterator]() {},
          } as never;
        });

        const wrapped = requireStreamFn(
          wrapCopilotProviderStream({ streamFn: baseStreamFn } as never),
        );
        const mutatePayload = (payload: ResponsesTestPayload) => {
          const target: ResponsesTestPayload = replace ? { input: [] } : payload;
          target.input.push({ id: connectionBoundId, type: "message" });
          return replace ? target : undefined;
        };
        const onPayload = asyncHook
          ? async (payload: ResponsesTestPayload) => mutatePayload(payload)
          : (payload: ResponsesTestPayload) => mutatePayload(payload);

        void wrapped(model, context, { onPayload } as never);

        expect(hookResult instanceof Promise).toBe(asyncHook);
        const replacement = await hookResult;
        expect(replacement !== undefined).toBe(replace);
        const returnedPayload = (replacement ?? originalPayload) as ResponsesTestPayload;
        expect(returnedPayload.input[0]?.id).toMatch(/^msg_[a-f0-9]{16}$/);
      }
    }
  });

  it("adds Copilot headers for Chat Completions models", () => {
    const baseStreamFn = vi.fn(() => ({ async *[Symbol.asyncIterator]() {} }) as never);
    const wrapped = requireStreamFn(wrapCopilotProviderStream({ streamFn: baseStreamFn } as never));
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", data: "abc", mimeType: "image/png" },
        ],
      },
    ] as Context["messages"];
    const expectedCopilotHeaders = buildExpectedCopilotHeaders("user", true);

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

  it("does not claim provider transport before OpenClaw chooses one", () => {
    expect(
      wrapCopilotProviderStream({
        streamFn: undefined,
      } as never),
    ).toBeUndefined();
  });
});
