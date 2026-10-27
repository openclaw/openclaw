import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it, vi } from "vitest";
import { wrapLmstudioInferencePreload } from "./stream.js";
import { listedModel, streamModel } from "./stream.test-support.js";

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
  const requests: Array<{ path: string; headers: Headers }> = [];
  let loads = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const path = new URL(url).pathname;
    requests.push({ path, headers });
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
    return Response.json(listedModel(key, 262144));
  });
  const dispatched: unknown[] = [];
  const streamFn: StreamFn = async (model, _context, options) => {
    const payload = { model: model.id };
    const replacement = await options?.onPayload?.(payload, model);
    dispatched.push(replacement ?? payload);
    const stream = createAssistantMessageEventStream();
    stream.end();
    return stream;
  };
  const model = streamModel(baseUrl, { id: key });
  const wrap = (agentDir?: string) =>
    wrapLmstudioInferencePreload({
      provider: "lmstudio",
      modelId: key,
      agentDir,
      streamFn,
    });
  const run = (route: string, options: Parameters<StreamFn>[2], agentDir?: string) =>
    wrap(agentDir)({ ...model, headers: { "X-Route": route } }, { messages: [] }, options);
  return { run, requests, dispatched, loads: () => loads };
}

it.each(["credential", "headers", "timeout", "agent"] as const)(
  "does not apply another %s scope's failed preload cooldown",
  async (scope) => {
    const scenario = createScenario(
      `cooldown-${scope}`,
      scope === "credential" ? "credential" : "load",
    );
    await scenario.run(
      "first",
      { apiKey: scope === "credential" ? "fixture-stale" : "fixture-valid", timeoutMs: 120_000 },
      scope === "agent" ? "/fixture/agent-a" : undefined,
    );
    await scenario.run(
      scope === "headers" ? "second" : "first",
      { apiKey: "fixture-valid", timeoutMs: scope === "timeout" ? 180_000 : 120_000 },
      scope === "agent" ? "/fixture/agent-b" : undefined,
    );
    expect(scenario.dispatched.at(-1)).toEqual({
      model: scope === "credential" ? "prepared-1" : "prepared-2",
    });
    expect(scenario.requests.filter((request) => request.path.endsWith("/models"))).toHaveLength(2);
    expect(Object.fromEntries(new Headers(scenario.requests.at(-1)?.headers))).toMatchObject({
      authorization: "Bearer fixture-valid",
      "x-route": scope === "headers" ? "second" : "first",
    });
  },
);

it("does not share an in-flight preload across different headers", async () => {
  const scenario = createScenario("concurrent-headers", false);
  await Promise.all(
    ["first", "second"].map(async (route) => scenario.run(route, { apiKey: "fixture-valid" })),
  );
  expect(scenario.loads()).toBe(2);
  expect(scenario.dispatched).toEqual(
    expect.arrayContaining([{ model: "prepared-1" }, { model: "prepared-2" }]),
  );
});
