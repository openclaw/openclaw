import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";

export function defineSearchContracts(
  name: string,
  answer: (text: string) => Response,
  search: (
    query: string,
    options: { ttl?: number; signal?: AbortSignal },
  ) => Promise<Record<string, unknown>>,
  scopedSearch: (query: string, scope: "a" | "b") => Promise<unknown>,
) {
  function install() {
    const fetch = vi
      .fn<(_input?: unknown, _init?: RequestInit) => Promise<Response>>()
      .mockImplementation(async () => answer("Fresh answer"));
    vi.stubGlobal("fetch", withFetchPreconnect(fetch));
    return fetch;
  }

  it(`reuses ${name} answers only for the resolved credential`, async () => {
    const fetch = install().mockImplementation(async (_url, init) =>
      answer(
        new Headers(init?.headers).get("Authorization") === "Bearer fixture-key-a"
          ? "Account A answer"
          : "Account B answer",
      ),
    );
    const query = `${name} credential-scoped cache regression`;
    const first = asNonArrayRecord(await scopedSearch(query, "a"));
    const other = await scopedSearch(query, "b");
    const repeated = await scopedSearch(query, "a");
    expect(first?.content).toContain("Account A answer");
    expect(other).toMatchObject({ content: expect.stringContaining("Account B answer") });
    expect(repeated).toMatchObject({ cached: true, content: first?.content });
    expect(
      fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization")),
    ).toEqual(["Bearer fixture-key-a", "Bearer fixture-key-b"]);
  });

  it(`rejects an already-cancelled ${name} request before billing`, async () => {
    const fetch = install();
    const controller = new AbortController();
    const reason = new Error(`${name} cancelled before billing`);
    controller.abort(reason);
    await expect(search(`${name} pre-cancel`, { signal: controller.signal })).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });

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
