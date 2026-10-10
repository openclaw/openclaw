import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it, vi } from "vitest";
import { wrapLmstudioInferencePreload } from "./stream.js";

const loadTimeouts = vi.hoisted(() => [] as number[]);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: async ({
    url,
    init,
    timeoutMs,
  }: {
    url: string;
    init?: RequestInit;
    timeoutMs: number;
  }) => {
    if (url.endsWith("/load")) {
      loadTimeouts.push(timeoutMs);
    }
    return { response: await fetch(url, init), release: async () => undefined };
  },
}));

// mock-isolation: Keep credential resolution outside this instance-routing fixture.
vi.mock("./runtime.js", () => ({
  buildLmstudioAuthHeaders: () => ({ "Content-Type": "application/json" }),
  resolveLmstudioRuntimeApiKey: async () => undefined,
  resolveLmstudioProviderHeaders: async () => undefined,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  loadTimeouts.length = 0;
});

it.each([
  { needsLoad: false, replacePayload: false },
  { needsLoad: true, replacePayload: false },
  { needsLoad: false, replacePayload: true },
  { needsLoad: true, timeoutSeconds: 300 },
  { needsLoad: true, timeoutSeconds: 300, timeoutMs: 180_000 },
  { needsLoad: true, failure: "timeout" },
  { needsLoad: true, failure: "http" },
])(
  "routes inference to the matching instance with stable identity (load=$needsLoad, replace=$replacePayload, failure=$failure, providerTimeout=$timeoutSeconds, requestTimeout=$timeoutMs)",
  async ({ needsLoad, replacePayload, failure, timeoutSeconds, timeoutMs }) => {
    const key = "qwen3.5-0.8b";
    const instanceId = "openclaw-long-context";
    const calls: Array<{ path: string; body: unknown }> = [];
    let discoveryUnavailable = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          path: new URL(url).pathname,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        if (url.endsWith("/api/v1/models/load")) {
          if (failure === "timeout") {
            throw new DOMException("Load request timed out", "TimeoutError");
          }
          if (failure === "http") {
            return Response.json({ error: "load unavailable" }, { status: 503 });
          }
          return Response.json({ status: "loaded", instance_id: instanceId });
        }
        if (discoveryUnavailable) {
          throw new Error("discovery temporarily unavailable");
        }
        return Response.json({
          models: [
            {
              type: "llm",
              key,
              max_context_length: 262144,
              loaded_instances: [
                { id: key, config: { context_length: 4096 } },
                ...(!needsLoad ? [{ id: instanceId, config: { context_length: 16384 } }] : []),
              ],
            },
          ],
        });
      }),
    );
    const payload: Record<string, unknown> = { model: key };
    const observed = vi.fn();
    let dispatched: unknown;
    const streamFn: StreamFn = async (model, _context, options) => {
      observed(model);
      dispatched = (await options?.onPayload?.(payload, model)) ?? payload;
      const stream = createAssistantMessageEventStream();
      stream.end();
      return stream;
    };
    const baseUrl = `http://instance-${needsLoad}-${replacePayload}-${failure}-${timeoutSeconds}-${timeoutMs}.localhost:1234/v1`;
    const wrapped = wrapLmstudioInferencePreload({
      provider: "lmstudio",
      modelId: key,
      config: { models: { providers: { lmstudio: { baseUrl, timeoutSeconds, models: [] } } } },
      streamFn,
    });
    const model: Parameters<StreamFn>[0] = {
      id: key,
      name: "Qwen3.5 0.8B",
      provider: "lmstudio",
      api: "openai-completions",
      baseUrl,
      contextWindow: 262144,
      contextTokens: 16384,
      maxTokens: 8192,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const onPayload = vi.fn(async () =>
      replacePayload ? { model: key, temperature: 0.25 } : undefined,
    );
    if (failure) {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt === 2) {
          clock.mockReturnValue(now + 5_001);
          discoveryUnavailable = true;
        }
        const events = [];
        for await (const event of await wrapped(model, { messages: [] }, { onPayload })) {
          events.push(event);
        }
        expect(events).toEqual([
          expect.objectContaining({
            type: "error",
            reason: "error",
            error: expect.objectContaining({
              model: key,
              errorCode: "model_load_failed",
              errorBody: JSON.stringify({ requestedContextLength: 16384 }),
              errorMessage: expect.stringContaining(
                `LM Studio could not load "${key}" with 16384 context tokens`,
              ),
            }),
          }),
        ]);
        expect(events[0]).toMatchObject({
          error: { errorMessage: expect.stringContaining("retry") },
        });
      }
      expect(observed).not.toHaveBeenCalled();
    } else {
      await wrapped(model, { messages: [] }, { onPayload, timeoutMs });
      expect(dispatched).toEqual({
        model: instanceId,
        ...(replacePayload ? { temperature: 0.25 } : {}),
      });
      expect(model.id).toBe(key);
      expect(observed.mock.calls[0]?.[0].id).toBe(key);
      expect(onPayload).toHaveBeenCalledWith(payload, expect.objectContaining({ id: key }));
    }
    expect(loadTimeouts).toEqual(
      needsLoad ? [timeoutMs ?? (timeoutSeconds ? timeoutSeconds * 1000 : 120_000)] : [],
    );
    expect(calls.filter((call) => call.path.endsWith("/load"))).toEqual(
      needsLoad
        ? [{ path: "/api/v1/models/load", body: { model: key, context_length: 16384 } }]
        : [],
    );
  },
);
