import type { LookupAddress } from "node:dns";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as undici from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBraveWebSearchProvider } from "./brave-web-search-provider.js";

const lookup = vi.hoisted(() => vi.fn<() => Promise<LookupAddress[]>>());
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup,
}));

const publicAddress = [{ address: "93.184.216.34", family: 4 }];
const privateAddress = [{ address: "10.20.30.40", family: 4 }];
const payload = { web: { results: [] }, grounding: { generic: [] }, sources: [] };
const fetchNetwork = vi.fn<typeof fetch>();
let queryId = 0;

function createTool(baseUrl: string) {
  const webSearch = { apiKey: "brave-preflight-test-key", mode: "llm-context", baseUrl };
  const tool = createBraveWebSearchProvider().createTool({
    config: { plugins: { entries: { brave: { config: { webSearch } } } } },
    searchConfig: { timeoutSeconds: 1 },
  });
  if (!tool) {
    throw new Error("Expected Brave tool");
  }
  return tool;
}

function holdDns() {
  const dns = createDeferred<LookupAddress[]>();
  const entered = createDeferred<void>();
  lookup.mockImplementationOnce(() => {
    entered.resolve();
    return dns.promise;
  });
  return { dns, entered };
}

function observe<T>(promise: Promise<T>) {
  let outcome: { value: T } | { error: unknown } | undefined;
  const settled = promise.then(
    (value) => {
      outcome = { value };
    },
    (error: unknown) => {
      outcome = { error };
    },
  );
  return { settled, outcome: () => outcome };
}

beforeEach(() => {
  lookup.mockReset().mockResolvedValue(publicAddress);
  fetchNetwork.mockReset().mockImplementation(async (_input, init) => {
    init?.signal?.throwIfAborted();
    return Response.json(payload);
  });
  // A plain fetch adapter keeps the guard's real DNS/pinning path active. Only
  // the final network call is replaced; real dispatchers are created and released.
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    fetchNetwork(input, init),
  );
  vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", { ...undici, fetch: fetchNetwork });
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_DEBUG_PROXY_ENABLED",
  ]) {
    vi.stubEnv(key, "");
  }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.doUnmock("node:dns/promises");
  vi.resetModules();
});

