import { describe, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../../test-support/model-provider-config.test-support.js";
import { createOllamaUsageHooks } from "./usage-registration.js";
import { fetchOllamaUsage } from "./usage.js";

const baseParams = { baseUrl: "http://127.0.0.1:11434", token: "ollama-local", timeoutMs: 5000 };
const malformedResponse =
  "Malformed balance response. Check the configured Ollama server's /api/balance response, then retry.";
const noBalance = "No balance data. Check the configured server's Ollama Cloud account.";
const httpError = (status: number) => new Response("private", { status });

function mockUsage(body: unknown) {
  return vi.fn(async () => {
    if (body instanceof Error) {
      throw body;
    }
    return body instanceof Response ? body : Response.json(body);
  });
}
function window(label: string, percent: number, reset: string) {
  return { label, usedPercent: expect.closeTo(percent), resetAt: Date.parse(reset) };
}
function balance(label: string, amount: number) {
  return { type: "balance", label: `${label} balance`, amount, unit: "USD" };
}

describe("Ollama balance usage", () => {
  it.each([
    ["literal", "endpoint-key"],
    ["SecretRef", { source: "env", provider: "default", id: "OLLAMA_USAGE_TEST_KEY" }],
  ] as const)("prefers %s endpoint credentials", async (_credential, apiKey) => {
    const hooks = createOllamaUsageHooks();
    const config = createModelProviderConfig({
      ollama: { baseUrl: "https://ollama.example/v1", api: "ollama", apiKey, models: [] },
    });
    const env = { OLLAMA_API_KEY: "ambient-cloud-key", OLLAMA_USAGE_TEST_KEY: "endpoint-key" };
    const context = { config, env, provider: "ollama" };
    const auth = await hooks.resolveUsageAuth?.({
      ...context,
      resolveApiKeyFromConfigAndStore: () => env.OLLAMA_API_KEY,
      resolveOAuthToken: async () => null,
    });
    expect(auth).toEqual({ token: "endpoint-key" });
    if (!auth || !("token" in auth)) {
      throw new Error("Expected configured endpoint usage token");
    }
    const fetchFn = mockUsage({ included: { session: { remaining_percent: 80 } } });
    await hooks.fetchUsageSnapshot?.({
      ...context,
      token: auth.token,
      timeoutMs: 5000,
      fetchFn,
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://ollama.example/api/balance",
      expect.objectContaining({
        headers: { Accept: "application/json", Authorization: "Bearer endpoint-key" },
      }),
    );
  });

  it.each([
    {
      name: "legacy remaining quota",
      included: {
        session: { remaining_percent: 99.94, resets_at: "2026-10-09T00:00:00Z" },
        weekly: { remaining_percent: 92.36, resets_at: "2026-10-12T00:00:00Z" },
      },
      purchased: 4.25,
      windows: [
        window("Session", 0.06, "2026-10-09T00:00:00Z"),
        window("Week", 7.64, "2026-10-12T00:00:00Z"),
      ],
      billing: [balance("Purchased", 4.25)],
      options: baseParams,
      headers: { Accept: "application/json" },
    },
    {
      name: "current plan",
      included: {
        allowance_usd: 100,
        balance_usd: 72.5,
        period: { until: "2026-10-15T09:30:00Z" },
      },
      purchased: 25,
      windows: [window("Included", 27.5, "2026-10-15T09:30:00Z")],
      billing: [balance("Included", 72.5), balance("Purchased", 25)],
      options: { baseUrl: "https://ollama.example", token: "remote-key" },
      headers: { Accept: "application/json", Authorization: "Bearer remote-key" },
    },
  ])(
    "maps $name to resettable usage",
    async ({ included, purchased, windows, billing, options, headers }) => {
      const fetchFn = mockUsage({ included, purchased: { balance_usd: purchased } });
      expect(await fetchOllamaUsage({ ...baseParams, ...options, fetchFn })).toEqual({
        provider: "ollama",
        displayName: "Ollama",
        windows,
        billing,
      });
      expect(fetchFn).toHaveBeenCalledWith(
        `${options.baseUrl}/api/balance`,
        expect.objectContaining({ headers }),
      );
    },
  );

  it.each([
    [403, httpError(403), "HTTP 403: Check the configured Ollama server's access permissions"],
    [500, httpError(500), "HTTP 500: Check the configured Ollama server and retry"],
    [
      "unreachable server",
      new Error("private network details"),
      "Usage unavailable. Check that the configured Ollama server is reachable, then retry.",
    ],
    ["invalid JSON", new Response("private invalid JSON"), malformedResponse],
    ["non-object JSON", null, malformedResponse],
    ["empty balance", { included: {} }, noBalance],
    ["out-of-range quota", { included: { session: { remaining_percent: 200 } } }, noBalance],
  ])("gives safe recovery guidance for %s", async (_name, body, error) => {
    const snapshot = await fetchOllamaUsage({ ...baseParams, fetchFn: mockUsage(body) });
    expect(snapshot).toMatchObject({ error, windows: [] });
  });
});
