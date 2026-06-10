import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type {
  AssistantMessage,
  AssistantMessageEventStreamContract,
  Context,
  Model,
  Usage,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  createOpenRouterCostReconciliationWrapper,
  reconcileOpenRouterUsageCost,
} from "./cost-reconciliation.js";

function makeUsage(overrides: Partial<Usage["cost"]> = {}): Usage {
  return {
    input: 410000,
    output: 1000,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 411000,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.13342,
      ...overrides,
    },
  };
}

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-completions",
    provider: "openrouter",
    model: "qwen/qwen3.6-plus",
    responseId: "gen-1234567890abcdef",
    stopReason: "stop",
    timestamp: 1_700_000_000,
    usage: makeUsage(),
    ...overrides,
  } as AssistantMessage;
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("reconcileOpenRouterUsageCost", () => {
  it("overwrites usage.cost.total with the authoritative total_cost on a tier-priced response", async () => {
    const message = makeAssistantMessage();
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ data: { total_cost: 0.53366, tokens_prompt: 485590 } }),
    );

    const outcome = await reconcileOpenRouterUsageCost({
      message,
      apiKey: "sk-or-test",
      deps: { fetch: fetchSpy },
    });

    expect(outcome).toEqual({ status: "updated", previousCost: 0.13342, updatedCost: 0.53366 });
    expect(message.usage.cost.total).toBe(0.53366);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstCall = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(firstCall[0]).toBe("https://openrouter.ai/api/v1/generation?id=gen-1234567890abcdef");
    const headers = firstCall[1]?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer sk-or-test");
  });

  it("accepts a flat /generation payload (no `data` wrapper) for forward compatibility", async () => {
    const message = makeAssistantMessage();
    const fetchSpy = vi.fn(async () => jsonResponse({ total_cost: 0.42 }));

    const outcome = await reconcileOpenRouterUsageCost({
      message,
      apiKey: "sk-or-test",
      deps: { fetch: fetchSpy },
    });

    expect(outcome.status).toBe("updated");
    expect(message.usage.cost.total).toBe(0.42);
  });

  it("preserves the streamed cost when the authoritative total is not greater (short context, parity case)", async () => {
    const message = makeAssistantMessage({ usage: makeUsage({ total: 0.00628 }) });
    const fetchSpy = vi.fn(async () => jsonResponse({ data: { total_cost: 0.00628 } }));

    const outcome = await reconcileOpenRouterUsageCost({
      message,
      apiKey: "sk-or-test",
      deps: { fetch: fetchSpy },
    });

    expect(outcome.status).toBe("skipped");
    expect(message.usage.cost.total).toBe(0.00628);
  });

  it("skips reconciliation when responseId is missing", async () => {
    const message = makeAssistantMessage({ responseId: undefined });
    const fetchSpy = vi.fn();

    const outcome = await reconcileOpenRouterUsageCost({
      message,
      apiKey: "sk-or-test",
      deps: { fetch: fetchSpy as never },
    });

    expect(outcome).toEqual({ status: "skipped", reason: "missing responseId" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips reconciliation when no API key is supplied", async () => {
    const message = makeAssistantMessage();
    const fetchSpy = vi.fn();

    const outcome = await reconcileOpenRouterUsageCost({
      message,
      apiKey: undefined,
      deps: { fetch: fetchSpy as never },
    });

    expect(outcome.status).toBe("skipped");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("preserves the streamed cost when the /generation endpoint responds with HTTP error", async () => {
    const message = makeAssistantMessage();
    const fetchSpy = vi.fn(async () => jsonResponse({ error: "not found" }, { status: 404 }));

    const outcome = await reconcileOpenRouterUsageCost({
      message,
      apiKey: "sk-or-test",
      deps: { fetch: fetchSpy },
    });

    expect(outcome.status).toBe("skipped");
    expect(message.usage.cost.total).toBe(0.13342);
  });

  it("preserves the streamed cost when the network call rejects", async () => {
    const message = makeAssistantMessage();
    const fetchSpy = vi.fn(async () => {
      throw new Error("network down");
    });

    const outcome = await reconcileOpenRouterUsageCost({
      message,
      apiKey: "sk-or-test",
      deps: { fetch: fetchSpy as never },
    });

    expect(outcome.status).toBe("skipped");
    expect(message.usage.cost.total).toBe(0.13342);
  });

  it("preserves the streamed cost when the response payload is malformed", async () => {
    const message = makeAssistantMessage();
    const fetchSpy = vi.fn(async () => jsonResponse({ data: { total_cost: "not-a-number" } }));

    const outcome = await reconcileOpenRouterUsageCost({
      message,
      apiKey: "sk-or-test",
      deps: { fetch: fetchSpy },
    });

    expect(outcome.status).toBe("skipped");
    expect(message.usage.cost.total).toBe(0.13342);
  });
});

describe("createOpenRouterCostReconciliationWrapper", () => {
  it("mutates the done-event message in place so both iteration and result() observe the reconciled cost", async () => {
    const message = makeAssistantMessage();
    const events = [
      { type: "start", partial: message },
      { type: "text_delta", contentIndex: 0, delta: "ok", partial: message },
      { type: "done", reason: "stop", message },
    ] as const;

    const baseStream: AssistantMessageEventStreamContract = {
      [Symbol.asyncIterator]() {
        let cursor = 0;
        return {
          async next() {
            if (cursor < events.length) {
              const value = events[cursor];
              cursor += 1;
              return { value, done: false } as IteratorResult<(typeof events)[number]>;
            }
            return { value: undefined as never, done: true };
          },
        };
      },
      async result() {
        return message;
      },
      // Stream contract surface used by EventStream-backed implementations;
      // the wrapper only consumes the iterator + result(), so these are inert
      // for this test.
      push() {},
      end() {},
    };

    const fetchSpy = vi.fn(async () => jsonResponse({ data: { total_cost: 0.99 } }));
    const baseStreamFn: StreamFn = () => baseStream;
    const wrappedStreamFn = createOpenRouterCostReconciliationWrapper(baseStreamFn, {
      fetch: fetchSpy,
    });
    expect(wrappedStreamFn).toBeDefined();

    const wrapped = await wrappedStreamFn!(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "openrouter/auto",
        baseUrl: "https://openrouter.ai/api/v1",
        compat: {},
      } as Model,
      {} as Context,
      { apiKey: "sk-or-test" },
    );
    const observed: string[] = [];
    for await (const event of wrapped) {
      observed.push(event.type);
    }

    expect(observed).toEqual(["start", "text_delta", "done"]);
    expect(message.usage.cost.total).toBe(0.99);
    await expect(wrapped.result()).resolves.toBe(message);
    expect((await wrapped.result()).usage.cost.total).toBe(0.99);
  });

  it("returns the base StreamFn unchanged when there is no base to wrap", () => {
    expect(createOpenRouterCostReconciliationWrapper(undefined)).toBeUndefined();
  });
});
