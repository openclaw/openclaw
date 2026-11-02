import { createClient, Method } from "matrix-js-sdk/lib/matrix.js";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("matrix-js-sdk request deadlines", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("do not keep a finished CLI process alive after the request settles", async () => {
    // /sync arms pollTimeout + 80s per request. A referenced deadline held each
    // Matrix CLI command open for up to 110s after its client had stopped.
    const deadlineMs = 110_000;
    const realSetTimeout = globalThis.setTimeout;
    const deadlines: NodeJS.Timeout[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      ...args: Parameters<typeof setTimeout>
    ) => {
      const timer = realSetTimeout(...args);
      if (args[1] === deadlineMs) {
        deadlines.push(timer);
      }
      return timer;
    }) as typeof setTimeout);
    const client = createClient({
      baseUrl: "https://matrix.example.org",
      accessToken: "token",
      fetchFn: async () => Response.json({}),
    });

    try {
      await client.http.authedRequest(Method.Get, "/deadline-probe", undefined, undefined, {
        localTimeoutMs: deadlineMs,
      });

      expect(deadlines).toHaveLength(1);
      expect(deadlines[0]?.hasRef()).toBe(false);
    } finally {
      deadlines.forEach((timer) => clearTimeout(timer));
    }
  });
});
