import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateActionAuthority,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getXApi } from "./client.js";
import type { XAccountConfig } from "./config-schema.js";
import { setXRuntime } from "./runtime.js";
import { setXTestFetch } from "./test-support/fetch.js";

const fixture = vi.hoisted(() => {
  return { fetch: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>() };
});
let current: OpenClawConfig;
let stateDir: string;
let failTokenCommit: "before" | "after" | undefined;
const refreshes: { token: string | null; auth: string | null }[] = [];
const requests: string[] = [];
let exchange: (token: string | null, attempt: number) => Response | Promise<Response>;
let resource: (input: string, init?: RequestInit) => Response | Promise<Response>;
const tokenResponse = (attempt: number) =>
  Response.json({ access_token: "access", refresh_token: `rotated-${attempt}`, expires_in: 3600 });
const tokens = () => refreshes.map(({ token }) => token);

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
  const base = createPluginRuntimeMock();
  setXRuntime({
    ...base,
    config: { ...base.config, current: () => current },
    state: {
      ...base.state,
      resolveStateDir: () => stateDir,
      openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions) => {
        if (options.maxEntries === undefined) {
          throw new Error("Spend fixture requires bounded state");
        }
        return createPluginStateKeyedStoreForTests<T>("x", {
          ...options,
          maxEntries: options.maxEntries,
        });
      },
      openKeyedStoreV2: <T>(
        options: OpenAsyncKeyedStoreOptions,
        authority?: PluginStateActionAuthority,
      ) => {
        if (options.maxEntries === undefined || !authority) {
          throw new Error("OAuth fixture requires bounded state and current authority");
        }
        const store = createPluginStateKeyedStoreV2ForTests<T>("x", options, authority);
        return {
          ...store,
          compareAndApply: async (...args: Parameters<typeof store.compareAndApply>) => {
            const change = args[2];
            const tokenCommit =
              change.action === "set" &&
              typeof change.value === "object" &&
              change.value !== null &&
              "settledClaim" in change.value;
            if (tokenCommit && failTokenCommit === "before") {
              throw new Error("synthetic persistence failure");
            }
            const result = await store.compareAndApply(...args);
            if (tokenCommit && failTokenCommit === "after") {
              failTokenCommit = undefined;
              throw new Error("synthetic lost commit response");
            }
            return result;
          },
        };
      },
    },
  });
}

function requestBody(init?: RequestInit): string {
  if (typeof init?.body !== "string") {
    throw new Error("Expected a serialized OAuth request body");
  }
  return init.body;
}

beforeEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  stateDir = mkdtempSync(path.join(os.tmpdir(), "x-oauth-owner-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  current = config();
  failTokenCommit = undefined;
  refreshes.length = requests.length = 0;
  exchange = (_token, attempt) => tokenResponse(attempt);
  resource = () => Response.json({ data: [] });
  fixture.fetch.mockReset();
  fixture.fetch.mockImplementation(async (input, init) => {
    requests.push(input);
    if (!input.endsWith("/oauth2/token")) {
      return resource(input, init);
    }
    const token = new URLSearchParams(requestBody(init)).get("refresh_token");
    refreshes.push({ token, auth: new Headers(init?.headers).get("authorization") });
    return exchange(token, refreshes.length);
  });
  setXTestFetch("api.x.com", fixture.fetch);
  restartRuntime();
});

