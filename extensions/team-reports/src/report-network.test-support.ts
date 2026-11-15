import { afterAll, beforeEach, vi } from "vitest";

export type ReportFixtureFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const network = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return new AsyncLocalStorage<ReportFixtureFetch>();
});

// Keep the native mock installed through each suite's real afterEach resource cleanup.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const fixtureTransport = network.getStore();
      if (!fixtureTransport) {
        throw new Error("Report fixture request has no invocation-owned transport");
      }
      return fixtureTransport(
        typeof input === "string" || input instanceof URL ? input : input.url,
        init,
      );
    }),
  );
});
afterAll(() => vi.unstubAllGlobals());

// Native mocked-fetch guard route retains host/literal-IP checks and response lifetime, not DNS pinning.
export function bindReportFetch<T extends object>(owner: T, fetch: ReportFixtureFetch): T {
  for (const key of Object.keys(owner)) {
    const operation: unknown = Reflect.get(owner, key);
    if (typeof operation === "function") {
      Reflect.set(owner, key, (...args: unknown[]) =>
        network.run(fetch, () => Reflect.apply(operation, owner, args)),
      );
    }
  }
  return owner;
}
