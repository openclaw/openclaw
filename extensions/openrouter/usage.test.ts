import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import type { ProviderFetchUsageSnapshotContext } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import openrouterPlugin from "./index.js";

const provider = await registerSingleProviderPlugin(openrouterPlugin);

async function fetchUsage(
  fetchFn: typeof fetch,
  params: Partial<Pick<ProviderFetchUsageSnapshotContext, "token" | "timeoutMs" | "signal">> & {
    baseUrl?: string;
    request?: ModelProviderConfig["request"];
  } = {},
) {
  assert(provider.fetchUsageSnapshot, "OpenRouter usage provider is not registered");
  const openrouter = {
    baseUrl: params.baseUrl ?? "https://openrouter.ai/api/v1",
    request: params.request,
    models: [],
  };
  const snapshot = await provider.fetchUsageSnapshot({
    config: { models: { providers: { openrouter } } },
    env: {},
    provider: "openrouter",
    token: "router-key",
    timeoutMs: 5000,
    ...params,
    fetchFn,
  });
  assert(snapshot, "OpenRouter usage provider returned no snapshot");
  return snapshot;
}
function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}
const proxyBaseUrl = "https://private.example.invalid/router/v1";
const privateBaseUrl = "http://127.0.0.1:17455/private/v1";
const usageFetch = () => vi.fn<typeof fetch>(async () => Response.json({ data: { usage: 1 } }));
const budgetFields = { type: "budget", label: "API key budget", unit: "USD" };

function expectDestinations(fetchFn: ReturnType<typeof usageFetch>, baseUrl: string) {
  expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([`${baseUrl}/credits`, `${baseUrl}/key`]);
}
function fetchResponses(credits: Response, key: Response) {
  return vi.fn<typeof fetch>(async (input) =>
    requestUrl(input).endsWith("/credits") ? credits : key,
  );
}
const json = (data: Record<string, unknown>) => Response.json({ data });

function mockGuardedFetch(fallback?: typeof fetch) {
  const release = vi.fn(async () => undefined);
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async (params) => {
    const fetchFn = params.fetchImpl ?? fallback;
    assert(fetchFn, "expected the operator-owned usage fetch implementation");
    return { response: await fetchFn(params.url, params.init), finalUrl: params.url, release };
  });
  return { release };
}
function fetchKeyBudget(data: Record<string, unknown>) {
  return fetchUsage(fetchResponses(new Response(null, { status: 403 }), Response.json({ data })));
}

afterEach(() => vi.restoreAllMocks());

it("combines account credits with key quota and period spend", async () => {
  const fetchFn = fetchResponses(
    json({ total_credits: 100, total_usage: 35.5 }),
    json({
      label: "Production",
      limit: 20,
      limit_remaining: 15,
      limit_reset: "monthly",
      usage: 35,
      usage_daily: 1.25,
      usage_weekly: 3.5,
      usage_monthly: 5,
    }),
  );
  const snapshot = await fetchUsage(fetchFn);
  expect(snapshot).toEqual({
    provider: "openrouter",
    displayName: "OpenRouter",
    windows: [{ label: "Monthly key budget", usedPercent: 25 }],
    billing: [
      { type: "balance", label: "Account balance", amount: 64.5, unit: "USD" },
      { type: "spend", label: "Account usage", amount: 35.5, unit: "USD" },
      { ...budgetFields, used: 5, limit: 20, period: "monthly" },
    ],
    summary: "$1.25 today · $3.50 this week · $5.00 this month",
    plan: "Production",
  });
  expect(fetchFn).toHaveBeenCalledTimes(2);
});

