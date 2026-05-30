// extensions/openai/discovery.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverOpenAIModels, resetOpenAIDiscoveryCacheForTest } from "./discovery.js";

afterEach(() => {
  resetOpenAIDiscoveryCacheForTest();
  vi.restoreAllMocks();
});

function buildResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("discoverOpenAIModels", () => {
  it("returns [] when baseUrl or apiKey is missing", async () => {
    const fetchFn = vi.fn();
    expect(await discoverOpenAIModels({ baseUrl: "", apiKey: "k", fetchFn })).toEqual([]);
    expect(
      await discoverOpenAIModels({
        baseUrl: "https://x.example.com/v1",
        apiKey: "",
        fetchFn,
      }),
    ).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("calls <baseUrl>/models with Authorization Bearer", async () => {
    const fetchFn = vi.fn(async () => buildResponse({ object: "list", data: [] }));
    await discoverOpenAIModels({
      baseUrl: "https://aceteam.ai/api/gateway/v1",
      apiKey: "act_secret_key_12345678",
      fetchFn,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchFn.mock.calls[0]!;
    expect(endpoint).toBe("https://aceteam.ai/api/gateway/v1/models");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer act_secret_key_12345678",
      Accept: "application/json",
    });
  });

  it("strips trailing slashes from baseUrl", async () => {
    const fetchFn = vi.fn(async () => buildResponse({ object: "list", data: [] }));
    await discoverOpenAIModels({
      baseUrl: "https://aceteam.ai/api/gateway/v1///",
      apiKey: "k",
      fetchFn,
    });
    expect(fetchFn.mock.calls[0]![0]).toBe("https://aceteam.ai/api/gateway/v1/models");
  });

  it("maps OpenAI-spec entries to ModelDefinitionConfig with sane defaults", async () => {
    const fetchFn = vi.fn(async () =>
      buildResponse({
        object: "list",
        data: [{ id: "gpt-4o", object: "model", created: 1, owned_by: "openai" }],
      }),
    );
    const models = await discoverOpenAIModels({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-xxx",
      fetchFn,
    });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "gpt-4o",
      name: "gpt-4o",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    });
  });

  it("honors AceTeam superset fields when present", async () => {
    const fetchFn = vi.fn(async () =>
      buildResponse({
        object: "list",
        data: [
          {
            id: "gpt-4o",
            object: "model",
            created: 1715126400,
            owned_by: "openai",
            context_window: 128000,
            max_output_tokens: 16384,
            modalities: ["text", "image"],
            cost_per_million_tokens: {
              input: 2.5,
              output: 10,
              cache_read: 1.25,
              cache_write: 0,
            },
          },
        ],
      }),
    );
    const [model] = await discoverOpenAIModels({
      baseUrl: "https://aceteam.ai/api/gateway/v1",
      apiKey: "act_xxx",
      fetchFn,
    });
    expect(model).toMatchObject({
      id: "gpt-4o",
      input: ["text", "image"],
      cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    });
  });

  it("infers reasoning support from model id family", async () => {
    const fetchFn = vi.fn(async () =>
      buildResponse({
        object: "list",
        data: [
          { id: "gpt-5.5", object: "model" },
          { id: "o3-mini", object: "model" },
          { id: "gpt-4o", object: "model" },
          { id: "claude-3-5-sonnet-20241022", object: "model" },
        ],
      }),
    );
    const models = await discoverOpenAIModels({
      baseUrl: "https://x/v1",
      apiKey: "k",
      fetchFn,
    });
    const reasoning = Object.fromEntries(models.map((m) => [m.id, m.reasoning]));
    expect(reasoning).toEqual({
      "gpt-5.5": true,
      "o3-mini": true,
      "gpt-4o": false,
      "claude-3-5-sonnet-20241022": false,
    });
  });

  it("skips entries without an id and sorts the rest", async () => {
    const fetchFn = vi.fn(async () =>
      buildResponse({
        object: "list",
        data: [{ id: "" }, { object: "model" }, { id: "gpt-4o" }, { id: "claude-3-5-sonnet" }],
      }),
    );
    const models = await discoverOpenAIModels({
      baseUrl: "https://x/v1",
      apiKey: "k",
      fetchFn,
    });
    expect(models.map((m) => m.id)).toEqual(["claude-3-5-sonnet", "gpt-4o"]);
  });

  it("caches per (baseUrl, last-8-of-apiKey) for DEFAULT_REFRESH_INTERVAL_SECONDS", async () => {
    const fetchFn = vi.fn(async () => buildResponse({ object: "list", data: [{ id: "gpt-4o" }] }));
    const args = {
      baseUrl: "https://x/v1",
      apiKey: "k1234567890",
      fetchFn,
      now: () => 1000,
    };
    await discoverOpenAIModels(args);
    await discoverOpenAIModels({ ...args, now: () => 1000 + 30 * 60 * 1000 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the TTL expires", async () => {
    const fetchFn = vi.fn(async () => buildResponse({ object: "list", data: [{ id: "gpt-4o" }] }));
    const args = { baseUrl: "https://x/v1", apiKey: "k", fetchFn };
    await discoverOpenAIModels({ ...args, now: () => 1000 });
    await discoverOpenAIModels({ ...args, now: () => 1000 + 3601 * 1000 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("returns last-known-good on transient failure", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(buildResponse({ object: "list", data: [{ id: "gpt-4o" }] }))
      .mockResolvedValueOnce(buildResponse("Internal Server Error", 500));

    const first = await discoverOpenAIModels({
      baseUrl: "https://x/v1",
      apiKey: "k",
      fetchFn,
      now: () => 1000,
    });
    expect(first.map((m) => m.id)).toEqual(["gpt-4o"]);

    const second = await discoverOpenAIModels({
      baseUrl: "https://x/v1",
      apiKey: "k",
      fetchFn,
      now: () => 1000 + 3601 * 1000,
    });
    expect(second.map((m) => m.id)).toEqual(["gpt-4o"]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("returns [] when there's no cache and the fetch fails", async () => {
    const fetchFn = vi.fn(async () => buildResponse("nope", 401));
    const models = await discoverOpenAIModels({
      baseUrl: "https://x/v1",
      apiKey: "k",
      fetchFn,
    });
    expect(models).toEqual([]);
  });

  it("swallows network errors and returns last-known-good", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(buildResponse({ object: "list", data: [{ id: "gpt-4o" }] }))
      .mockRejectedValueOnce(new Error("network down"));

    await discoverOpenAIModels({
      baseUrl: "https://x/v1",
      apiKey: "k",
      fetchFn,
      now: () => 1000,
    });
    const second = await discoverOpenAIModels({
      baseUrl: "https://x/v1",
      apiKey: "k",
      fetchFn,
      now: () => 1000 + 3601 * 1000,
    });
    expect(second.map((m) => m.id)).toEqual(["gpt-4o"]);
  });
});
