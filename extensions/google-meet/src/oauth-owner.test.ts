import { lookup as dnsLookup } from "node:dns/promises";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateActionAuthority,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveGoogleMeetConfig } from "./config.js";
import { resolveGoogleMeetTokenFromParams } from "./plugin-helpers.js";

const initial = {
  clientId: "synthetic-client",
  clientSecret: "synthetic-secret",
  accessToken: "synthetic-old",
  refreshToken: "synthetic-refresh",
  expiresAt: 1,
};
const rotated = {
  access_token: "synthetic-next",
  refresh_token: "synthetic-next-refresh",
  expires_in: 3600,
};
vi.mock("node:dns/promises", { spy: true });
let stateDir: string;
let refuseSettlement = false;
let current = { plugins: { entries: { "google-meet": { config: { oauth: initial } } } } };
const runtime = {
  state: {
    openKeyedStoreV2: <T>(
      options: OpenAsyncKeyedStoreOptions,
      authority?: PluginStateActionAuthority,
    ) => {
      if (options.maxEntries === undefined || !authority) {
        throw new Error("OAuth fixture requires bounded state and current authority");
      }
      const store = createPluginStateKeyedStoreV2ForTests<T>("google-meet", options, authority);
      return {
        ...store,
        compareAndApply: async (...args: Parameters<typeof store.compareAndApply>) => {
          if (refuseSettlement) {
            throw new Error("synthetic settlement storage failure");
          }
          return store.compareAndApply(...args);
        },
      };
    },
  },
  config: { current: () => current },
};
beforeEach(async () => {
  refuseSettlement = false;
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  stateDir = mkdtempSync(path.join(os.tmpdir(), "meet-oauth-owner-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  current = { plugins: { entries: { "google-meet": { config: { oauth: { ...initial } } } } } };
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});
function config() {
  return resolveGoogleMeetConfig(current.plugins.entries["google-meet"].config);
}
const token = (owner = runtime) => resolveGoogleMeetTokenFromParams(config(), {}, owner);
async function reopen() {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
}
function stubFetch(handler: typeof fetch = async () => Response.json(rotated)) {
  const network = vi.fn<typeof fetch>(handler);
  vi.stubGlobal("fetch", network);
  return network;
}
function heldRefresh() {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const network = stubFetch(async (url, init) => {
    await assertRequest(url, init);
    entered.resolve();
    await release.promise;
    return Response.json(rotated);
  });
  return { entered: entered.promise, release: release.resolve, network };
}
const expectToken = async (expected = rotated.access_token) =>
  expect(await token()).toMatchObject({ accessToken: expected });
async function assertRequest(url: RequestInfo | URL, init?: RequestInit) {
  expect(resolveRequestUrl(url)).toBe("https://oauth2.googleapis.com/token");
  expect(init?.method).toBe("POST");
  expect(new URLSearchParams(await new Response(init?.body).text())).toEqual(
    new URLSearchParams({
      client_id: initial.clientId,
      client_secret: initial.clientSecret,
      grant_type: "refresh_token",
      refresh_token: initial.refreshToken,
    }),
  );
}
it("recovers an undispatched DNS failure through the real Google request guard", async () => {
  const lookup = vi
    .mocked(dnsLookup)
    .mockRejectedValueOnce(
      Object.assign(new Error("synthetic DNS offline"), { code: "EAI_AGAIN" }),
    );
  const originalFetch = globalThis.fetch;
  let posts = 0;
  vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => {
    posts++;
    return originalFetch(...args);
  });
  try {
    await expect(resolveGoogleMeetTokenFromParams(config(), {}, runtime)).rejects.toMatchObject({
      oauthRefreshOutcome: { phase: "before-dispatch", outcome: "not-attempted" },
    });
    expect(posts).toBe(0);
    expect(lookup).toHaveBeenCalled();
  } finally {
    lookup.mockRestore();
  }
  stubFetch(async (url, init) => {
    await assertRequest(url, init);
    return Response.json(rotated);
  });
  await expectToken();
});

it("coalesces the real token exchange and reopens durable rotation rather than stale config", async () => {
  const { entered, release, network } = heldRefresh();
  const first = token();
  await entered;
  const second = token();
  release();
  expect((await Promise.all([first, second])).map((value) => value.accessToken)).toEqual([
    rotated.access_token,
    rotated.access_token,
  ]);
  await reopen();
  await expectToken();
  expect(network).toHaveBeenCalledOnce();
});
it.each(["nested-invalid-grant"] as const)(
  "does not replay %s through the configured owner",
  async () => {
    const network = stubFetch(async (url, init) => {
      await assertRequest(url, init);
      return Response.json({ error: { code: "invalid_grant" } });
    });
    await expect(token()).rejects.toThrow();
    await expect(token()).rejects.toThrow();
    expect(network).toHaveBeenCalledOnce();
  },
);
it.each(["lost-response", "503", "html-503", "unreadable-body"])(
  "recovers the reusable Google grant after %s and reopening storage",
  async (mode) => {
    const network = stubFetch(async (url, init) => {
      await assertRequest(url, init);
      if (network.mock.calls.length === 1) {
        if (mode === "lost-response") {
          throw new TypeError("synthetic lost response");
        }
        if (mode === "html-503") {
          return new Response("<html>upstream unavailable</html>", {
            status: 503,
            headers: { "content-type": "text/html" },
          });
        }
        if (mode === "unreadable-body") {
          return new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(new Error("synthetic body reset"));
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
      }
      return Response.json(rotated);
    });
    await expect(token()).rejects.toThrow();
    await reopen();
    await expectToken();
    expect(network).toHaveBeenCalledTimes(2);
  },
);
it("makes one-shot rotation without a durable owner explicitly actionable", async () => {
  stubFetch();
  await expect(resolveGoogleMeetTokenFromParams(config(), {})).rejects.toThrow(/rotation.*owner/i);
});

it("uses the persisted replacement on the next actual refresh", async () => {
  const network = stubFetch(async (_url, init) => {
    const refresh = new URLSearchParams(await new Response(init?.body).text()).get("refresh_token");
    if (network.mock.calls.length === 1) {
      expect(refresh).toBe(initial.refreshToken);
      return Response.json({ ...rotated, expires_in: 0 });
    }
    expect(refresh).toBe(rotated.refresh_token);
    return Response.json({ ...rotated, access_token: "synthetic-third" });
  });
  await token();
  await reopen();
  await expectToken("synthetic-third");
  expect(network).toHaveBeenCalledTimes(2);
});
it.each(["", 42, null])(
  "never restores a grant after an invalid replacement refresh token %j",
  async (refreshToken) => {
    const network = stubFetch(async () =>
      Response.json({ ...rotated, refresh_token: refreshToken }),
    );
    await expect(token()).rejects.toThrow(/refresh_token/);
    await expect(token()).rejects.toThrow(/uncertain/);
    expect(network).toHaveBeenCalledOnce();
  },
);
it("does not treat Date-invalid cached expiry as a usable grant", async () => {
  current.plugins.entries["google-meet"].config.oauth.expiresAt = 9e20;
  const network = stubFetch();
  await expectToken();
  expect(network).toHaveBeenCalledOnce();
});
it("cannot publish a rotated token when durable settlement fails", async () => {
  const network = stubFetch().mockImplementationOnce(async () => {
    refuseSettlement = true;
    return Response.json(rotated);
  });
  await expect(token()).rejects.toThrow("settlement storage failure");
  refuseSettlement = false;
  await expectToken();
  expect(network).toHaveBeenCalledTimes(2);
});

it.each(["account", "plugin", "config"] as const)(
  "does not publish a held refresh after %s authority changes",
  async (mode) => {
    const { entered, release, network } = heldRefresh();
    const outcome = token().then(
      () => "published",
      () => "revoked",
    );
    await entered;
    const entry = current.plugins.entries["google-meet"];
    if (mode === "account") {
      entry.config.oauth = {
        ...initial,
        accessToken: "synthetic-new-login",
        refreshToken: "synthetic-new-login-refresh",
        expiresAt: Date.now() + 3600000,
      };
    } else {
      Object.assign(mode === "plugin" ? entry : entry.config, { enabled: false });
    }
    release();
    expect(await outcome).toBe("revoked");
    if (mode === "account") {
      await expectToken("synthetic-new-login");
    } else {
      await expect(token()).rejects.toThrow();
    }
    expect(network).toHaveBeenCalledOnce();
  },
);