// Endpoint classification and the request deadline share one owner across search modes.
describe("Brave preflight lifetime", () => {
  it.each(["http", "https"] as const)(
    "rejects cancellation during the %s DNS-to-validator handoff before a cache hit",
    async (protocol) => {
      lookup.mockResolvedValue(privateAddress);
      const tool = createTool(`${protocol}://search.example.test`);
      const args = { query: `handoff-${++queryId}` };
      await tool.execute(args);
      fetchNetwork.mockClear();
      const { dns, entered } = holdDns();
      const caller = new AbortController();
      const reason = new Error("canceled after DNS settled");
      const operation = observe(tool.execute(args, { signal: caller.signal }));
      try {
        await entered.promise;
        // Cancel on DNS settlement, before the request's async continuation can publish a result.
        void dns.promise.then(() => caller.abort(reason));
        dns.resolve(privateAddress);
        await operation.settled;
        expect(operation.outcome()).toEqual({ error: reason });
        expect(fetchNetwork).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        caller.abort(reason);
        dns.resolve(privateAddress);
        await operation.settled;
      }
    },
  );

  it.each(["http", "https"] as const)(
    "preserves %s DNS failure behavior and releases its deadline",
    async (protocol) => {
      const reason = new Error("synthetic DNS failure");
      lookup.mockRejectedValueOnce(reason);
      const result = createTool(`${protocol}://search.example.test`).execute({
        query: `dns-failure-${++queryId}`,
      });
      if (protocol === "http") {
        await expect(result).rejects.toBe(reason);
        expect(fetchNetwork).not.toHaveBeenCalled();
      } else {
        // HTTPS classification failures still fall back to strict, revalidated transport.
        await expect(result).resolves.toMatchObject({ provider: "brave" });
        expect(lookup).toHaveBeenCalledTimes(2);
        expect(fetchNetwork).toHaveBeenCalledOnce();
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(
    (["http", "https"] as const).flatMap((protocol) =>
      (["cancel", "deadline"] as const).flatMap((stop) =>
        [false, true].map((warmCache) => ({ protocol, stop, warmCache })),
      ),
    ),
  )(
    "rejects $stop during held $protocol DNS (warm cache: $warmCache)",
    async ({ protocol, stop, warmCache }) => {
      lookup.mockResolvedValue(privateAddress);
      const tool = createTool(`${protocol}://search.example.test`);
      const args = { query: `preflight-${++queryId}` };
      if (warmCache) {
        await expect(tool.execute(args)).resolves.toMatchObject({ provider: "brave" });
        await expect(tool.execute(args)).resolves.toMatchObject({ cached: true });
        expect(fetchNetwork).toHaveBeenCalledOnce();
        fetchNetwork.mockClear();
      }
      const { dns, entered } = holdDns();
      const caller = new AbortController();
      const reason = new Error("caller stopped during DNS");
      const operation = observe(tool.execute(args, { signal: caller.signal }));
      try {
        await entered.promise;
        if (stop === "cancel") {
          caller.abort(reason);
        }
        await vi.advanceTimersByTimeAsync(stop === "deadline" ? 1_000 : 0);
        expect(operation.outcome()).toEqual({
          error: stop === "cancel" ? reason : expect.objectContaining({ name: "TimeoutError" }),
        });
        expect(fetchNetwork).not.toHaveBeenCalled();
        dns.resolve(privateAddress);
        await operation.settled;
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchNetwork).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        await expect(tool.execute(args)).resolves.toMatchObject(
          warmCache ? { cached: true } : { provider: "brave" },
        );
        expect(fetchNetwork).toHaveBeenCalledTimes(warmCache ? 0 : 1);
      } finally {
        caller.abort(reason);
        dns.resolve(privateAddress);
        await operation.settled;
      }
    },
  );

  it.each(
    (["http", "https"] as const).flatMap((protocol) =>
      (["fetch", "body"] as const).map((phase) => ({ protocol, phase })),
    ),
  )(
    "keeps the original budget through $protocol $phase consumption",
    async ({ protocol, phase }) => {
      lookup.mockResolvedValue(privateAddress);
      const { dns, entered } = holdDns();
      const dispatched = createDeferred<void>();
      fetchNetwork.mockImplementationOnce(async (_input, init) => {
        const signal = init?.signal;
        if (!signal) {
          throw new Error("missing request signal");
        }
        signal.throwIfAborted();
        if (phase === "fetch") {
          return await new Promise<Response>((_resolve, reject) => {
            // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Fetch preserves AbortSignal reasons, including non-Error values.
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            dispatched.resolve();
          });
        }
        return new Response(
          new ReadableStream({
            start(stream) {
              signal.addEventListener("abort", () => stream.error(signal.reason), { once: true });
              dispatched.resolve();
            },
          }),
        );
      });
      const caller = new AbortController();
      const tool = createTool(`${protocol}://search.example.test`);
      const args = { query: `budget-${++queryId}` };
      const operation = observe(tool.execute(args, { signal: caller.signal }));
      try {
        await entered.promise;
        await vi.advanceTimersByTimeAsync(600);
        dns.resolve(privateAddress);
        await dispatched.promise;
        await vi.advanceTimersByTimeAsync(399);
        expect(operation.outcome()).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(operation.outcome()).toEqual({
          error: expect.objectContaining({ name: "TimeoutError" }),
        });
        await operation.settled;
        expect(vi.getTimerCount()).toBe(0);
        await tool.execute(args);
        expect(fetchNetwork).toHaveBeenCalledTimes(2);
      } finally {
        caller.abort();
        dns.resolve(privateAddress);
        await operation.settled;
      }
    },
  );

  it.each<[string, string, LookupAddress[], LookupAddress[], boolean, boolean?]>([
    ["private HTTP", "http", privateAddress, privateAddress, true],
    ["private HTTPS", "https", privateAddress, privateAddress, true],
    ["public HTTP", "http", publicAddress, publicAddress, false],
    ["public HTTPS", "https", publicAddress, publicAddress, true],
    ["rebound HTTPS", "https", publicAddress, privateAddress, false],
    ["fake IPv4", "https", publicAddress, [{ address: "198.18.0.1", family: 4 }], true],
    ["fake IPv6", "https", publicAddress, [{ address: "fc00::1", family: 6 }], true],
    ["redirect hostname", "https", publicAddress, publicAddress, false, true],
  ])("preserves endpoint policy: %s", async (_name, protocol, first, next, allowed, redirect) => {
    lookup.mockResolvedValueOnce(first).mockResolvedValue(next);
    if (redirect) {
      fetchNetwork.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://other.example.test" } }),
      );
    }
    const result = createTool(`${protocol}://search.example.test`).execute({
      query: `policy-${++queryId}`,
    });
    if (allowed) {
      await expect(result).resolves.toMatchObject({ provider: "brave" });
      expect(fetchNetwork).toHaveBeenCalledOnce();
      expect(lookup).toHaveBeenCalledTimes(2);
    } else {
      await expect(result).rejects.toThrow(redirect ? /allowlist/ : /private|loopback/);
      expect(fetchNetwork).toHaveBeenCalledTimes(redirect ? 1 : 0);
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
