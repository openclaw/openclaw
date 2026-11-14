import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getProviderPromptState,
  clearProviderPromptState,
  wrapStreamFnWithProviderPromptState,
} from "../../../../src/agents/embedded-agent-runner/provider-prompt-state.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";

const initialHost = getAiTransportHost();
afterEach(() => configureAiTransportHost(initialHost));

// Synthetic key for the local fake transport; env override first, and the
// fallback is a non-secret placeholder understood by the local fake only.
const LOCAL_TEST_API_KEY = process.env.PROMPT_PRESENCE_CAPTURE_KEY ?? "test-key";

const BODY = "产出闭环验证：交付前必须以可观察证据校验产物新鲜度与正确性";

function makeModel(api: "openai-completions" | "openai-responses", baseUrl: string) {
  return {
    id: "capture-model",
    name: "Capture",
    api,
    provider: "openai",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
}

type CapturedRequest = { bytes: Uint8Array; text: string };

/**
 * Real production transport + wrapper, fake transport host fetch. Captures the
 * ACTUAL bytes handed to the fetch (the encoded request body), not a re-built
 * object — this validates the checkpoint observed the submitted content.
 */
function installCapturingFetch(responder: () => Response): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  configureAiTransportHost({
    buildModelFetch: () => async (_input, init) => {
      const raw = init?.body;
      let bytes: Uint8Array;
      if (raw instanceof Blob) {
        bytes = new Uint8Array(await raw.arrayBuffer());
      } else if (raw instanceof Uint8Array) {
        bytes = raw;
      } else if (typeof raw === "string") {
        bytes = new TextEncoder().encode(raw);
      } else {
        throw new Error(`unexpected request body type: ${String(raw)}`);
      }
      captured.push({ bytes, text: new TextDecoder().decode(bytes) });
      return responder();
    },
  });
  return captured;
}

