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

  it("keeps only the latest proven assistant round and adds Copilot headers", () => {
    const longReasoningId = Buffer.from(`reasoning-${"x".repeat(320)}`).toString("base64");
    const messageId = Buffer.from(`message-${"y".repeat(24)}`).toString("base64");
    const payloads: Array<{ input: Array<Record<string, unknown>> }> = [];
    const baseStreamFn = vi.fn((_model, _context, options) => {
      const payload = {
        input: [
          {
            id: "rs_old",
            type: "reasoning",
            encrypted_content: "old-ciphertext",
            summary: [],
          },
          { id: "msg_old", type: "message", role: "assistant", content: [] },
          { type: "message", role: "user", content: [] },
          {
            id: longReasoningId,
            type: "reasoning",
            encrypted_content: "current-ciphertext",
            summary: [],
          },
          { id: messageId, type: "message", role: "assistant", content: [] },
          {
            id: "fc_local",
            type: "function_call",
            call_id: "call_1",
            name: "lookup",
            arguments: "{}",
          },
          { type: "function_call_output", call_id: "call_1", output: "done" },
        ],
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return { async *[Symbol.asyncIterator]() {} } as never;
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

    void wrapped(
      {
        provider: "github-copilot",
        api: "openai-responses",
        id: "gpt-5.4",
      } as never,
      { messages } as never,
      { headers: { "X-Test": "1" } },
    );

    const options = requireFirstStreamOptions(baseStreamFn, "Copilot Responses stream");
    expect(options.headers).toEqual({
      ...buildCopilotDynamicHeaders({ messages, hasImages: true }),
      "X-Test": "1",
    });
    const input = payloads[0]?.input ?? [];
    const currentReasoning = input.find((item) => item.type === "reasoning");
    const assistantMessageIds = input
      .filter((item) => item.type === "message" && item.role === "assistant")
      .map((item) => item.id)
      .filter((id): id is string => typeof id === "string");
    expect(input.some((item) => item.id === "rs_old")).toBe(false);
    expect(assistantMessageIds).toEqual([expect.stringMatching(/^msg_[a-f0-9]{16}$/)]);
    expect(currentReasoning).toMatchObject({
      type: "reasoning",
      encrypted_content: "current-ciphertext",
    });
    expect(currentReasoning).not.toHaveProperty("id");
  });

  it("allows an existing hook to clone approved encrypted reasoning", async () => {
    let returnedPayload: unknown;
    const baseStreamFn = vi.fn(async (_model, _context, options) => {
      const payload = {
        input: [
          { type: "message", role: "user", content: [] },
          {
            id: "rs_approved",
            type: "reasoning",
            encrypted_content: "approved-ciphertext",
            summary: [],
          },
          {
            id: "fc_local",
            type: "function_call",
            call_id: "call_1",
            name: "lookup",
            arguments: "{}",
          },
          { type: "function_call_output", call_id: "call_1", output: "done" },
        ],
      } as never;
      returnedPayload = await options?.onPayload?.(payload, _model);
      return { async *[Symbol.asyncIterator]() {} } as never;
    });

    const wrapped = requireStreamFn(wrapCopilotOpenAIResponsesStream(baseStreamFn));

    await wrapped(
      {
        provider: "github-copilot",
        api: "openai-responses",
        id: "gpt-5.4",
      } as never,
      { messages: [{ role: "user", content: "hi" }] } as never,
      {
        onPayload: async (payload: unknown) => structuredClone(payload as Record<string, unknown>),
      } as never,
    );

    const input = (returnedPayload as { input: Array<Record<string, unknown>> }).input;
    expect(input.filter((item) => item.type === "reasoning")).toEqual([
      expect.objectContaining({
        id: "rs_approved",
        encrypted_content: "approved-ciphertext",
      }),
    ]);
  });

  it("rejects encrypted reasoning injected by an in-place payload hook", () => {
    let sentPayload: { input: Array<Record<string, unknown>> } | undefined;
    const baseStreamFn = vi.fn((_model, _context, options) => {
      const payload = {
        input: [
          { type: "message", role: "user", content: [] },
          {
            id: "rs_approved",
            type: "reasoning",
            encrypted_content: "approved-ciphertext",
            summary: [],
          },
          {
            id: "fc_local",
            type: "function_call",
            call_id: "call_1",
            name: "lookup",
            arguments: "{}",
          },
          { type: "function_call_output", call_id: "call_1", output: "done" },
        ],
      };
      options?.onPayload?.(payload, _model);
      sentPayload = payload;
      return { async *[Symbol.asyncIterator]() {} } as never;
    });
    const wrapped = requireStreamFn(wrapCopilotOpenAIResponsesStream(baseStreamFn));

    void wrapped(
      {
        provider: "github-copilot",
        api: "openai-responses",
        id: "gpt-5.4",
      } as never,
      { messages: [{ role: "user", content: "hi" }] } as never,
      {
        onPayload: (payload: unknown) => {
          const input = (payload as { input: Array<Record<string, unknown>> }).input;
          input.splice(2, 0, {
            id: "rs_injected",
            type: "reasoning",
            encrypted_content: "injected-ciphertext",
            summary: [],
          });
        },
      } as never,
    );

    expect(sentPayload?.input.filter((item) => item.type === "reasoning")).toEqual([
      expect.objectContaining({
        id: "rs_approved",
        encrypted_content: "approved-ciphertext",
      }),
    ]);
  });

  it("does not replay provider-rejected reasoning on later tool continuations", () => {
    const connectionBoundReasoningId = Buffer.from(`reasoning-${"x".repeat(320)}`).toString(
      "base64",
    );
    const sentPayloads: Array<{ input: Array<Record<string, unknown>> }> = [];
    let call = 0;
    const baseStreamFn = vi.fn((_model, _context, options) => {
      const payload =
        call === 0
          ? {
              input: [
                { type: "message", role: "user", content: [] },
                {
                  id: connectionBoundReasoningId,
                  type: "reasoning",
                  encrypted_content: "rejected-ciphertext",
                  summary: [],
                },
                {
                  id: "fc_1",
                  type: "function_call",
                  call_id: "call_1",
                  name: "lookup",
                  arguments: "{}",
                },
                { type: "function_call_output", call_id: "call_1", output: "one" },
              ],
            }
          : {
              input: [
                { type: "message", role: "user", content: [] },
                {
                  id: connectionBoundReasoningId,
                  type: "reasoning",
                  encrypted_content: "rejected-ciphertext",
                  summary: [],
                },
                {
                  id: "fc_1",
                  type: "function_call",
                  call_id: "call_1",
                  name: "lookup",
                  arguments: "{}",
                },
                { type: "function_call_output", call_id: "call_1", output: "one" },
                {
                  id: "rs_current",
                  type: "reasoning",
                  encrypted_content: "current-ciphertext",
                  summary: [],
                },
                {
                  id: "fc_2",
                  type: "function_call",
                  call_id: "call_2",
                  name: "lookup",
                  arguments: "{}",
                },
                { type: "function_call_output", call_id: "call_2", output: "two" },
              ],
            };
      options?.onPayload?.(payload, _model);
      sentPayloads.push(payload);
      if (call === 0) {
        (
          options as typeof options & {
            onEncryptedReplayRejected?: (request: unknown) => void;
          }
        )?.onEncryptedReplayRejected?.(payload);
      }
      call += 1;
      return { async *[Symbol.asyncIterator]() {} } as never;
    });
    const wrapped = requireStreamFn(wrapCopilotOpenAIResponsesStream(baseStreamFn));
    const context = {
      messages: [{ role: "toolResult", content: [{ type: "text", text: "done" }] }],
    } as never;

    void wrapped(
      { provider: "github-copilot", api: "openai-responses", id: "gpt-5.4" } as never,
      context,
      { sessionId: "session-1" } as never,
    );
    void wrapped(
      { provider: "github-copilot", api: "openai-responses", id: "gpt-5.4" } as never,
      context,
      { sessionId: "session-1" } as never,
    );

    expect(sentPayloads[0]?.input.filter((item) => item.type === "reasoning")).toHaveLength(1);
    expect(sentPayloads[1]?.input.filter((item) => item.type === "reasoning")).toEqual([
      expect.objectContaining({
        id: "rs_current",
        encrypted_content: "current-ciphertext",
      }),
    ]);
  });

  it("fails closed when one session exceeds the rejected-reasoning bound", () => {
    const sentPayloads: Array<{ input: Array<Record<string, unknown>> }> = [];
    let call = 0;
    const baseStreamFn = vi.fn((_model, _context, options) => {
      const payload = {
        input: [
          { type: "message", role: "user", content: [] },
          ...(call === 0
            ? Array.from({ length: 129 }, (_, index) => ({
                id: `rs_rejected_${index}`,
                type: "reasoning",
                encrypted_content: `ciphertext-${index}`,
                summary: [],
              }))
            : [
                {
                  id: "rs_current",
                  type: "reasoning",
                  encrypted_content: "current-ciphertext",
                  summary: [],
                },
              ]),
          {
            id: `fc_${call}`,
            type: "function_call",
            call_id: `call_${call}`,
            name: "lookup",
            arguments: "{}",
          },
          { type: "function_call_output", call_id: `call_${call}`, output: "done" },
        ],
      };
      options?.onPayload?.(payload, _model);
      sentPayloads.push(payload);
      if (call === 0) {
        (
          options as typeof options & {
            onEncryptedReplayRejected?: (request: unknown) => void;
          }
        )?.onEncryptedReplayRejected?.(payload);
      }
      call += 1;
      return { async *[Symbol.asyncIterator]() {} } as never;
    });
    const wrapped = requireStreamFn(wrapCopilotOpenAIResponsesStream(baseStreamFn));
    const model = {
      provider: "github-copilot",
      api: "openai-responses",
      id: "gpt-5.4",
    } as never;
    const context = {
      messages: [{ role: "toolResult", content: [{ type: "text", text: "done" }] }],
    } as never;

    void wrapped(model, context, { sessionId: "session-overflow" } as never);
    void wrapped(model, context, { sessionId: "session-overflow" } as never);

    expect(sentPayloads[0]?.input.filter((item) => item.type === "reasoning")).toHaveLength(129);
    expect(sentPayloads[1]?.input.some((item) => item.type === "reasoning")).toBe(false);
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
