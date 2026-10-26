import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createXTestApi as createXApiClient, type XFetch } from "./test-support/api-client.js";

afterEach(() => vi.useRealTimers());

const reply = (
  api: ReturnType<typeof createXApiClient>,
  assertActive?: Parameters<typeof api.reply>[0]["assertActive"],
) => api.reply({ text: "Reply", inReplyToId: "20", assertActive });

describe("X API authentication", () => {
  it("lists and streams Activity with the app bearer but creates mentions with the user token", async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    let subscribed = false;
    const api = createXApiClient({
      bearerToken: "app-bearer",
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        const authorization = new Headers(init?.headers).get("authorization");
        requests.push(`${init?.method} ${path} ${authorization}`);
        if (path === "/2/oauth2/token") {
          return Response.json({ access_token: "user-access" });
        }
        if (path === "/2/activity/stream") {
          return new Response(null);
        }
        if (init?.method === "POST") {
          expect(await new Response(init.body).json()).toEqual({
            event_type: "post.mention.create",
            filter: { user_id: "9" },
          });
          subscribed = true;
          return Response.json({ data: { subscription_id: "1" } });
        }
        return Response.json({
          data: subscribed ? [{ event_type: "post.mention.create", filter: { user_id: "9" } }] : [],
        });
      },
    });
    await api.ensureActivitySubscriptions("9");
    await api.ensureActivitySubscriptions("9");
    await api.openActivityStream(new AbortController().signal);
    expect(requests).toEqual([
      "GET /2/activity/subscriptions Bearer app-bearer",
      `POST /2/oauth2/token Basic ${Buffer.from("client:secret").toString("base64")}`,
      "POST /2/activity/subscriptions Bearer user-access",
      "GET /2/activity/subscriptions Bearer app-bearer",
      "GET /2/activity/stream Bearer app-bearer",
    ]);
  });

  it.each([
    {
      label: "reflected credentials",
      body: JSON.stringify({
        errors: [
          {
            message: "Rejected test-user-access test-app-bearer test-seed test-rotated test-secret",
          },
        ],
        detail: "Ignored detail",
      }),
      detail: ": Rejected [redacted] [redacted] [redacted] [redacted] [redacted]",
    },
    {
      label: "problem detail",
      body: JSON.stringify({ title: "Forbidden", detail: "Missing tweet.read scope" }),
      detail: ": Missing tweet.read scope",
    },
    { label: "unreadable JSON", body: "not JSON", detail: "" },
  ])("retains safe Activity diagnostics for $label", async ({ body, detail }) => {
    vi.useFakeTimers();
    const api = createXApiClient({
      clientSecret: "test-secret",
      refreshToken: "test-seed",
      bearerToken: "test-app-bearer",
      fetch: async (url, init) => {
        if (url.endsWith("/oauth2/token")) {
          return Response.json({ access_token: "test-user-access", refresh_token: "test-rotated" });
        }
        return init?.method === "POST"
          ? new Response(body, { status: 400 })
          : Response.json({ data: [] });
      },
    });
    await expect(api.ensureActivitySubscriptions("9")).rejects.toThrow(
      `X API /2/activity/subscriptions failed (HTTP 400)${detail}`,
    );
  });

  it.each([
    ["reply", "refresh"],
    ["batch user lookup", "refresh"],
    ["reply", "asynchronous preparation"],
  ])(
    "preserves the authority rejection and never dispatches a %s after %s",
    async (operation, stage) => {
      let active = true;
      const rejected = new PlatformMessageNotDispatchedError("Revoked", {
        cause: undefined,
        retryable: false,
      });
      const fetcher = vi.fn<XFetch>(async (url) => {
        if (url.endsWith("/oauth2/token")) {
          active = stage !== "refresh";
          return Response.json({ access_token: "access" });
        }
        throw new Error("unexpected paid request");
      });
      const api = createXApiClient({ fetch: fetcher });
      const assertCurrent = () => {
        if (!active) {
          throw rejected;
        }
      };
      const assertActive = async () => {
        if (stage !== "refresh") {
          queueMicrotask(() => {
            active = false;
          });
          return assertCurrent;
        }
        return assertCurrent();
      };
      await expect(
        operation === "reply"
          ? reply(api, assertActive)
          : api.getUsersByUsernames(["alice"], undefined, assertActive),
      ).rejects.toBe(rejected);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps provider and persistence errors out of token status and diagnostics", async () => {
    const states: string[] = [];
    const api = createXApiClient({
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
      refreshToken: "seed",
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
    const error: unknown = await reply(api).catch((cause: unknown) => cause);
    const uncertain = ["post-network", "post-json", "post-503"].includes(failure);
    expect(await api.spend.status()).toMatchObject({ dayUsd: uncertain ? 0.02 : 0 });
    expect(posts).toBe(failure === "refresh" ? 0 : 1);
    if (!uncertain) {
      expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect(error).toMatchObject({ retryable: failure !== "post-403" });
    } else {
      // Network failures, unreadable bodies, and 5xx after dispatch stay ambiguous.
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
      if (failure === "post-503") {
        expect(error).toMatchObject({ status: 503 });
      }
    }
  });
});