function completionSse(): Response {
  const chunk = {
    id: "chatcmpl-capture",
    object: "chat.completion.chunk",
    created: 1,
    model: "capture-model",
    choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function responsesError(): Response {
  return new Response(JSON.stringify({ error: { message: "captured-and-rejected" } }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

async function drain(stream: unknown): Promise<void> {
  const iterable = stream as AsyncIterable<{ type: string }>;
  for await (const _event of iterable) {
    // Drain; terminal/error handling is the transport's business.
  }
}

describe("prompt presence capture over real production transports", () => {
  it("completions: submitted bytes contain the target body; event records full_hit; ordinal advances per request", async () => {
    const captured = installCapturingFetch(completionSse);
    const runId = "capture-completions";
    const state = getProviderPromptState(runId);
    state.pendingInjectedExpectations = [
      {
        activationId: "act_target",
        revision: 0,
        bodyText: BODY,
        bodyChars: BODY.length,
        bodyComplete: true,
      },
    ];
    const recordEvent = vi.fn();
    const productionTransport = createOpenAICompletionsTransportStreamFn();
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: productionTransport as unknown as StreamFn,
      state,
      effectiveContextTokenBudget: 128_000,
      recordEvent,
    });
    const model = makeModel("openai-completions", "https://capture.local/v1");
    const stream = await wrapped(
      model,
      {
        systemPrompt: `policy ${BODY}`,
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
        tools: [],
      },
      { apiKey: LOCAL_TEST_API_KEY },
    );
    await drain(stream);
    expect(captured).toHaveLength(1);
    expect(captured[0].text).toContain(BODY);
    const event = recordEvent.mock.calls[0]?.[1] as {
      egress?: string;
      requestIndex?: number;
      presenceCheck?: { results: { outcome: string; hitRole?: string }[] };
    };
    expect(event.egress).toBe("completions");
    expect(event.requestIndex).toBe(1);
    expect(event.presenceCheck?.results[0]?.outcome).toBe("full_hit");
    // Second logical request through the same wrapper: ordinal advances.
    const stream2 = await wrapped(
      model,
      {
        systemPrompt: `policy ${BODY}`,
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
        tools: [],
      },
      { apiKey: LOCAL_TEST_API_KEY },
    );
    await drain(stream2);
    expect((recordEvent.mock.calls[1]?.[1] as { requestIndex?: number }).requestIndex).toBe(2);
    expect(captured).toHaveLength(2);
    clearProviderPromptState(runId);
  });

  it("completions: onPayload replacement is observed — bytes and event both reflect the replaced request", async () => {
    const captured = installCapturingFetch(completionSse);
    const runId = "capture-replacement";
    const state = getProviderPromptState(runId);
    state.pendingInjectedExpectations = [
      {
        activationId: "act_target",
        revision: 0,
        bodyText: BODY,
        bodyChars: BODY.length,
        bodyComplete: true,
      },
    ];
    const recordEvent = vi.fn();
    const productionTransport = createOpenAICompletionsTransportStreamFn();
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: productionTransport as unknown as StreamFn,
      state,
      effectiveContextTokenBudget: 128_000,
      recordEvent,
    });
    const model = makeModel("openai-completions", "https://capture.local/v1");
    const stream = await wrapped(
      model,
      {
        systemPrompt: `policy ${BODY}`,
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
        tools: [],
      },
      {
        apiKey: LOCAL_TEST_API_KEY,
        // Caller-level onPayload replaces the whole message list: the injection
        // block is dropped after the runner stage but before submission.
        onPayload: (payload) => {
          const next = { ...(payload as { messages: unknown[] }) };
          next.messages = [{ role: "user", content: "replaced", timestamp: 1 }];
          return next;
        },
      },
    );
    await drain(stream);
    expect(captured).toHaveLength(1);
    expect(captured[0].text).not.toContain(BODY);
    const event = recordEvent.mock.calls[0]?.[1] as {
      presenceCheck?: { results: { outcome: string; presentInWrongRole?: boolean }[] };
    };
    expect(event.presenceCheck?.results[0]?.outcome).toBe("checked_missing");
    clearProviderPromptState(runId);
  });

  it("responses: submitted bytes captured; checkpoint event precedes the request with the same facts", async () => {
    const captured = installCapturingFetch(responsesError);
    const runId = "capture-responses";
    const state = getProviderPromptState(runId);
    state.pendingInjectedExpectations = [
      {
        activationId: "act_target",
        revision: 0,
        bodyText: BODY,
        bodyChars: BODY.length,
        bodyComplete: true,
      },
    ];
    const recordEvent = vi.fn();
    const productionTransport = createOpenAIResponsesTransportStreamFn();
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: productionTransport as unknown as StreamFn,
      state,
      effectiveContextTokenBudget: 128_000,
      recordEvent,
    });
    const model = makeModel("openai-responses", "https://capture.local/v1");
    const stream = await wrapped(
      model,
      {
        systemPrompt: `policy ${BODY}`,
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
        tools: [],
      },
      { apiKey: LOCAL_TEST_API_KEY },
    );
    try {
      await drain(stream);
    } catch {
      // The fake responder rejects; the checkpoint and the captured bytes are
      // what this test validates — terminal handling is the transport's business.
    }
    expect(captured).toHaveLength(1);
    expect(captured[0].text).toContain(BODY);
    const events = recordEvent.mock.calls.map(
      (c) =>
        c[1] as {
          egress?: string;
          requestIndex?: number;
          presenceCheck?: { results: { outcome: string; hitRole?: string }[] };
        },
    );
    const observed = events.filter((e) => e.presenceCheck);
    expect(observed.length).toBeGreaterThanOrEqual(1);
    expect(observed[0].egress).toBe("responses-sdk");
    expect(observed[0].requestIndex).toBe(1);
    expect(observed[0].presenceCheck?.results[0]?.outcome).toBe("full_hit");
    clearProviderPromptState(runId);
  });

  it("checker failures never block the request: broken expectations still submit", async () => {
    const captured = installCapturingFetch(completionSse);
    const runId = "capture-failopen";
    const state = getProviderPromptState(runId);
    // bodyComplete=false (truncated fragment): the check degrades to unknown but
    // the request must still go out untouched.
    state.pendingInjectedExpectations = [
      {
        activationId: "act_truncated",
        revision: 0,
        bodyText: BODY,
        bodyChars: BODY.length,
        bodyComplete: false,
      },
    ];
    const recordEvent = vi.fn();
    const productionTransport = createOpenAICompletionsTransportStreamFn();
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: productionTransport as unknown as StreamFn,
      state,
      effectiveContextTokenBudget: 128_000,
      recordEvent,
    });
    const model = makeModel("openai-completions", "https://capture.local/v1");
    const stream = await wrapped(
      model,
      {
        systemPrompt: BODY.slice(0, 20),
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
        tools: [],
      },
      { apiKey: LOCAL_TEST_API_KEY },
    );
    await drain(stream);
    expect(captured).toHaveLength(1);
    expect(captured[0].text.length).toBeGreaterThan(0);
    const event = recordEvent.mock.calls[0]?.[1] as {
      presenceCheck?: { results: { outcome: string; reason?: string }[] };
    };
    expect(event.presenceCheck?.results[0]).toMatchObject({
      outcome: "unknown",
      reason: "assembly_truncated",
    });
    clearProviderPromptState(runId);
  });
});
