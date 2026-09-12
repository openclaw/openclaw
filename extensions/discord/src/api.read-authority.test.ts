import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestDiscord } from "./api.js";
import { discordConversationReadAuthority } from "./conversation-read-authority.js";
import { discordDirectoryCacheState } from "./directory-cache-state.js";
import { rememberDiscordDirectoryUser, resolveDiscordDirectoryUserId } from "./directory-cache.js";
import { jsonResponse } from "./test-http-helpers.js";

const accountId = "synthetic-api-authority";

afterEach(() => {
  discordDirectoryCacheState.handlesByAccount.delete(accountId);
  vi.useRealTimers();
});

function authority() {
  let active = true;
  return {
    assert: () => {
      if (!active) {
        throw new Error("Synthetic API read authority revoked");
      }
    },
    revoke: () => {
      active = false;
    },
  };
}

describe("Discord directory API read authority", () => {
  it.each([false, true])("rechecks authority before a 429 retry (revoked=%s)", async (revoked) => {
    vi.useFakeTimers();
    const owner = authority();
    const limited = createDeferred<void>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        limited.resolve();
        return jsonResponse({ message: "Rate limited", retry_after: 1 }, 429);
      })
      .mockResolvedValueOnce(jsonResponse([{ id: "123456789012345678", name: "fixture" }]));
    const pending = discordConversationReadAuthority.run(owner.assert, () =>
      requestDiscord("/users/@me/guilds", "synthetic-api-token", {
        fetcher,
        endpointRuntime: null,
        retry: { attempts: 2, minDelayMs: 1000, maxDelayMs: 1000, jitter: 0 },
      }),
    );
    const outcome = Promise.allSettled([pending]);
    await Promise.race([
      limited.promise,
      outcome.then(() => {
        throw new Error("API request settled before the initial fixture request");
      }),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledOnce();
    if (revoked) {
      owner.revoke();
    }
    await vi.advanceTimersByTimeAsync(1000);
    const [result] = await outcome;
    if (revoked) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(String(result.reason)).toContain("Synthetic API read authority revoked");
      }
      expect(fetcher).toHaveBeenCalledOnce();
    } else {
      expect(result).toEqual({
        status: "fulfilled",
        value: [{ id: "123456789012345678", name: "fixture" }],
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).toBe("https://discord.com/api/v10/users/@me/guilds");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bot synthetic-api-token");
    }
  });

  it("rejects a stale directory-cache publication without replacing the healthy entry", () => {
    const owner = authority();
    const handle = "synthetic-collector";
    discordConversationReadAuthority.run(owner.assert, () =>
      rememberDiscordDirectoryUser({ accountId, userId: "123456789012345678", handles: [handle] }),
    );
    expect(resolveDiscordDirectoryUserId({ accountId, handle })).toBe("123456789012345678");
    owner.revoke();
    expect(() =>
      discordConversationReadAuthority.run(owner.assert, () =>
        rememberDiscordDirectoryUser({
          accountId,
          userId: "223456789012345678",
          handles: [handle, "stale-new-handle"],
        }),
      ),
    ).toThrow("Synthetic API read authority revoked");
    expect(resolveDiscordDirectoryUserId({ accountId, handle })).toBe("123456789012345678");
    expect(
      resolveDiscordDirectoryUserId({ accountId, handle: "stale-new-handle" }),
    ).toBeUndefined();
  });
});
