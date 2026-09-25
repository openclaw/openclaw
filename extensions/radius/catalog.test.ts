import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRadiusCatalog } from "./catalog.js";

const fetchGuard = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchGuard,
}));

const MODEL = {
  id: "organization/custom-model",
  name: "Organization model",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 200_000,
  maxTokens: 32_000,
  cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

function respond(body: unknown, status = 200) {
  const release = vi.fn(async () => undefined);
  fetchGuard.mockResolvedValue({
    response: Response.json(body, { status }),
    finalUrl: "https://radius.pi.dev/v1/config",
    release,
  });
  return release;
}

afterEach(() => vi.resetAllMocks());

describe("Radius catalog", () => {
  it("projects the organization catalog, preserving reasoning and strict pricing thresholds", async () => {
    const release = respond({
      baseUrl: "https://radius.pi.dev/v1/",
      models: [
        { ...MODEL, enabled: false },
        {
          ...MODEL,
          thinkingLevelMap: { off: "none", minimal: null, high: "high", max: "max" },
          cost: {
            ...MODEL.cost,
            tiers: [
              { inputTokensAbove: 100_000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 },
            ],
          },
          lab: "Example",
          providers: [{ id: "organization-provider" }],
        },
      ],
    });
    const controller = new AbortController();
    const catalog = await fetchRadiusCatalog("test-radius-token", controller.signal);
    expect(catalog).toEqual({
      baseUrl: "https://radius.pi.dev/v1",
      api: "pi-messages",
      models: [
        {
          ...MODEL,
          thinkingLevelMap: { off: "none", minimal: null, high: "high", max: "max" },
          cost: {
            ...MODEL.cost,
            tieredPricing: [
              { ...MODEL.cost, range: [0, 100_001] },
              { input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5, range: [100_001] },
            ],
          },
        },
      ],
    });
    const request = fetchGuard.mock.calls[0]?.[0];
    expect(request.url).toBe("https://radius.pi.dev/v1/config");
    expect(new Headers(request.init.headers).get("authorization")).toBe("Bearer test-radius-token");
    expect(request.signal).toBe(controller.signal);
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps an empty account catalog authoritative and skips malformed models", async () => {
    respond({
      baseUrl: "https://radius.pi.dev/v1",
      models: [
        { ...MODEL, maxTokens: 0 },
        { ...MODEL, cost: { ...MODEL.cost, input: -1 } },
        { ...MODEL, thinkingLevelMap: { high: false } },
        { ...MODEL, input: ["unsupported"] },
      ],
    });
    expect((await fetchRadiusCatalog()).models).toEqual([]);
    expect(new Headers(fetchGuard.mock.calls[0]?.[0].init.headers).has("authorization")).toBe(
      false,
    );
    respond({ baseUrl: "https://radius.pi.dev/v1", models: [] });
    expect((await fetchRadiusCatalog()).models).toEqual([]);
  });

  it("surfaces authentication failures and malformed catalogs without a fabricated fallback", async () => {
    const release = respond({ error: "invalid_token" }, 401);
    await expect(fetchRadiusCatalog("test-expired-token")).rejects.toMatchObject({ status: 401 });
    expect(release).toHaveBeenCalledOnce();
    respond({ models: [MODEL] });
    await expect(fetchRadiusCatalog()).rejects.toThrow("Invalid Radius catalog");
  });
});
