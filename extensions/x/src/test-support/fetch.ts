import * as ssrf from "openclaw/plugin-sdk/ssrf-runtime";
import { afterAll, beforeEach, vi } from "vitest";

export type XFetch = (input: string, init?: RequestInit) => Promise<Response>;
type XService = "api.x.com" | "api.github.com";
const network = new Map<string, XFetch>();
const fetchWithSsrFGuard = ssrf.fetchWithSsrFGuard;

beforeEach(async () => {
  network.clear();
  // The budget suite reloads modules to prove shared ledger ownership.
  const [ssrfRuntime, runtimeFetch] = await Promise.all([
    import("openclaw/plugin-sdk/ssrf-runtime"),
    import("openclaw/plugin-sdk/runtime-fetch"),
  ]);
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation((params) =>
    fetchWithSsrFGuard({ ...params, fetchImpl: vi.fn(params.fetchImpl) }),
  );
  vi.spyOn(runtimeFetch, "fetchWithRuntimeDispatcher").mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return network.get(new URL(url).hostname)!(url, init);
  });
});
afterAll(() => vi.restoreAllMocks());

export function setXTestFetch(host: XService, fetch: XFetch) {
  network.set(host, fetch);
}
