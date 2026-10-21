import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";

export function defineSearchCacheTests(
  name: string,
  answer: (text: string) => Response,
  search: (
    query: string,
    options: { ttl?: number; signal?: AbortSignal },
  ) => Promise<Record<string, unknown>>,
) {
  function install() {
    const fetch = vi
      .fn<(_input?: unknown, _init?: RequestInit) => Promise<Response>>()
      .mockImplementation(async () => answer("Fresh answer"));
    vi.stubGlobal("fetch", withFetchPreconnect(fetch));
    return fetch;
  }

  it(`does not cache a ${name} result completed after caller cancellation`, async () => {
    const controller = new AbortController();
    const reason = new Error(`${name} cancelled after response`);
    const fetch = install().mockImplementationOnce(async () => {
      controller.abort(reason);
      return answer("Cancelled answer");
    });
    const query = `${name} late-cancel cache regression`;
    await expect(search(query, { signal: controller.signal })).rejects.toBe(reason);
    expect((await search(query, {})).content).toContain("Fresh answer");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it(`bypasses populated ${name} cache reads and writes at zero TTL`, async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const fetch = install().mockResolvedValueOnce(answer("Original answer"));
    const query = `${name} zero TTL cache policy`;
    await search(query, { ttl: 15 });
    for (let attempt = 0; attempt < 2; attempt++) {
      const uncached = await search(query, { ttl: 0 });
      expect(uncached.cached).toBeUndefined();
      expect(uncached.content).toContain("Fresh answer");
    }
    expect(await search(query, { ttl: 15 })).toMatchObject({
      cached: true,
      content: expect.stringContaining("Original answer"),
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it(`applies a shortened ${name} cache TTL to an existing result`, async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const fetch = install().mockResolvedValueOnce(answer("Original answer"));
    const query = `${name} shortened TTL cache policy`;
    await search(query, { ttl: 15 });
    now.mockReturnValue(1_060_000);
    const refreshed = await search(query, { ttl: 1 });
    expect(refreshed.cached).toBeUndefined();
    expect(refreshed.content).toContain("Fresh answer");
    expect(await search(query, { ttl: 1 })).toMatchObject({
      cached: true,
      content: refreshed.content,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
}