afterEach(async () => {
  vi.useRealTimers();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("X OAuth client ownership", () => {
  it("shares an active refresh across transport rotation and preserves its grant across restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const refreshStarted = Promise.withResolvers<void>();
    const releaseRefresh = Promise.withResolvers<void>();
    const bearerHeaders: (string | null)[] = [];
    exchange = async (_token, attempt) => {
      if (attempt === 1) {
        refreshStarted.resolve();
        await releaseRefresh.promise;
      }
      return tokenResponse(attempt);
    };
    resource = (input, init) => {
      if (input.endsWith("/activity/subscriptions")) {
        bearerHeaders.push(new Headers(init?.headers).get("authorization"));
        return Response.json({
          data: [{ event_type: "post.mention.create", filter: { user_id: "9" } }],
        });
      }
      return Response.json({ data: [] });
    };
    const initial = await getXApi("default", config());
    const first = initial.getMentions({ userId: "9" });
    await refreshStarted.promise;
    const rotatedConfig = config({ bearerToken: "bearer-new", clientSecret: "secret-new" });
    current = rotatedConfig;
    const updated = await getXApi("default", rotatedConfig);
    const concurrent = updated.getMentions({ userId: "9" });
    releaseRefresh.resolve();
    await Promise.all([first, concurrent]);
    expect(tokens()).toEqual(["seed-initial"]);
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
    current = config({ refreshToken: "seed-new" });
    await (await getXApi("default", current)).getMentions({ userId: "9" });
    expect(refreshes.at(-1)?.token).toBe("seed-new");
  });

  it("does not let a retired seed overwrite the replacement grant", async () => {
    const staleStarted = Promise.withResolvers<void>();
    const releaseStale = Promise.withResolvers<void>();
    exchange = async (token) => {
      if (token === "seed-initial") {
        staleStarted.resolve();
        await releaseStale.promise;
      }
      return Response.json({
        access_token: "access",
        refresh_token: token === "seed-initial" ? "rotated-stale" : "rotated-current",
      });
    };
    const stale = (await getXApi("default", config())).getMentions({ userId: "9" });
    const rejected = expect(stale).rejects.toThrow("X token refresh failed");
    await staleStarted.promise;
    const replacement = config({ refreshToken: "seed-new" });
    current = replacement;
    await (await getXApi("default", replacement)).getMentions({ userId: "9" });
    releaseStale.resolve();
    await rejected;
    restartRuntime();
    await (await getXApi("default", replacement)).getMentions({ userId: "9" });
    expect(tokens()).toEqual(["seed-initial", "seed-new", "rotated-current"]);
  });
});

it.each(["lost-response", "http-429", "http-503", "nested-200", "invalid-rotation"] as const)(
  "fences %s across retry and SQLite/runtime reopen",
  async (mode) => {
    exchange = () => {
      if (mode === "lost-response") {
        throw new Error("synthetic network loss");
      }
      if (mode === "http-429" || mode === "http-503") {
        return Response.json({}, { status: mode === "http-429" ? 429 : 503 });
      }
      if (mode === "nested-200") {
        return Response.json({
          error: { code: "invalid_grant" },
          access_token: "must-not-publish",
        });
      }
      return Response.json({ access_token: "must-not-publish", refresh_token: 7 });
    };
    const api = await getXApi("default", current);
    await expect(api.getMentions({ userId: "9" })).rejects.toThrow();
    await expect(api.getMentions({ userId: "9" })).rejects.toThrow();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    restartRuntime();
    await expect(
      (await getXApi("default", current)).getMentions({ userId: "9" }),
    ).rejects.toThrow();
    expect(tokens()).toEqual(["seed-initial"]);
  },
);
it("rechecks current account configuration after a held provider response without requiring a new client lookup", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  exchange = async (_token, attempt) => {
    entered.resolve();
    await release.promise;
    return tokenResponse(attempt);
  };
  const result = (await getXApi("default", current)).getMentions({ userId: "9" });
  const rejected = expect(result).rejects.toThrow();
  await entered.promise;
  current = config({ refreshToken: "new-login" });
  release.resolve();
  await rejected;
  expect(requests).toHaveLength(1);
});

it.each(["before", "after"] as const)(
  "recovers a %s-commit failure without exchanging the completed rotation twice",
  async (mode) => {
    let uses = 0;
    resource = () => {
      uses++;
      return Response.json({ data: [] });
    };
    exchange = (_token, attempt) => {
      if (attempt === 1) {
        failTokenCommit = mode;
      }
      return tokenResponse(attempt);
    };
    const api = await getXApi("default", current);
    await expect(api.getMentions({ userId: "9" })).rejects.toThrow();
    expect(uses).toBe(0);
    failTokenCommit = undefined;
    await api.getMentions({ userId: "9" });
    expect(tokens()).toEqual(["seed-initial"]);
    expect(uses).toBe(1);
    restartRuntime();
    await (await getXApi("default", current)).getMentions({ userId: "9" });
    expect(tokens()).toEqual(["seed-initial", "rotated-1"]);
  },
);

it("detaches an aborted caller while a joined owner persists its late rotation", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  exchange = async (_token, attempt) => {
    if (attempt === 1) {
      entered.resolve();
      await release.promise;
    }
    return tokenResponse(attempt);
  };
  const api = await getXApi("default", current);
  const controller = new AbortController();
  const first = api.getMentions({ userId: "9", signal: controller.signal });
  const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
  await entered.promise;
  const second = api.getMentions({ userId: "9" });
  controller.abort();
  await rejected;
  expect(tokens()).toEqual(["seed-initial"]);
  release.resolve();
  await second;
  restartRuntime();
  await (await getXApi("default", current)).getMentions({ userId: "9" });
  expect(tokens()).toEqual(["seed-initial", "rotated-1"]);
});
