import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createMinimaxFastModeWrapper,
  createMinimaxReasoningContentTextWrapper,
  createMinimaxThinkingDisabledWrapper,
} from "./minimax-stream-wrappers.js";

function captureThinkingPayload(params: {
  provider: string;
  api: string;
  modelId: string;
}): unknown {
  let capturedThinking: unknown = undefined;
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    const payload: Record<string, unknown> = {};
    options?.onPayload?.(payload, _model);
    capturedThinking = payload.thinking;
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = createMinimaxThinkingDisabledWrapper(baseStreamFn);
  void wrapped(
    {
      api: params.api,
      provider: params.provider,
      id: params.modelId,
    } as Model<"anthropic-messages">,
    { messages: [] } as Context,
    {},
  );

  return capturedThinking;
}

describe("createMinimaxThinkingDisabledWrapper", () => {
  it("disables thinking for minimax anthropic-messages provider", () => {
    expect(
      captureThinkingPayload({
        provider: "minimax",
        api: "anthropic-messages",
        modelId: "MiniMax-M2.7",
      }),
    ).toEqual({ type: "disabled" });
  });

  it("disables thinking for minimax-portal anthropic-messages provider", () => {
    expect(
      captureThinkingPayload({
        provider: "minimax-portal",
        api: "anthropic-messages",
        modelId: "MiniMax-M2.7",
      }),
    ).toEqual({ type: "disabled" });
  });

  it("does not affect non-minimax providers", () => {
    expect(
      captureThinkingPayload({
        provider: "anthropic",
        api: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      }),
    ).toBeUndefined();
  });

  it("does not affect minimax with non-anthropic-messages api", () => {
    // openai-completions uses createMinimaxReasoningContentTextWrapper instead —
    // MiniMax-M2 is a documented interleaved-thinking model; disabling thinking
    // on that path degrades quality.
    expect(
      captureThinkingPayload({
        provider: "minimax",
        api: "openai-completions",
        modelId: "MiniMax-M2.7",
      }),
    ).toBeUndefined();
  });

  it("preserves an already-set thinking value", () => {
    let capturedThinking: unknown = undefined;
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        thinking: { type: "enabled", budget_tokens: 1024 },
      };
      options?.onPayload?.(payload, _model);
      capturedThinking = payload.thinking;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createMinimaxThinkingDisabledWrapper(baseStreamFn);
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M2.7",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedThinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });
});

describe("createMinimaxFastModeWrapper", () => {
  it("rewrites MiniMax-M2.7 to highspeed variant in fast mode", () => {
    let capturedId = "";
    const baseStreamFn: StreamFn = (model) => {
      capturedId = model.id;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createMinimaxFastModeWrapper(baseStreamFn, true);
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M2.7",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedId).toBe("MiniMax-M2.7-highspeed");
  });
});

type FakeStream = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

function createFakeStream(params: { events: unknown[]; resultMessage: unknown }): FakeStream {
  return {
    async result() {
      return params.resultMessage;
    },
    [Symbol.asyncIterator]() {
      return (async function* () {
        for (const event of params.events) {
          yield event;
        }
      })();
    },
  };
}

function runWrappedMinimaxOpenAIStream(params: {
  provider?: string;
  modelId: string;
  api?: string;
  events: unknown[];
  resultMessage: unknown;
}) {
  const baseStreamFn: StreamFn = () =>
    createFakeStream({
      events: params.events,
      resultMessage: params.resultMessage,
    }) as ReturnType<StreamFn>;

  const wrapped = createMinimaxReasoningContentTextWrapper(baseStreamFn);
  return wrapped(
    {
      api: params.api ?? "openai-completions",
      provider: params.provider ?? "exo",
      id: params.modelId,
    } as never,
    { messages: [] } as never,
    {},
  ) as FakeStream;
}

describe("createMinimaxReasoningContentTextWrapper", () => {
  it.each([
    ["exo", "mlx-community/MiniMax-M2.7-4bit"],
    ["ollama", "MiniMax-M2.7"],
    ["vllm", "MiniMaxAI/MiniMax-M2.7"],
  ])(
    "rewrites thinking-only final messages into text for MiniMax on openai-completions (%s / %s)",
    async (provider, modelId) => {
      const stream = runWrappedMinimaxOpenAIStream({
        provider,
        modelId,
        events: [
          {
            type: "done",
            reason: "stop",
            message: {
              role: "assistant",
              content: [{ type: "thinking", thinking: "MiniMax final answer" }],
              stopReason: "stop",
            },
          },
        ],
        resultMessage: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "MiniMax final answer" }],
          stopReason: "stop",
        },
      });

      const events: unknown[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      await expect(stream.result()).resolves.toEqual({
        role: "assistant",
        content: [{ type: "text", text: "MiniMax final answer" }],
        stopReason: "stop",
      });
      expect(events).toEqual([
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "MiniMax final answer" }],
            stopReason: "stop",
          },
        },
      ]);
    },
  );

  it("preserves messages that already have visible text", async () => {
    const originalMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "internal reasoning" },
        { type: "text", text: "Visible answer." },
      ],
      stopReason: "stop",
    };
    const stream = runWrappedMinimaxOpenAIStream({
      modelId: "MiniMax-M2.7",
      events: [{ type: "done", reason: "stop", message: originalMessage }],
      resultMessage: originalMessage,
    });

    for await (const _ of stream) {
      // drain
    }

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "internal reasoning" },
        { type: "text", text: "Visible answer." },
      ],
      stopReason: "stop",
    });
  });

  it("preserves messages that include tool calls", async () => {
    const originalMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "about to call a tool" },
        { type: "toolCall", id: "t1", name: "search", arguments: { q: "hi" } },
      ],
      stopReason: "toolUse",
    };
    const stream = runWrappedMinimaxOpenAIStream({
      modelId: "MiniMax-M2.7",
      events: [{ type: "done", reason: "toolUse", message: originalMessage }],
      resultMessage: originalMessage,
    });

    for await (const _ of stream) {
      // drain
    }

    await expect(stream.result()).resolves.toMatchObject({
      content: [{ type: "thinking", thinking: "about to call a tool" }, { type: "toolCall" }],
      stopReason: "toolUse",
    });
  });

  it("does not touch non-MiniMax openai-completions models", async () => {
    const originalMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "gpt reasoning" }],
      stopReason: "stop",
    };
    const stream = runWrappedMinimaxOpenAIStream({
      provider: "openai",
      modelId: "gpt-4o-mini",
      events: [{ type: "done", reason: "stop", message: originalMessage }],
      resultMessage: originalMessage,
    });

    for await (const _ of stream) {
      // drain
    }

    // Message left as-is — no rewrite should apply outside the MiniMax family.
    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [{ type: "thinking", thinking: "gpt reasoning" }],
      stopReason: "stop",
    });
  });

  it("does not rewrite MiniMax via anthropic-messages path", async () => {
    const originalMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "anthropic-shaped thinking" }],
      stopReason: "stop",
    };
    const stream = runWrappedMinimaxOpenAIStream({
      api: "anthropic-messages",
      provider: "minimax",
      modelId: "MiniMax-M2.7",
      events: [{ type: "done", reason: "stop", message: originalMessage }],
      resultMessage: originalMessage,
    });

    for await (const _ of stream) {
      // drain
    }

    // Anthropic path uses createMinimaxThinkingDisabledWrapper instead.
    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [{ type: "thinking", thinking: "anthropic-shaped thinking" }],
      stopReason: "stop",
    });
  });

  it("does not rewrite when stop reason is not stop or length", async () => {
    const originalMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "aborted mid-thought" }],
      stopReason: "aborted",
    };
    const stream = runWrappedMinimaxOpenAIStream({
      modelId: "MiniMax-M2.7",
      events: [{ type: "done", reason: "aborted", message: originalMessage }],
      resultMessage: originalMessage,
    });

    for await (const _ of stream) {
      // drain
    }

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [{ type: "thinking", thinking: "aborted mid-thought" }],
      stopReason: "aborted",
    });
  });

  it("rewrites on length stop reason (max_tokens exhausted inside <think>)", async () => {
    const originalMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "partial reasoning" }],
      stopReason: "length",
    };
    const stream = runWrappedMinimaxOpenAIStream({
      modelId: "MiniMax-M2.7",
      events: [{ type: "done", reason: "length", message: originalMessage }],
      resultMessage: originalMessage,
    });

    for await (const _ of stream) {
      // drain
    }

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [{ type: "text", text: "partial reasoning" }],
      stopReason: "length",
    });
  });
});
