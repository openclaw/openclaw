import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it, vi } from "vitest";
import { wrapLmstudioInferencePreload } from "./stream.js";

const loads = vi.hoisted(() => [] as Array<[path: string, timeoutMs: number, body: unknown]>);

vi.mock("openclaw/plugin-sdk/provider-transport-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-transport-runtime")>()),
  buildGuardedModelFetch:
    (_model: unknown, timeoutMs: number) => async (url: string, init?: RequestInit) => {
      if (url.endsWith("/load")) {
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        loads.push([new URL(url).pathname, timeoutMs, body]);
      }
      return await fetch(url, init);
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
  vi.restoreAllMocks();
  loads.length = 0;
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
  "routes instances: load=$needsLoad replace=$replacePayload failure=$failure seconds=$timeoutSeconds ms=$timeoutMs",
  async ({ needsLoad, replacePayload: replace, failure, timeoutSeconds, timeoutMs }) => {
    const key = "qwen3.5-0.8b";
    const instanceId = "openclaw-long-context";
    let discoveryUnavailable = false;
    const loaded_instances = [
      { id: key, config: { context_length: 4096 } },
      ...(!needsLoad ? [{ id: instanceId, config: { context_length: 16384 } }] : []),
    ];
    vi.stubGlobal("fetch", async (url: string) => {
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
        models: [{ type: "llm", key, max_context_length: 262144, loaded_instances }],
      });
    });
    const payload: Record<string, unknown> = { model: key };
    const streamFn = vi.fn<StreamFn>(async (model, _context, options) => {
      expect((await options?.onPayload?.(payload, model)) ?? payload).toEqual({
        model: instanceId,
        ...(replace ? { temperature: 0.25 } : {}),
      });
      const stream = createAssistantMessageEventStream();
      stream.end();
      return stream;
    });
    const baseUrl = `http://instance-${needsLoad}-${replace}-${failure}-${timeoutSeconds}-${timeoutMs}.localhost:1234/v1`;
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
    const onPayload = vi.fn(async () => (replace ? { model: key, temperature: 0.25 } : undefined));
    if (failure) {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now");
      const errorBody = JSON.stringify({ requestedContextLength: 16384 });
      const errorMessage = expect.stringMatching(
        /LM Studio could not load "qwen3\.5-0\.8b" with 16384 context tokens.*retry/,
      );
      const error = { model: key, errorCode: "model_load_failed", errorBody, errorMessage };
      for (const time of [now, now, now + 60_001]) {
        clock.mockReturnValue(time);
        discoveryUnavailable = time !== now;
        const events = [];
        for await (const event of await wrapped(model, { messages: [] }, { onPayload })) {
          events.push(event);
        }
        expect(events).toMatchObject([{ type: "error", reason: "error", error }]);
      }
      expect(streamFn).not.toHaveBeenCalled();
    } else {
      await wrapped(model, { messages: [] }, { onPayload, timeoutMs });
      expect([model.id, streamFn.mock.calls[0]?.[0].id]).toEqual([key, key]);
      expect(onPayload).toHaveBeenCalledWith(payload, expect.objectContaining({ id: key }));
    }
    const timeout = timeoutMs ?? (timeoutSeconds ? timeoutSeconds * 1000 : 120_000);
    const expectedLoad = ["/api/v1/models/load", timeout, { model: key, context_length: 16384 }];
    expect(loads).toEqual(needsLoad ? [expectedLoad] : []);
  },
);
