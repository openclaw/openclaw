import { afterEach, expect, it, vi } from "vitest";
import { fetchRadiusCatalog } from "./catalog.js";
import { catalogModel } from "./test-support.js";

const fetchGuard = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchGuard,
}));

const BASE_URL = "https://radius.pi.dev/v1";
const MODEL = {
  ...catalogModel("organization/custom-model", "Organization model", 200_000),
  input: ["text", "image"],
  thinkingLevelMap: { off: "none", minimal: null, high: "high", max: "max" },
};
const TIER = { input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 };

function respond(body: object, status = 200) {
  const release = vi.fn(async () => undefined);
  const response = Response.json({ baseUrl: BASE_URL, ...body }, { status });
  fetchGuard.mockResolvedValue({ response, finalUrl: `${BASE_URL}/config`, release });
  return release;
}

afterEach(() => vi.resetAllMocks());

it("projects the organization catalog, preserving reasoning and strict pricing thresholds", async () => {
  const model = {
    ...MODEL,
    cost: { ...MODEL.cost, tiers: [{ inputTokensAbove: 100_000, ...TIER }] },
    lab: "Example",
    providers: [{ id: "organization-provider" }],
  };
  const release = respond({
    baseUrl: `${BASE_URL}/`,
    models: [{ ...MODEL, enabled: false }, model],
  });
  const controller = new AbortController();
  const tieredPricing = [
    { ...MODEL.cost, range: [0, 100_001] },
    { ...TIER, range: [100_001] },
  ];
  expect(await fetchRadiusCatalog("test-radius-token", controller.signal)).toEqual({
    baseUrl: BASE_URL,
    api: "pi-messages",
    models: [{ ...MODEL, cost: { ...MODEL.cost, tieredPricing } }],
  });
  const request = fetchGuard.mock.calls[0]?.[0];
  expect(request.url).toBe("https://radius.pi.dev/v1/config");
  expect(new Headers(request.init.headers).get("authorization")).toBe("Bearer test-radius-token");
  expect(request.signal).toBe(controller.signal);
  expect(release).toHaveBeenCalledOnce();
});

it.for([
  [],
  [
    { ...MODEL, maxTokens: 0 },
    { ...MODEL, cost: { ...MODEL.cost, input: -1 } },
    { ...MODEL, thinkingLevelMap: { high: false } },
    { ...MODEL, input: ["unsupported"] },
  ],
])("keeps unavailable catalog %j authoritative without credentials", async (models) => {
  respond({ models });
  expect((await fetchRadiusCatalog()).models).toEqual([]);
  const headers = new Headers(fetchGuard.mock.calls[0]?.[0].init.headers);
  expect(headers.has("authorization")).toBe(false);
});

it("surfaces authentication failures and malformed catalogs without a fabricated fallback", async () => {
  const release = respond({ error: "invalid_token" }, 401);
  await expect(fetchRadiusCatalog("test-expired-token")).rejects.toMatchObject({ status: 401 });
  expect(release).toHaveBeenCalledOnce();
  respond({ baseUrl: undefined, models: [MODEL] });
  await expect(fetchRadiusCatalog()).rejects.toThrow("Invalid Radius catalog");
});
