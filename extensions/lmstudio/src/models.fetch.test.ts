import type { ProviderCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import { afterAll, afterEach, assert, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../../test-support/model-provider-config.test-support.js";
import { cancelTrackedTextResponse } from "../../test-support/streaming-error-response.js";
import plugin from "../index.js";
import { fetchLmstudioModels } from "./models.fetch.js";
import { discoverLmstudioProvider } from "./setup.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  vi.unstubAllGlobals();
});

function context(headers?: Record<string, string>, keyless = false): ProviderCatalogContext {
  return {
    config: createModelProviderConfig({
      lmstudio: {
        baseUrl: "http://localhost:1234/api/v1/",
        apiKey: keyless ? undefined : "configured-key",
        headers,
        models: [],
      },
    }),
    env: {},
    resolveProviderApiKey: () =>
      keyless
        ? { apiKey: undefined }
        : {
            apiKey: "LM_API_TOKEN",
            discoveryApiKey: "profile-key",
            profileId: "lmstudio:profile",
          },
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
  };
}

const catalog = capturePluginRegistration(plugin).providers[0]?.catalog;
assert(catalog);
const runCatalog = catalog.run;

it.each([401, 503, "disconnect", "invalid-json", "missing-models", "header"])(
  "reports %s as failed acquisition while preserving the public advisory helper",
  async (failure) => {
    const fetchMock = vi.fn(async () => {
      if (failure === "disconnect") {
        throw new Error("connection reset");
      }
      return new Response(failure === "invalid-json" ? "{" : "{}", {
        status: failure === "header" ? 403 : typeof failure === "number" ? failure : 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const key = failure === "header" ? "header-key" : "profile-key";
    const ctx = context(failure === "header" ? { Authorization: `Bearer ${key}` } : undefined);
    const rejected = failure === 401 || failure === "header";
    const outcome = {
      provider: "lmstudio",
      ...(failure === "header" ? {} : { profileId: "lmstudio:profile" }),
      status: rejected ? "auth-rejected" : "unavailable",
      ...(rejected ? { rejectionScope: "catalog" } : {}),
    };
    await expect(runCatalog(ctx)).resolves.toEqual({ providers: {}, outcomes: [outcome] });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:1234/api/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: expect.any(AbortSignal),
    });
    await expect(discoverLmstudioProvider(ctx)).resolves.toMatchObject({
      provider: { models: [] },
    });
  },
);

it("retains configured and optional empty listings while the public helper stays quiet", async () => {
  const fetchMock = vi.fn(async () => Response.json({ models: [] }));
  vi.stubGlobal("fetch", fetchMock);
  const ctx = context(undefined, true);
  await expect(runCatalog(ctx)).resolves.toMatchObject({
    provider: { models: [] },
    outcomes: [{ provider: "lmstudio", status: "ready" }],
  });
  await expect(discoverLmstudioProvider(ctx)).resolves.toBeNull();
  ctx.config = {};
  const modelIdCatalog = { baseUrl: "http://localhost:1234/v1", modelIds: [], aliases: [] };
  await expect(runCatalog(ctx)).resolves.toEqual({
    providers: {},
    outcomes: [{ provider: "lmstudio", status: "ready", modelIdCatalog }],
  });
  fetchMock.mockRejectedValueOnce(new Error("optional server offline"));
  await expect(runCatalog(ctx)).resolves.toBeNull();
  fetchMock.mockClear();
  await expect(runCatalog({ ...context(), providerIds: ["another-provider"] })).resolves.toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("releases guarded non-ok discovery without waiting for the capture clone", async () => {
  const tracked = cancelTrackedTextResponse("unavailable", { status: 503 });
  const captureClone = tracked.response.clone();
  const release = vi.fn(async () => undefined);
  fetchWithSsrFGuardMock.mockResolvedValue({ response: tracked.response, release });
  const request = fetchLmstudioModels({ baseUrl: "http://localhost:1234/v1", ssrfPolicy: {} });
  try {
    const result = await raceWithTimeout(request, 500, () => {
      throw new Error("LM Studio cleanup waited for the capture clone");
    });
    expect(result).toMatchObject({ reachable: true, status: 503, models: [] });
    expect(tracked.response.bodyUsed).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  } finally {
    await captureClone.body?.cancel().catch(() => undefined);
    await request;
  }
  expect(tracked.wasCanceled()).toBe(true);
});
