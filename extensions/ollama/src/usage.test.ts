import { describe, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../../test-support/model-provider-config.test-support.js";
import { createOllamaUsageHooks } from "./usage-registration.js";
import { fetchOllamaUsage } from "./usage.js";

const baseParams = {
  baseUrl: "http://127.0.0.1:11434",
  token: "ollama-local",
  timeoutMs: 5000,
};

describe("Ollama balance usage", () => {
  it("resolves local auth and strips a legacy /v1 model base path", async () => {
    const hooks = createOllamaUsageHooks();
    const config = createModelProviderConfig({
      ollama: {
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "ollama",
        apiKey: "ollama-local",
        models: [],
      },
    });
    const auth = await hooks.resolveUsageAuth?.({
      config,
      env: {},
      provider: "ollama",
      resolveApiKeyFromConfigAndStore: () => "ollama-local",
      resolveOAuthToken: async () => null,
    });
    expect(auth).toEqual({ token: "ollama-local" });
    const fetchFn = vi.fn(async () =>
      Response.json({ included: { session: { remaining_percent: 80 } } }),
    );
    const snapshot = await hooks.fetchUsageSnapshot?.({
      config,
      env: {},
      provider: "ollama",
      token: "ollama-local",
      timeoutMs: 5000,
      fetchFn,
    });
    expect(snapshot?.windows).toEqual([{ label: "Session", usedPercent: 20 }]);
    expect(fetchFn).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/balance",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("maps legacy remaining quota and reset times to used windows", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({
        included: {
          session: { remaining_percent: 99.94, resets_at: "2026-10-09T00:00:00Z" },
          weekly: { remaining_percent: 92.36, resets_at: "2026-10-12T00:00:00Z" },
        },
        purchased: { balance_usd: 4.25 },
      }),
    );
    const snapshot = await fetchOllamaUsage({ ...baseParams, fetchFn });
    expect(snapshot.provider).toBe("ollama");
    expect(snapshot.windows.map(({ label, resetAt }) => ({ label, resetAt }))).toEqual([
      { label: "Session", resetAt: Date.parse("2026-10-09T00:00:00Z") },
      { label: "Week", resetAt: Date.parse("2026-10-12T00:00:00Z") },
    ]);
    expect(snapshot.windows[0]?.usedPercent).toBeCloseTo(0.06);
    expect(snapshot.windows[1]?.usedPercent).toBeCloseTo(7.64);
    expect(snapshot.billing).toEqual([
      { type: "balance", label: "Purchased balance", amount: 4.25, unit: "USD" },
    ]);
    expect(fetchFn).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/balance",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("maps current plan balance to a resettable included window", async () => {
    const snapshot = await fetchOllamaUsage({
      ...baseParams,
      baseUrl: "https://ollama.example",
      token: "remote-key",
      fetchFn: vi.fn(async () =>
        Response.json({
          included: {
            allowance_usd: 100,
            balance_usd: 72.5,
            period: { until: "2026-10-15T09:30:00Z" },
          },
          purchased: { balance_usd: 25 },
        }),
      ) as unknown as typeof fetch,
    });
    expect(snapshot.windows[0]?.label).toBe("Included");
    expect(snapshot.windows[0]?.usedPercent).toBeCloseTo(27.5);
    expect(snapshot.windows[0]?.resetAt).toBe(Date.parse("2026-10-15T09:30:00Z"));
    expect(snapshot.billing).toEqual([
      { type: "balance", label: "Included balance", amount: 72.5, unit: "USD" },
      { type: "balance", label: "Purchased balance", amount: 25, unit: "USD" },
    ]);
  });

  it("reports HTTP failures without exposing response contents", async () => {
    const snapshot = await fetchOllamaUsage({
      ...baseParams,
      fetchFn: vi.fn(async () => new Response("private", { status: 403 })),
    });
    expect(snapshot.error).toBe("HTTP 403");
    expect(snapshot.windows).toEqual([]);
  });

  it.each([
    [401, "Sign in to Ollama Cloud on the configured server"],
    [404, "Update the configured Ollama server to 0.40.1+"],
  ])("gives a recovery action for HTTP %i", async (status, message) => {
    const snapshot = await fetchOllamaUsage({
      ...baseParams,
      fetchFn: vi.fn(async () => new Response("private", { status })),
    });
    expect(snapshot.error).toBe(message);
    expect(snapshot.windows).toEqual([]);
  });

  it("does not manufacture a quota from malformed or empty responses", async () => {
    for (const body of [
      null,
      { included: {} },
      { included: { session: { remaining_percent: 200 } } },
    ]) {
      const snapshot = await fetchOllamaUsage({
        ...baseParams,
        fetchFn: vi.fn(async () => Response.json(body)),
      });
      expect(snapshot.error).toBeTruthy();
      expect(snapshot.windows).toEqual([]);
    }
  });
});
