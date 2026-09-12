import { lookup } from "node:dns/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discordConversationReadAuthority } from "./conversation-read-authority.js";
import { RequestClient } from "./internal/rest.js";

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, lookup: vi.fn() };
});

// Exercise real transport preparation; the guard normally skips DNS for mocked fetch.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      actual.fetchWithSsrFGuard({ ...params, lookupFn: lookup }),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(lookup).mockReset();
});

describe("Discord endpoint request authority after transport preparation", () => {
  it.each(
    [false, true].flatMap((queueRequests) =>
      [false, true].map((revoked) => ({ queueRequests, revoked })),
    ),
  )(
    "checks the request owner after DNS (queued=$queueRequests, revoked=$revoked)",
    async ({ queueRequests, revoked }) => {
      vi.stubEnv("DISCORD_API_URL", "https://discord-endpoint.example.com/api/v10");
      const started = createDeferred();
      const resolved = createDeferred<{ address: string; family: number }[]>();
      vi.mocked(lookup).mockImplementation(async () => {
        started.resolve();
        return await resolved.promise;
      });
      const network = vi.fn<typeof fetch>(
        async () =>
          new Response('{"id":"synthetic-user"}', {
            headers: { "Content-Type": "application/json" },
          }),
      );
      vi.stubGlobal("fetch", network);
      let active = true;
      const assertion = () => {
        if (!active) {
          throw new Error("Synthetic read authority revoked during DNS");
        }
      };
      const client = new RequestClient("synthetic-endpoint-token", { queueRequests });
      const pending = discordConversationReadAuthority.run(assertion, () =>
        client.get("/users/@me"),
      );
      const outcome = Promise.allSettled([pending]);
      try {
        await Promise.race([
          started.promise,
          pending.then(() => {
            throw new Error("Request finished before DNS preparation");
          }),
        ]);
        expect(network).not.toHaveBeenCalled();
        if (revoked) {
          active = false;
        }
        resolved.resolve([{ address: "93.184.216.34", family: 4 }]);
        const [result] = await outcome;
        if (revoked) {
          expect(result.status).toBe("rejected");
          if (result.status === "rejected") {
            expect(String(result.reason)).toContain("Synthetic read authority revoked during DNS");
          }
          expect(network).not.toHaveBeenCalled();
        } else {
          expect(result).toEqual({ status: "fulfilled", value: { id: "synthetic-user" } });
          expect(network).toHaveBeenCalledOnce();
          const [url, init] = network.mock.calls[0]!;
          expect(String(url)).toBe("https://discord-endpoint.example.com/api/v10/users/@me");
          expect(new Headers(init?.headers).get("Authorization")).toBe(
            "Bot synthetic-endpoint-token",
          );
        }
      } finally {
        resolved.resolve([{ address: "93.184.216.34", family: 4 }]);
        client.abortAllRequests();
        await outcome;
      }
    },
  );
});
