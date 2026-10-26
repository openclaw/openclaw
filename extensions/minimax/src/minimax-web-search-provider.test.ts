import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { captureEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMiniMaxWebSearchProvider } from "./minimax-web-search-provider.js";

const apiKey = "minimax-test-key";

function createTool(
  webSearch: { apiKey?: string; region?: string } = { apiKey },
  config: OpenClawConfig = {},
  cacheTtlMinutes?: number,
) {
  const tool = createMiniMaxWebSearchProvider().createTool({
    config: {
      ...config,
      plugins: { entries: { minimax: { config: { webSearch } } } },
    },
    searchConfig: { cacheTtlMinutes },
  });
  if (!tool) {
    throw new Error("Expected tool definition");
  }
  return tool;
}

const searchResponse = (organic: Array<{ title: string; link: string }> = []) =>
  Response.json({ organic, base_resp: { status_code: 0 } });

describe("minimax web search provider", () => {
  const envKeys = [
    "MINIMAX_API_HOST",
    "MINIMAX_CODE_PLAN_KEY",
    "MINIMAX_CODING_API_KEY",
    "MINIMAX_OAUTH_TOKEN",
    "MINIMAX_API_KEY",
  ];
  const envSnapshot = captureEnv(envKeys);

  beforeEach(() => {
    for (const key of envKeys) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    envSnapshot.restore();
    vi.restoreAllMocks();
  });

  it.each([0, 1])("applies current TTL of %i minutes to cached results", async (ttl) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (const result of ["initial", "fresh", "uncached"]) {
      fetchMock.mockResolvedValueOnce(
        searchResponse([{ title: result, link: `https://example.test/${result}` }]),
      );
    }
    const args = { query: `minimax current cache TTL ${ttl}` };
    const originalTool = createTool(undefined, undefined, 15);
    const initial = await originalTool.execute(args);
    expect(await originalTool.execute(args)).toEqual({ ...initial, cached: true });
    expect(fetchMock).toHaveBeenCalledOnce();

    now.mockReturnValue(1_700_000_060_000);
    const currentTool = createTool(undefined, undefined, ttl);
    const fresh = await currentTool.execute(args);
    expect(fresh.cached).toBeUndefined();
    expect(fresh.results).toEqual([expect.objectContaining({ url: "https://example.test/fresh" })]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const repeated = await currentTool.execute(args);
    expect(repeated.cached).toBe(ttl === 0 ? undefined : true);
    expect(fetchMock).toHaveBeenCalledTimes(ttl === 0 ? 3 : 2);
    if (ttl === 0) {
      expect(await originalTool.execute(args)).toEqual({ ...initial, cached: true });
    }
  });

  it("does not send an already canceled MiniMax search", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(searchResponse());
    const tool = createTool();
    const controller = new AbortController();
    controller.abort(new Error("MiniMax caller canceled"));

    await expect(
      tool.execute({ query: "minimax pre-canceled" }, { signal: controller.signal }),
    ).rejects.toThrow("MiniMax caller canceled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts the guarded MiniMax request with the caller's reason", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          if (!init?.signal) {
            reject(new Error("MiniMax request lost caller cancellation"));
            return;
          }
          init.signal.addEventListener("abort", () => reject(init.signal?.reason as Error), {
            once: true,
          });
        }),
    );
    const tool = createTool();
    const controller = new AbortController();
    const result = tool.execute(
      { query: "minimax in-flight cancellation" },
      { signal: controller.signal },
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort(new Error("MiniMax request canceled in flight"));
    await expect(result).rejects.toThrow("MiniMax request canceled in flight");
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  const globalEndpoint = "https://api.minimax.io/v1/coding_plan/search";
  const cnEndpoint = "https://api.minimaxi.com/v1/coding_plan/search";
  const cnProvider = (id = "minimax"): OpenClawConfig => ({
    models: { providers: { [id]: { baseUrl: "https://api.minimaxi.com/v1", models: [] } } },
  });
  it.each<[string, string, Record<string, string>?, OpenClawConfig?, string?]>([
    [
      "configured global over CN provider",
      globalEndpoint,
      { MINIMAX_CODE_PLAN_KEY: "ignored-env-key" },
      cnProvider(),
      "global",
    ],
    ["explicit CN", cnEndpoint, { MINIMAX_CODE_PLAN_KEY: apiKey }, {}, "cn"],
    ["CN model provider", cnEndpoint, {}, cnProvider()],
    ["CN portal provider", cnEndpoint, {}, cnProvider("minimax-portal")],
    [
      "shared CN host with coding key",
      cnEndpoint,
      {
        MINIMAX_API_HOST: "https://api.minimaxi.com/anthropic",
        MINIMAX_CODING_API_KEY: apiKey,
      },
    ],
    [
      "OAuth before legacy key",
      globalEndpoint,
      { MINIMAX_OAUTH_TOKEN: apiKey, MINIMAX_API_KEY: "ignored-legacy-key" },
    ],
    ["legacy API key", globalEndpoint, { MINIMAX_API_KEY: apiKey }],
  ])(
    "routes %s searches through the public tool boundary",
    async (name, endpoint, env, config, region) => {
      Object.assign(process.env, env);
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(searchResponse());
      const tool = createTool(
        {
          apiKey: Object.values(env ?? {}).includes(apiKey) ? undefined : apiKey,
          region,
        },
        config,
      );

      await tool.execute({ query: `MiniMax ${name}` });
      expect(fetchMock.mock.calls[0]?.[0]).toBe(endpoint);
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
        Authorization: `Bearer ${apiKey}`,
      });
    },
  );
});
