import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getXApi } from "./client.js";
import type { XAccountConfig } from "./config-schema.js";

const fixture = vi.hoisted(() => {
  const rows = new Map<string, unknown>();
  const store = {
    lookup: async (key: string) => rows.get(key),
    register: async (key: string, value: unknown, options?: { assertCurrent?: () => void }) => {
      options?.assertCurrent?.();
      rows.set(key, structuredClone(value));
    },
  };
  return {
    rows,
    store,
    runtime: { state: { openKeyedStore: () => store } },
    fetch: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(),
  };
});

vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  getXRuntime: () => fixture.runtime,
}));
vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return {
    ...actual,
    createXApiClient(options: Parameters<typeof actual.createXApiClient>[0]) {
      options.fetch = fixture.fetch;
      return actual.createXApiClient(options);
    },
  };
});

function config(overrides: Partial<XAccountConfig> = {}): OpenClawConfig {
  return {
    channels: {
      x: {
        userId: "9",
        username: "roboclawbot",
        clientId: "client",
        clientSecret: "secret-initial",
        refreshToken: "seed-initial",
        bearerToken: "bearer-initial",
        ...overrides,
      },
    },
  };
}

function restartRuntime() {
  fixture.runtime = { state: { openKeyedStore: () => fixture.store } };
}

function requestBody(init?: RequestInit): string {
  if (typeof init?.body !== "string") {
    throw new Error("Expected a serialized OAuth request body");
  }
  return init.body;
}

beforeEach(() => {
  fixture.rows.clear();
  fixture.fetch.mockReset();
  restartRuntime();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("X OAuth client ownership", () => {
  it("shares an active refresh across transport rotation and preserves its grant across restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const refreshStarted = Promise.withResolvers<void>();
    const releaseRefresh = Promise.withResolvers<void>();
    const refreshes: { token: string | null; auth: string | null }[] = [];
    const bearerHeaders: (string | null)[] = [];
    fixture.fetch.mockImplementation(async (input, init) => {
      const url = input;
      if (url.endsWith("/oauth2/token")) {
        refreshes.push({
          token: new URLSearchParams(requestBody(init)).get("refresh_token"),
          auth: new Headers(init?.headers).get("authorization"),
        });
        if (refreshes.length === 1) {
          refreshStarted.resolve();
          await releaseRefresh.promise;
        }
        return Response.json({
          access_token: "access",
          refresh_token: `rotated-${refreshes.length}`,
          expires_in: 3600,
        });
      }
      if (url.endsWith("/activity/subscriptions")) {
        bearerHeaders.push(new Headers(init?.headers).get("authorization"));
        return Response.json({
          data: [{ event_type: "post.mention.create", filter: { user_id: "9" } }],
        });
      }
      return Response.json({ data: [] });
    });
    const initial = await getXApi("default", config());
    const first = initial.getMentions({ userId: "9" });
    await refreshStarted.promise;
    const rotatedConfig = config({ bearerToken: "bearer-new", clientSecret: "secret-new" });
    const updated = await getXApi("default", rotatedConfig);
    const concurrent = updated.getMentions({ userId: "9" });
    releaseRefresh.resolve();
    await Promise.all([first, concurrent]);
    expect(refreshes.map(({ token }) => token)).toEqual(["seed-initial"]);
    await updated.ensureActivitySubscriptions("9");
    expect(bearerHeaders).toEqual(["Bearer bearer-new"]);
    vi.setSystemTime(Date.now() + 3_600_000);
    await updated.getMentions({ userId: "9" });
    expect(refreshes[1]).toEqual({
      token: "rotated-1",
      auth: `Basic ${Buffer.from("client:secret-new").toString("base64")}`,
    });

    restartRuntime();
    await (await getXApi("default", rotatedConfig)).getMentions({ userId: "9" });
    expect(refreshes.at(-1)?.token).toBe("rotated-2");
    await (
      await getXApi("default", config({ refreshToken: "seed-new" }))
    ).getMentions({ userId: "9" });
    expect(refreshes.at(-1)?.token).toBe("seed-new");
  });

  it("does not let a retired seed overwrite the replacement grant", async () => {
    const staleStarted = Promise.withResolvers<void>();
    const releaseStale = Promise.withResolvers<void>();
    const refreshes: (string | null)[] = [];
    fixture.fetch.mockImplementation(async (input, init) => {
      if (input.endsWith("/oauth2/token")) {
        const token = new URLSearchParams(requestBody(init)).get("refresh_token");
        refreshes.push(token);
        if (token === "seed-initial") {
          staleStarted.resolve();
          await releaseStale.promise;
        }
        return Response.json({
          access_token: "access",
          refresh_token: token === "seed-initial" ? "rotated-stale" : "rotated-current",
        });
      }
      return Response.json({ data: [] });
    });
    const stale = (await getXApi("default", config())).getMentions({ userId: "9" });
    const rejected = expect(stale).rejects.toThrow("X token refresh failed");
    await staleStarted.promise;
    const replacement = config({ refreshToken: "seed-new" });
    await (await getXApi("default", replacement)).getMentions({ userId: "9" });
    releaseStale.resolve();
    await rejected;
    restartRuntime();
    await (await getXApi("default", replacement)).getMentions({ userId: "9" });
    expect(refreshes).toEqual(["seed-initial", "seed-new", "rotated-current"]);
  });
});