it.each([
  {
    name: "bearer",
    request: undefined,
    headers: { authorization: "Bearer synthetic-private-proxy-key" },
  },
  {
    name: "custom",
    request: {
      headers: { "X-Private-Proxy-Tenant": "synthetic-tenant" },
      auth: { mode: "header" as const, headerName: "X-Proxy-Key", value: "synthetic-override-key" },
    },
    headers: {
      "x-private-proxy-tenant": "synthetic-tenant",
      "x-proxy-key": "synthetic-override-key",
    },
  },
])("keeps $name credentials on both configured usage endpoints", async ({ request, headers }) => {
  const fetchFn = usageFetch();
  await fetchUsage(fetchFn, {
    token: "synthetic-private-proxy-key",
    baseUrl: `${proxyBaseUrl}///`,
    request,
  });
  expectDestinations(fetchFn, proxyBaseUrl);
  for (const [, options] of fetchFn.mock.calls) {
    const sent = new Headers(options?.headers);
    expect(Object.fromEntries(sent)).toMatchObject(headers);
    expect(sent.has("authorization")).toBe(request === undefined);
  }
});

it("blocks explicitly denied private usage destinations before fetch", async () => {
  const fetchFn = usageFetch();
  const snapshot = await fetchUsage(fetchFn, {
    baseUrl: privateBaseUrl,
    request: {
      allowPrivateNetwork: false,
    },
    timeoutMs: 1000,
  });
  expect(fetchFn).not.toHaveBeenCalled();
  expect(snapshot).toMatchObject({
    provider: "openrouter",
    error: expect.stringContaining("Usage unavailable"),
  });
});

it("routes explicit proxies through canonical, not ambient, fetch", async () => {
  const ambientProxyFetch = usageFetch();
  const canonicalRuntimeFetch = usageFetch();
  mockGuardedFetch(canonicalRuntimeFetch);
  await fetchUsage(ambientProxyFetch, {
    baseUrl: proxyBaseUrl,
    request: {
      proxy: {
        mode: "explicit-proxy",
        url: "https://corporate-proxy.example.invalid:8443",
        tls: { ca: "synthetic-proxy-ca" },
      },
    },
  });
  expect(ambientProxyFetch).not.toHaveBeenCalled();
  expect(canonicalRuntimeFetch).toHaveBeenCalledTimes(2);
});

it("reports nested transport causes", async () => {
  const fetchFn = vi.fn<typeof fetch>(async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("invalid onRequestStart method"), {
        code: "UND_ERR_INVALID_ARG",
      }),
    });
  });
  const snapshot = await fetchUsage(fetchFn, { baseUrl: proxyBaseUrl });
  expect(snapshot.error).toBe(
    "Usage unavailable: fetch failed | invalid onRequestStart method | UND_ERR_INVALID_ARG",
  );
});

it("surfaces blocked usage redirects without replaying private credentials", async () => {
  const fetchFn = vi.fn<typeof fetch>(
    async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://attacker.example.invalid/capture" },
      }),
  );
  const snapshot = await fetchUsage(fetchFn, { baseUrl: proxyBaseUrl });
  expect(snapshot).toMatchObject({
    provider: "openrouter",
    windows: [],
    error: expect.stringContaining("Usage unavailable"),
  });
  expect(fetchFn).toHaveBeenCalledTimes(2);
  expectDestinations(fetchFn, proxyBaseUrl);
});

it.each<[string, () => Response]>([
  ["HTTP 403", () => new Response(null, { status: 403 })],
  ["Malformed usage response", () => Response.json({ invalid: true })],
])("releases both guarded transports after %s", async (error, createResponse) => {
  const fetchFn = vi.fn<typeof fetch>(async () => createResponse());
  const { release } = mockGuardedFetch();
  const snapshot = await fetchUsage(fetchFn, { baseUrl: proxyBaseUrl, timeoutMs: 1000 });
  expect(snapshot.error).toContain(error);
  expect(release).toHaveBeenCalledTimes(2);
});

