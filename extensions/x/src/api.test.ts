import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { describe, expect, it, vi } from "vitest";
import { createXApiClient, type XFetch } from "./api.js";

describe("X API authentication", () => {
  it("persists refresh rotation before requests, shares refresh work, and reuses it on restart", async () => {
    const writes: string[] = [];
    let stored: string | undefined;
    const fetcher: XFetch = vi.fn(async (url, init) => {
      if (url.endsWith("/oauth2/token")) {
        writes.push(`refresh:${new URLSearchParams(String(init?.body)).get("refresh_token")}`);
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Basic ${Buffer.from("client:secret").toString("base64")}`,
        );
        return Response.json({
          access_token: "access",
          refresh_token: "rotated",
          expires_in: 7200,
        });
      }
      expect(stored).toBe("rotated");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access");
      writes.push("request");
      return Response.json({ data: [] });
    });
    const options = {
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "initial",
      fetch: fetcher,
      loadRefreshToken: async () => stored,
      saveRefreshToken: async (token: string) => {
        stored = token;
        writes.push("persist");
      },
    };
    const api = createXApiClient(options);
    await Promise.all([api.getMentions({ userId: "9" }), api.getMentions({ userId: "9" })]);
    expect(writes).toEqual(["refresh:initial", "persist", "request", "request"]);
    await createXApiClient(options).getMentions({ userId: "9" });
    expect(writes.slice(4)).toEqual(["refresh:rotated", "persist", "request"]);
  });

  it("never posts after authority is revoked while token refresh is pending", async () => {
    let active = true;
    const fetcher = vi.fn<XFetch>(async (url) => {
      if (url.endsWith("/oauth2/token")) {
        active = false;
        return Response.json({ access_token: "access" });
      }
      throw new Error("unexpected post");
    });
    const api = createXApiClient({
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
      fetch: fetcher,
      saveRefreshToken: async () => {},
    });
    await expect(
      api.reply({
        text: "reply",
        inReplyToId: "1",
        assertActive: () => {
          if (!active) {
            throw new Error("revoked");
          }
        },
      }),
    ).rejects.toThrow("revoked");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps provider and persistence errors out of token status and diagnostics", async () => {
    const states: string[] = [];
    const api = createXApiClient({
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
      fetch: async () => Response.json({ access_token: "access", refresh_token: "rotated" }),
      saveRefreshToken: async () => {
        throw new Error("private persistence details");
      },
      onTokenState: (state) => states.push(state),
    });
    await expect(api.getMentions({ userId: "9" })).rejects.toThrow(
      /^X token refresh failed; check the account credentials and token storage$/,
    );
    expect(states).toEqual(["refreshing", "error"]);
  });

  it.each([
    "refresh",
    "refresh-after-401",
    "post-network",
    "post-json",
    "post-429",
    "post-403",
    "post-503",
  ] as const)("classifies %s failure at the actual reply POST boundary", async (failure) => {
    let posts = 0;
    let refreshes = 0;
    const api = createXApiClient({
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "seed",
      saveRefreshToken: async () => {},
      fetch: async (url) => {
        if (url.endsWith("/oauth2/token")) {
          refreshes++;
          return failure === "refresh" || (failure === "refresh-after-401" && refreshes === 2)
            ? new Response(null, { status: 503 })
            : Response.json({ access_token: "access" });
        }
        posts++;
        if (failure === "post-network") {
          throw new Error("Synthetic connection reset after request handoff");
        }
        if (failure === "refresh-after-401") {
          return new Response(null, { status: 401 });
        }
        if (failure === "post-429" || failure === "post-403" || failure === "post-503") {
          return new Response(null, {
            status: failure === "post-429" ? 429 : failure === "post-403" ? 403 : 503,
          });
        }
        return new Response("not-json", { status: 200 });
      },
    });
    const error: unknown = await api
      .reply({ text: "Reply", inReplyToId: "20" })
      .catch((cause: unknown) => cause);
    if (failure === "refresh" || failure === "refresh-after-401") {
      expect(posts).toBe(failure === "refresh" ? 0 : 1);
      expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect(error).toMatchObject({ retryable: true });
    } else if (failure === "post-429" || failure === "post-403") {
      // A 4xx rejection proves no post was created; only the rate limit is retryable.
      expect(posts).toBe(1);
      expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect(error).toMatchObject({ retryable: failure === "post-429" });
    } else {
      // Network failures, unreadable bodies, and 5xx after dispatch stay ambiguous.
      expect(posts).toBe(1);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
      if (failure === "post-503") {
        expect(error).toMatchObject({ status: 503 });
      }
    }
  });

  it("preserves an existing permanent no-dispatch marker from authority checks", async () => {
    const rejected = new PlatformMessageNotDispatchedError("X account authority was revoked", {
      cause: undefined,
      retryable: false,
    });
    const api = createXApiClient({
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "seed",
      saveRefreshToken: async () => {},
      fetch: async () => Response.json({ access_token: "access" }),
    });
    await expect(
      api.reply({
        text: "Reply",
        inReplyToId: "20",
        assertActive: () => {
          throw rejected;
        },
      }),
    ).rejects.toBe(rejected);
  });

  it("rechecks authority after asynchronous preparation returns and before the final fetch", async () => {
    let active = true;
    const rejected = new PlatformMessageNotDispatchedError("Stored grant revoked", {
      cause: undefined,
      retryable: false,
    });
    const fetcher = vi.fn<XFetch>(async (url) =>
      Response.json(
        url.endsWith("/oauth2/token") ? { access_token: "access" } : { data: { id: "901" } },
      ),
    );
    const api = createXApiClient({
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "seed",
      saveRefreshToken: async () => {},
      fetch: fetcher,
    });
    await expect(
      api.reply({
        text: "Reply",
        inReplyToId: "20",
        assertActive: async () => {
          queueMicrotask(() => {
            active = false;
          });
          return () => {
            if (!active) {
              throw rejected;
            }
          };
        },
      }),
    ).rejects.toBe(rejected);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
