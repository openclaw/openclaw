import { vi } from "vitest";

type SsrfRuntime = typeof import("openclaw/plugin-sdk/ssrf-runtime");
type GuardParams = Parameters<SsrfRuntime["fetchWithSsrFGuard"]>[0];

export function createMattermostFetchFixture(prepareRequest?: () => Promise<void> | undefined) {
  const fixture: { current: typeof fetch } = { current: vi.fn<typeof fetch>() };
  const fetchWithSsrFGuard = vi.fn(async (params: GuardParams) => {
    // Without preparation, the final request check must run before the first await.
    if (prepareRequest) {
      await prepareRequest();
    }
    params.beforeRequest?.();
    return {
      response: await fixture.current(params.url, params.init),
      release: async () => {},
    };
  });
  return Object.assign(fixture, {
    fetchWithSsrFGuard,
    mockRuntime: async (importOriginal: <T>() => Promise<T>) => {
      const actual = await importOriginal<SsrfRuntime>();
      return { ...actual, fetchWithSsrFGuard };
    },
  });
}
