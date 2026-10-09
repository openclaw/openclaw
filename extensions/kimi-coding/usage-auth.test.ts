import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createProviderUsageFetch, makeResponse } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const official = "https://api.kimi.com/coding/";
const credentialUrl = new URL(official);
credentialUrl.username = "test-user";
credentialUrl.password = "test-password";

function usageContext(baseUrls?: readonly string[]) {
  return {
    config: {},
    env: {},
    provider: "kimi",
    resolveModelBaseUrls: vi.fn(async () => baseUrls),
    resolveApiKeyFromConfigAndStore: vi.fn(() => "unexpected-sync-key"),
    resolveApiKeyCandidatesFromConfigAndStore: vi.fn(async () => ["test-resolved-secret-ref"]),
    resolveOAuthToken: vi.fn(async () => null),
  };
}

describe("Kimi usage route authority", () => {
  it.each([
    { name: "unknown", routes: undefined },
    { name: "empty", routes: [] },
    { name: "proxy", routes: ["https://proxy.example.test/coding/"] },
    { name: "mixed aliases", routes: [official, "https://proxy.example.test/coding/"] },
    { name: "mixed regions", routes: [official, "https://api.kimi.ai/coding/"] },
    { name: "URL credentials", routes: [credentialUrl.href] },
    { name: "query", routes: ["https://api.kimi.com/coding/?route=proxy"] },
    { name: "fragment", routes: ["https://api.kimi.com/coding/#proxy"] },
  ])("skips $name before credentials and also with caller-supplied auth", async ({ routes }) => {
    const provider = await registerSingleProviderPlugin(plugin);
    const context = usageContext(routes);
    const fetchFn = vi.fn<typeof fetch>();

    await expect(provider.resolveUsageAuth?.(context)).resolves.toEqual({ handled: true });
    await expect(
      provider.fetchUsageSnapshot?.({
        ...context,
        token: "test-caller-token",
        timeoutMs: 1000,
        fetchFn,
      }),
    ).resolves.toBeNull();

    expect(context.resolveModelBaseUrls).toHaveBeenCalledWith(["kimi", "kimi-code", "kimi-coding"]);
    expect(context.resolveApiKeyFromConfigAndStore).not.toHaveBeenCalled();
    expect(context.resolveApiKeyCandidatesFromConfigAndStore).not.toHaveBeenCalled();
    expect(context.resolveOAuthToken).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each(["api.kimi.com", "api.kimi.ai"])(
    "uses resolved API-key candidates only for %s",
    async (host) => {
      const provider = await registerSingleProviderPlugin(plugin);
      const context = usageContext([`https://${host}/coding/`, `https://${host}/coding/v1/`]);
      const auth = await provider.resolveUsageAuth?.(context);
      expect(auth).toEqual({ token: "test-resolved-secret-ref" });
      expect(context.resolveApiKeyFromConfigAndStore).not.toHaveBeenCalled();
      expect(context.resolveApiKeyCandidatesFromConfigAndStore).toHaveBeenCalledWith({
        providerIds: ["kimi", "kimi-code", "kimi-coding"],
        envDirect: [undefined, undefined],
      });
      const fetchFn = createProviderUsageFetch(async (url, init) => {
        expect(url).toBe(`https://${host}/coding/v1/usages`);
        expect(init?.redirect).toBe("error");
        expect(init?.headers).toMatchObject({ Authorization: "Bearer test-resolved-secret-ref" });
        return makeResponse(200, {
          usages: { limit_5h: { used_ratio: 0.25 }, limit_7d: { used_ratio: 0.5 } },
        });
      });
      await expect(
        provider.fetchUsageSnapshot?.({
          ...context,
          token: "test-resolved-secret-ref",
          timeoutMs: 1000,
          fetchFn,
        }),
      ).resolves.toMatchObject({
        windows: [
          { label: "5h", usedPercent: 25 },
          { label: "7d", usedPercent: 50 },
        ],
      });
    },
  );
});
