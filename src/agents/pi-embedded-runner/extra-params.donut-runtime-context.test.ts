import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { applyExtraParamsToAgent } from "./extra-params.js";

type DonutRuntimeAnalyticsContext = {
  threadRunId?: string;
  sessionKey?: string;
  threadId?: string;
  toolCallId?: string;
};

function runDonutCase(params: {
  payload: Record<string, unknown>;
  provider?: string;
  runtimeContext?: DonutRuntimeAnalyticsContext;
  contextMessages?: unknown[];
}) {
  const captured: {
    headers?: Record<string, string>;
    payload: Record<string, unknown>;
  } = {
    payload: params.payload,
  };

  const baseStreamFn: StreamFn = (_model, _context, options) => {
    captured.headers = options?.headers;
    options?.onPayload?.(params.payload);
    return createAssistantMessageEventStream();
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(
    agent,
    undefined,
    params.provider ?? "donut",
    "anthropic/claude-sonnet-4.6",
    undefined,
    undefined,
    undefined,
    undefined,
    params.runtimeContext,
  );

  const model = {
    api: "openai-completions",
    provider: params.provider ?? "donut",
    id: "anthropic/claude-sonnet-4.6",
  } as Model<"openai-completions">;
  const context: Context = { messages: (params.contextMessages ?? []) as never };

  void agent.streamFn?.(model, context, {});

  return captured;
}

describe("extra-params: donut runtime analytics context", () => {
  it("injects canonical thread identifiers into donut requests", () => {
    const captured = runDonutCase({
      payload: {},
      runtimeContext: {
        threadRunId: "run-123",
        sessionKey: "session-123",
        threadId: "thread-123",
      },
    });

    expect(captured.headers).toEqual(
      expect.objectContaining({
        "X-Session-Key": "session-123",
        "X-Thread-Id": "thread-123",
      }),
    );
    expect(captured.payload).toEqual(
      expect.objectContaining({
        thread_run_id: "run-123",
      }),
    );
    expect(captured.payload.session_key).toBeUndefined();
    expect(captured.payload.thread_id).toBeUndefined();
    expect(captured.headers?.traceparent).toBeDefined();
  });

  it("infers tool_call_id from the latest tool context when donut runtime context omits it", () => {
    const captured = runDonutCase({
      payload: {},
      runtimeContext: {
        threadRunId: "run-456",
      },
      contextMessages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "toolCall", id: "tool-456", name: "price_lookup" },
          ],
        },
      ],
    });

    expect(captured.payload).toEqual(
      expect.objectContaining({
        thread_run_id: "run-456",
        tool_call_id: "tool-456",
      }),
    );
  });

  it("does not inject donut analytics fields for non-donut providers", () => {
    const captured = runDonutCase({
      payload: {},
      provider: "openrouter",
      runtimeContext: {
        threadRunId: "run-789",
        sessionKey: "session-789",
        threadId: "thread-789",
      },
    });

    expect(captured.headers).not.toEqual(
      expect.objectContaining({
        "X-Session-Key": "session-789",
        "X-Thread-Id": "thread-789",
      }),
    );
    expect(captured.payload).toEqual({});
  });
});
