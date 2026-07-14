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

  it("drops cold history, then preserves complete reasoning for an active session", () => {
    const longReasoningId = Buffer.from(`reasoning-${"x".repeat(320)}`).toString("base64");
    const payloads: Array<{ input: Array<Record<string, unknown>> }> = [];
    const baseStreamFn = vi.fn((_model, _context, options) => {
      const payload = {
        input: [
          {
            id: "rs_exact",
            type: "reasoning",
            encrypted_content: "exact-ciphertext",
            summary: [],
          },
          {
            id: longReasoningId,
            type: "reasoning",
            encrypted_content: "idless-ciphertext",
            summary: [],
          },
          {
            id: "thinking_0",
            type: "reasoning",
            encrypted_content: "foreign-ciphertext",
            summary: [],
          },
        ],
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return { async *[Symbol.asyncIterator]() {} } as never;
    });

    const createWrapped = () => requireStreamFn(wrapCopilotOpenAIResponsesStream(baseStreamFn));
    const messages = [
      {
        role: "toolResult",
        content: [
          { type: "text", text: "look" },
          { type: "image", image: "data:image/png;base64,abc" },
        ],
      },
    ] as Parameters<typeof buildCopilotDynamicHeaders>[0]["messages"];
    const model = {
      provider: "github-copilot",
      api: "openai-responses",
      id: "gpt-5.4",
    } as never;
    const context = { messages } as never;
    const streamOptions = {
      headers: { "X-Test": "1" },
      sessionId: "session-cold-then-active",
    };

    void createWrapped()(model, context, streamOptions);
    void createWrapped()(model, context, streamOptions);

    const receivedOptions = requireFirstStreamOptions(baseStreamFn, "Copilot Responses stream");
    expect(receivedOptions.headers).toEqual({
      ...buildCopilotDynamicHeaders({ messages, hasImages: true }),
      "X-Test": "1",
    });
    expect(payloads[0]?.input).toEqual([]);
    expect(payloads[1]?.input).toHaveLength(2);
    expect(payloads[1]?.input[0]).toMatchObject({
      id: "rs_exact",
      encrypted_content: "exact-ciphertext",
    });
    expect(payloads[1]?.input[1]).toMatchObject({
      encrypted_content: "idless-ciphertext",
    });
    expect(payloads[1]?.input[1]).not.toHaveProperty("id");
  });

  it("re-sanitizes payloads returned by an async hook", async () => {
    let returnedPayload: unknown;
    const baseStreamFn = vi.fn(async (_model, _context, options) => {
      returnedPayload = await options?.onPayload?.({ input: [] }, _model);
      return { async *[Symbol.asyncIterator]() {} } as never;
    });

    const createWrapped = () => requireStreamFn(wrapCopilotOpenAIResponsesStream(baseStreamFn));
    const model = {
      provider: "github-copilot",
      api: "openai-responses",
      id: "gpt-5.4",
    } as never;
    const context = { messages: [{ role: "user", content: "hi" }] } as never;
    const sessionId = "session-async-hook";

    await createWrapped()(model, context, {
      sessionId,
      onPayload: async () => ({ input: [] }),
    } as never);
    await createWrapped()(model, context, {
      sessionId,
      onPayload: async () => ({
        input: [
          {
            id: "rs_hook",
            type: "reasoning",
            encrypted_content: "hook-ciphertext",
            summary: [],
          },
          {
            id: "thinking_0",
            type: "reasoning",
            encrypted_content: "foreign-ciphertext",
            summary: [],
          },
        ],
      }),
    } as never);

    const input = (returnedPayload as { input: Array<Record<string, unknown>> }).input;
    expect(input).toEqual([
      expect.objectContaining({
        id: "rs_hook",
        encrypted_content: "hook-ciphertext",
      }),
    ]);
  });

  it("bounds active-session cold-resume state", () => {
    const sentPayloads: Array<{ input: Array<Record<string, unknown>> }> = [];
    const baseStreamFn = vi.fn((_model, _context, options) => {
      const payload = {
        input: [
          {
            id: "rs_current",
            type: "reasoning",
            encrypted_content: "current-ciphertext",
            summary: [],
          },
        ],
      };
      options?.onPayload?.(payload, _model);
      sentPayloads.push(payload);
      return { async *[Symbol.asyncIterator]() {} } as never;
    });
    const model = {
      provider: "github-copilot",
      api: "openai-responses",
      id: "gpt-5.4",
    } as never;
    const context = {
      messages: [{ role: "toolResult", content: [{ type: "text", text: "done" }] }],
    } as never;
    const invoke = (sessionId: string) => {
      const wrapped = requireStreamFn(wrapCopilotOpenAIResponsesStream(baseStreamFn));
      void wrapped(model, context, { sessionId } as never);
    };

    invoke("session-bounded-target");
    invoke("session-bounded-target");
    for (let index = 0; index < 32; index += 1) {
      invoke(`session-bounded-other-${index}`);
    }
    invoke("session-bounded-target");

    expect(sentPayloads[0]?.input).toEqual([]);
    expect(sentPayloads[1]?.input).toHaveLength(1);
    expect(sentPayloads.at(-1)?.input).toEqual([]);
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

  it("does not claim provider transport before OpenClaw chooses one", () => {
    expect(
      wrapCopilotProviderStream({
        streamFn: undefined,
      } as never),
    ).toBeUndefined();
  });
});
