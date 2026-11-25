import { vi } from "vitest";

type SsrfRuntime = typeof import("openclaw/plugin-sdk/ssrf-runtime");

export function createMattermostFetchFixture() {
  const fixture: { current: typeof fetch } = { current: vi.fn<typeof fetch>() };
  return Object.assign(fixture, {
    mockRuntime: async (importOriginal: <T>() => Promise<T>) => {
      const actual = await importOriginal<SsrfRuntime>();
      return {
        ...actual,
        fetchWithSsrFGuard: async (params: Parameters<SsrfRuntime["fetchWithSsrFGuard"]>[0]) => {
          params.beforeRequest?.();
          return {
            response: await fixture.current(params.url, params.init),
            release: async () => {},
          };
        },
      };
    },
  });
}
