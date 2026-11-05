import { describe, expect, it, vi } from "vitest";
import { fetchOpenAIUsage, resolveOpenAIUsageAuth } from "./usage.js";

function resolveAuth(overrides: Partial<Parameters<typeof resolveOpenAIUsageAuth>[0]> = {}) {
  return resolveOpenAIUsageAuth({
    config: {},
    env: {},
    provider: "openai",
    resolveApiKeyFromConfigAndStore: () => undefined,
    resolveOAuthToken: async () => null,
    ...overrides,
  });
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input);
}

function usagePage(results: Record<string, unknown>[]) {
  return Response.json({
    data: [{ start_time: 1_783_296_000, end_time: 1_783_382_400, results }],
    has_more: false,
  });
}
const tokenTotals = (
  requests: number,
  inputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  outputTokens: number,
  totalTokens: number,
) => ({ requests, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, totalTokens });
const fetchUsage = (token: string, fetchFn: typeof fetch, env = {}) =>
  fetchOpenAIUsage({ config: {}, env, provider: "openai", token, timeoutMs: 5_000, fetchFn });

async function fetchAdminUsage(
  fetchFn: typeof fetch,
  projectId?: string,
  apiKey = "sk-admin-test",
) {
  const auth = await resolveAuth({ env: { OPENAI_ADMIN_KEY: apiKey } });
  if (!("token" in auth) || !auth.token) {
    throw new Error("expected encoded OpenAI admin token");
  }
  return await fetchUsage(auth.token, fetchFn, projectId ? { OPENAI_PROJECT_ID: projectId } : {});
}

describe("OpenAI provider usage", () => {
  it.each([
    [
      "rejects token-sharing credentials",
      undefined,
      { token: "test-chatpass-token", authFlow: "chatgpt-token-sharing" },
      { handled: true },
    ],
    [
      "prefers an explicit admin key over OAuth",
      "sk-admin-explicit",
      { token: "oauth-token" },
      { token: 'openclaw:openai-admin:v1:{"token":"sk-admin-explicit"}' },
    ],
    ["does not repurpose inference credentials", undefined, null, { handled: true }],
  ] as const)("%s", async (_name, adminKey, oauth, expected) => {
    const resolveApiKeyFromConfigAndStore = vi.fn(() => "sk-proj-inference");
    const resolveCandidates = vi.fn(async () => ["sk-admin-secretref"]);
    const result = await resolveAuth({
      config: {
        models: { providers: { openai: { baseUrl: "https://proxy.example.test/v1", models: [] } } },
      },
      env: { OPENAI_ADMIN_KEY: adminKey },
      resolveApiKeyFromConfigAndStore,
      resolveApiKeyCandidatesFromConfigAndStore: resolveCandidates,
      resolveOAuthToken: async () => oauth,
    });
    expect(result).toEqual(expected);
    expect(resolveApiKeyFromConfigAndStore).not.toHaveBeenCalled();
    expect(resolveCandidates).not.toHaveBeenCalled();
  });
  it.each([
    {
      name: "project costs and cached tokens",
      usage: { input_tokens: 1_000, input_cached_tokens: 400, output_tokens: 250 },
      tokens: tokenTotals(8, 600, 400, 0, 250, 1_250),
      projectId: "proj_test",
    },
    {
      name: "the documented mixed-modality and cache-write response",
      // https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/completions
      usage: {
        input_tokens: 1_000,
        input_cached_tokens: 400,
        input_cache_write_tokens: 75,
        input_cache_write_12h_tokens: 25,
        input_uncached_tokens: 500,
        output_tokens: 500,
        input_text_tokens: 400,
        output_text_tokens: 400,
        input_cached_text_tokens: 300,
        input_audio_tokens: 50,
        input_cached_audio_tokens: 50,
        output_audio_tokens: 50,
        input_image_tokens: 50,
        input_cached_image_tokens: 50,
        output_image_tokens: 50,
      },
      tokens: tokenTotals(5, 500, 400, 100, 500, 1_500),
      projectId: undefined,
    },
    {
      name: "audio totals without optional text or cache breakdowns",
      usage: {
        input_tokens: 200,
        input_audio_tokens: 200,
        output_tokens: 300,
        output_audio_tokens: 300,
      },
      tokens: tokenTotals(5, 200, 0, 0, 300, 500),
      projectId: undefined,
    },
  ])("aggregates $name without double-counting", async ({ usage, tokens, projectId }) => {
    const { requests, totalTokens } = tokens;
    const model = projectId ? "gpt-5.5" : "test-model";
    const costs = projectId
      ? [{ amount: { value: "12.34", currency: "usd" }, line_item: "Responses" }]
      : [];
    const fetchFn = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
      requestUrl(input).pathname.endsWith("/organization/costs")
        ? projectId
          ? usagePage(costs)
          : Response.json({ data: [], has_more: false })
        : usagePage([{ ...usage, num_model_requests: requests, model }]),
    );
    const result = await fetchAdminUsage(fetchFn, projectId);
    const summary = `${requests} requests · ${totalTokens.toLocaleString("en-US")} tokens`;
    expect(result.costHistory?.daily).toEqual([
      { date: "2026-07-06", amount: projectId ? 12.34 : 0, ...tokens },
    ]);
    expect(result.costHistory?.models).toEqual([{ name: model, ...tokens }]);
    expect(result.summary).toBe(summary);
    if (projectId) {
      expect(result).toMatchObject({
        plan: "Admin API · proj_test",
        billing: [
          { type: "spend", label: "30-day API spend", amount: 12.34, unit: "USD", period: "30d" },
        ],
        costHistory: {
          unit: "USD",
          periodDays: 30,
          scope: "Project proj_test",
          categories: [{ name: "Responses", amount: 12.34 }],
        },
      });
      expect(fetchFn).toHaveBeenCalledTimes(2);
      for (const [input, init] of fetchFn.mock.calls) {
        const url = requestUrl(input);
        expect(url.searchParams.get("project_ids")).toBe(projectId);
        expect(url.searchParams.get("bucket_width")).toBe("1d");
        expect(init?.headers).toMatchObject({ Authorization: "Bearer sk-admin-test" });
      }
    }
  });

  it("reports when organization usage rejects a non-admin key", async () => {
    const result = await fetchAdminUsage(
      async () => new Response("", { status: 403 }),
      undefined,
      "sk-proj-test",
    );
    expect(result.error).toBe("Admin API key required");
  });

  it("attaches the ChatGPT account email from the access-token claims", async () => {
    // Assembled parts keep the fixture from reading as a real credential.
    const claims = Buffer.from(
      JSON.stringify({ "https://api.openai.com/profile": { email: "codex@example.com" } }),
      "utf8",
    ).toString("base64url");
    const accessToken = ["fake-header", claims, "fake-sig"].join(".");
    const snapshot = await fetchUsage(accessToken, async () =>
      Response.json({
        plan_type: "pro",
        rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 12 } },
      }),
    );
    expect(snapshot.accountEmail).toBe("codex@example.com");
    expect(snapshot.windows.length).toBeGreaterThan(0);
  });
});
