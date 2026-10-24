import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it, vi } from "vitest";
import { wrapLmstudioInferencePreload } from "./stream.js";

// Keep stream, authentication, discovery, and loading real; replace only HTTP I/O.
vi.mock("openclaw/plugin-sdk/provider-transport-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-transport-runtime")>()),
  buildGuardedModelFetch: () => (url: string, init?: RequestInit) => fetch(url, init),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

function createScenario(name: string, failure: "credential" | "load" | false) {
  const key = "qwen3.5-0.8b";
  const baseUrl = `http://${name}.localhost:1234/v1`;
  const requests: Array<{ path: string; authorization: string | null; route: string | null }> = [];
  let loads = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const path = new URL(url).pathname;
    requests.push({
      path,
      authorization: headers.get("authorization"),
      route: headers.get("x-route"),
    });
    if (failure === "credential" && headers.get("authorization") === "Bearer fixture-stale") {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (path.endsWith("/load")) {
      loads++;
      if (failure === "load" && loads === 1) {
        return Response.json({ error: "load unavailable" }, { status: 503 });
      }
      return Response.json({ status: "loaded", instance_id: `prepared-${loads}` });
    }
    return Response.json({
      models: [
        {
          type: "llm",
          key,
          max_context_length: 262144,
          loaded_instances: [{ id: key, config: { context_length: 4096 } }],
        },
      ],
    });
  });
  const dispatched: Array<{ canonical: string; target: unknown }> = [];
  const streamFn: StreamFn = async (model, _context, options) => {
    const payload = { model: model.id };
    const replacement = await options?.onPayload?.(payload, model);
    dispatched.push({ canonical: model.id, target: replacement ?? payload });
    const stream = createAssistantMessageEventStream();
    stream.end();
    return stream;
  };
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
  const wrap = (agentDir?: string) =>
    wrapLmstudioInferencePreload({
      provider: "lmstudio",
      modelId: key,
      agentDir,
      streamFn,
    });
  return { model, wrap, requests, dispatched, loads: () => loads };
}

it.each(["credential", "headers", "timeout", "agent"] as const)(
  "does not apply another %s scope's failed preload cooldown",
  async (scope) => {
    const scenario = createScenario(
      `cooldown-${scope}`,
      scope === "credential" ? "credential" : "load",
    );
    const first = scenario.wrap(scope === "agent" ? "/fixture/agent-a" : undefined);
    const second = scenario.wrap(scope === "agent" ? "/fixture/agent-b" : undefined);
    const apiKey = scope === "credential" ? "fixture-stale" : "fixture-valid";
    await first(
      { ...scenario.model, headers: { "X-Route": "first" } },
      { messages: [] },
      { apiKey, timeoutMs: 120_000 },
    );
    await second(
      { ...scenario.model, headers: { "X-Route": scope === "headers" ? "second" : "first" } },
      { messages: [] },
      { apiKey: "fixture-valid", timeoutMs: scope === "timeout" ? 180_000 : 120_000 },
    );
    expect(scenario.dispatched.at(-1)).toEqual({
      canonical: scenario.model.id,
      target: { model: scope === "credential" ? "prepared-1" : "prepared-2" },
    });
    expect(scenario.requests.filter((request) => request.path.endsWith("/models"))).toHaveLength(2);
    expect(scenario.requests.at(-1)).toMatchObject({
      authorization: "Bearer fixture-valid",
      route: scope === "headers" ? "second" : "first",
    });
  },
);

it.each([false, true])(
  "shares an in-flight preload only for matching headers (different=%s)",
  async (different) => {
    const scenario = createScenario(`concurrent-${different}`, false);
    const wrapped = scenario.wrap();
    await Promise.all(
      ["first", different ? "second" : "first"].map(async (route) =>
        wrapped(
          { ...scenario.model, headers: { "X-Route": route } },
          { messages: [] },
          { apiKey: "fixture-valid" },
        ),
      ),
    );
    expect(scenario.loads()).toBe(different ? 2 : 1);
    expect(scenario.dispatched.map((entry) => entry.target)).toEqual(
      different
        ? expect.arrayContaining([{ model: "prepared-1" }, { model: "prepared-2" }])
        : [{ model: "prepared-1" }, { model: "prepared-1" }],
    );
  },
);
