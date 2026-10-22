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
      return createPluginStateKeyedStoreV2ForTests<T>("google-meet", options, authority);
    },
  },
  config: { current: () => current },
};
beforeEach(async () => {
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
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url, init) => {
      await assertRequest(url, init);
      return Response.json(rotated);
    }),
  );
  await expect(resolveGoogleMeetTokenFromParams(config(), {}, runtime)).resolves.toMatchObject({
    accessToken: rotated.access_token,
  });
});

it("coalesces the real token exchange and reopens durable rotation rather than stale config", async () => {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const network = vi.fn<typeof fetch>(async (url, init) => {
    await assertRequest(url, init);
    entered.resolve();
    await release.promise;
    return Response.json(rotated);
  });
  vi.stubGlobal("fetch", network);
  const first = resolveGoogleMeetTokenFromParams(config(), {}, runtime);
  await entered.promise;
  const second = resolveGoogleMeetTokenFromParams(config(), {}, runtime);
  release.resolve();
  expect((await Promise.all([first, second])).map((value) => value.accessToken)).toEqual([
    rotated.access_token,
    rotated.access_token,
  ]);
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  expect((await resolveGoogleMeetTokenFromParams(config(), {}, runtime)).accessToken).toBe(
    rotated.access_token,
  );
  expect(network).toHaveBeenCalledOnce();
});
it.each(["nested-invalid-grant"] as const)(
  "does not replay %s through the configured owner",
  async () => {
    const network = vi.fn<typeof fetch>(async (url, init) => {
      await assertRequest(url, init);
      return Response.json({ error: { code: "invalid_grant" } });
    });
    vi.stubGlobal("fetch", network);
    await expect(resolveGoogleMeetTokenFromParams(config(), {}, runtime)).rejects.toThrow();
    await expect(resolveGoogleMeetTokenFromParams(config(), {}, runtime)).rejects.toThrow();
    expect(network).toHaveBeenCalledOnce();
  },
);
it.each(["lost-response", "503", "html-503", "unreadable-body"])(
  "recovers the reusable Google grant after %s and reopening storage",
  async (mode) => {
    const network = vi.fn<typeof fetch>(async (url, init) => {
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
    vi.stubGlobal("fetch", network);
    await expect(resolveGoogleMeetTokenFromParams(config(), {}, runtime)).rejects.toThrow();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    expect((await resolveGoogleMeetTokenFromParams(config(), {}, runtime)).accessToken).toBe(
      rotated.access_token,
    );
    expect(network).toHaveBeenCalledTimes(2);
  },
);
it("does not publish an old grant after the configured account changes", async () => {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const network = vi.fn<typeof fetch>(async () => {
    entered.resolve();
    await release.promise;
    return Response.json(rotated);
  });
  vi.stubGlobal("fetch", network);
  const old = resolveGoogleMeetTokenFromParams(config(), {}, runtime);
  const outcome = old.then(
    () => "published",
    () => "changed",
  );
  await entered.promise;
  current.plugins.entries["google-meet"].config.oauth = {
    ...initial,
    accessToken: "synthetic-new-login",
    refreshToken: "synthetic-new-login-refresh",
    expiresAt: Date.now() + 3600000,
  };
  release.resolve();
  expect(await outcome).toBe("changed");
  expect((await resolveGoogleMeetTokenFromParams(config(), {}, runtime)).accessToken).toBe(
    "synthetic-new-login",
  );
  expect(network).toHaveBeenCalledOnce();
});
it("makes one-shot rotation without a durable owner explicitly actionable", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => Response.json(rotated)),
  );
  await expect(resolveGoogleMeetTokenFromParams(config(), {})).rejects.toThrow(/rotation.*owner/i);
});

it("uses the persisted replacement on the next actual refresh", async () => {
  const network = vi.fn<typeof fetch>(async (_url, init) => {
    const refresh = new URLSearchParams(await new Response(init?.body).text()).get("refresh_token");
    if (network.mock.calls.length === 1) {
      expect(refresh).toBe(initial.refreshToken);
      return Response.json({ ...rotated, expires_in: 0 });
    }
    expect(refresh).toBe(rotated.refresh_token);
    return Response.json({ ...rotated, access_token: "synthetic-third" });
  });
  vi.stubGlobal("fetch", network);
  await resolveGoogleMeetTokenFromParams(config(), {}, runtime);
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  expect((await resolveGoogleMeetTokenFromParams(config(), {}, runtime)).accessToken).toBe(
    "synthetic-third",
  );
  expect(network).toHaveBeenCalledTimes(2);
});
it.each(["", 42, null])(
  "never restores a grant after an invalid replacement refresh token %j",
  async (refreshToken) => {
    const network = vi.fn<typeof fetch>(async () =>
      Response.json({ ...rotated, refresh_token: refreshToken }),
    );
    vi.stubGlobal("fetch", network);
    await expect(resolveGoogleMeetTokenFromParams(config(), {}, runtime)).rejects.toThrow(
      /refresh_token/,
    );
    await expect(resolveGoogleMeetTokenFromParams(config(), {}, runtime)).rejects.toThrow(
      /uncertain/,
    );
    expect(network).toHaveBeenCalledOnce();
  },
);
it("does not treat Date-invalid cached expiry as a usable grant", async () => {
  current.plugins.entries["google-meet"].config.oauth.expiresAt = 9e20;
  const network = vi.fn<typeof fetch>(async () => Response.json(rotated));
  vi.stubGlobal("fetch", network);
  expect((await resolveGoogleMeetTokenFromParams(config(), {}, runtime)).accessToken).toBe(
    rotated.access_token,
  );
  expect(network).toHaveBeenCalledOnce();
});
it("cannot publish a rotated token when durable settlement fails", async () => {
  const refusingRuntime = {
    ...runtime,
    state: {
      openKeyedStoreV2: <T>(
        options: OpenAsyncKeyedStoreOptions,
        authority?: PluginStateActionAuthority,
      ) => {
        const store = runtime.state.openKeyedStoreV2<T>(options, authority);
        return {
          ...store,
          compareAndApply: async (...args: Parameters<typeof store.compareAndApply>) => {
            if (network.mock.calls.length) {
              throw new Error("synthetic settlement storage failure");
            }
            return await store.compareAndApply(...args);
          },
        };
      },
    },
  };
  const network = vi.fn<typeof fetch>(async () => Response.json(rotated));
  vi.stubGlobal("fetch", network);
  await expect(resolveGoogleMeetTokenFromParams(config(), {}, refusingRuntime)).rejects.toThrow(
    "settlement storage failure",
  );
  await expect(resolveGoogleMeetTokenFromParams(config(), {}, runtime)).resolves.toMatchObject({
    accessToken: rotated.access_token,
  });
  expect(network).toHaveBeenCalledTimes(2);
});

it.each(["plugin", "config"] as const)(
  "does not publish a held refresh after %s is disabled",
  async (mode) => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const network = vi.fn<typeof fetch>(async () => {
      entered.resolve();
      await release.promise;
      return Response.json(rotated);
    });
    vi.stubGlobal("fetch", network);
    const outcome = resolveGoogleMeetTokenFromParams(config(), {}, runtime).then(
      () => "published",
      () => "disabled",
    );
    await entered.promise;
    Object.assign(
      mode === "plugin"
        ? current.plugins.entries["google-meet"]
        : current.plugins.entries["google-meet"].config,
      { enabled: false },
    );
    release.resolve();
    expect(await outcome).toBe("disabled");
    await expect(resolveGoogleMeetTokenFromParams(config(), {}, runtime)).rejects.toThrow();
    expect(network).toHaveBeenCalledOnce();
  },
);