it("bounds native bodies after headers and releases both endpoints", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"data":');
    },
    async (baseUrl) => {
      const headersReady = Promise.withResolvers<void>();
      const released: string[] = [];
      const parent = new AbortController();
      const actualGuard = ssrfRuntime.fetchWithSsrFGuard;
      let receivedHeaders = 0;
      const guardedFetch = vi
        .spyOn(ssrfRuntime, "fetchWithSsrFGuard")
        .mockImplementation(async (params) => {
          const guarded = await actualGuard(params).catch((error: unknown) => {
            headersReady.reject(error);
            throw error;
          });
          if (++receivedHeaders === 2) {
            headersReady.resolve();
          }
          return {
            ...guarded,
            release: async () => {
              await guarded.release();
              released.push(new URL(params.url).pathname);
            },
          };
        });
      // HTTP and body reads stay native; advance only the request deadline clock.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const operation = fetchUsage(fetch, {
        token: "synthetic-private-key",
        baseUrl,
        request: { allowPrivateNetwork: true },
        timeoutMs: 1,
        signal: parent.signal,
      });
      try {
        await headersReady.promise;
        await setImmediate();
        await vi.advanceTimersByTimeAsync(1);
        expect(await operation).toMatchObject({ windows: [], error: "Malformed usage response" });
        expect(released.toSorted()).toEqual(["/credits", "/key"]);
      } finally {
        parent.abort();
        vi.useRealTimers();
        await operation.catch(() => undefined);
        guardedFetch.mockRestore();
      }
    },
  );
});

it.each([
  ["Weekly", { limit: 50, limit_remaining: 42, limit_reset: "weekly", usage: 200 }, [8, 50, 16]],
  [
    "Monthly",
    { limit: 0, limit_remaining: 0, limit_reset: "monthly", usage_monthly: 0 },
    [0, 0, 100],
  ],
  [
    "Monthly",
    {
      limit: 20,
      limit_remaining: 14,
      limit_reset: "monthly",
      usage_monthly: 5,
      byok_usage_monthly: 1,
      include_byok_in_limit: true,
    },
    [6, 20, 30],
  ],
] as const)("calculates the %s budget for %j", async (period, data, [used, limit, percent]) => {
  const snapshot = await fetchKeyBudget(data);
  expect(snapshot.windows).toEqual([{ label: `${period} key budget`, usedPercent: percent }]);
  expect(snapshot.billing).toEqual([
    { ...budgetFields, used, limit, period: period.toLowerCase() },
  ]);
});

it("includes lifetime BYOK spend without remaining credits", async () => {
  const snapshot = await fetchKeyBudget({
    limit: 20,
    usage: 5,
    byok_usage: 4,
    include_byok_in_limit: true,
  });
  expect(snapshot.windows[0]?.usedPercent).toBe(45);
  expect(snapshot.billing?.[0]).toMatchObject({ type: "budget", used: 9, limit: 20 });
});

it("preserves an overdrawn account balance", async () => {
  const snapshot = await fetchUsage(
    fetchResponses(
      json({ total_credits: 10, total_usage: 12.5 }),
      new Response(null, { status: 403 }),
    ),
  );
  expect(snapshot.billing).toEqual([
    { type: "balance", label: "Account balance", amount: -2.5, unit: "USD" },
    { type: "spend", label: "Account usage", amount: 12.5, unit: "USD" },
  ]);
});

it("releases capture tees before unread HTTP error bodies", async () => {
  const cancel = vi.fn();
  const release = vi.fn();
  const branches: ReadableStream<Uint8Array>[] = [];
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async (params) => {
    const [consumer, capture] = new ReadableStream<Uint8Array>({ cancel }).tee();
    branches.push(consumer, capture);
    return {
      response: new Response(consumer, { status: 401 }),
      finalUrl: params.url,
      release: async () => {
        release();
        await Promise.all([capture.cancel(), consumer.cancel()]);
      },
    };
  });
  const operation = fetchUsage(vi.fn(), { timeoutMs: 1000 });
  const settledOperation = operation.catch(() => undefined);
  try {
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2));
    const snapshot = await operation;
    expect(snapshot.error).toBe("HTTP 401");
    expect(snapshot.windows).toEqual([]);
    expect(release).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(2);
  } finally {
    await Promise.all(branches.map((branch) => branch.cancel()));
    await settledOperation;
  }
});
