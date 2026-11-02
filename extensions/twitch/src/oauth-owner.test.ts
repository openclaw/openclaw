import { lookup as dnsLookup } from "node:dns/promises";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthProvider } from "@twurple/auth";
import type { ChatClientOptions } from "@twurple/chat";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateActionAuthority,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setTwitchRuntime } from "./runtime.js";
import { TwitchClientManager } from "./twitch-client.js";

let provider: AuthProvider;
const listener = () => ({ unbind() {} });
vi.mock("@twurple/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@twurple/chat")>()),
  ChatClient: class {
    private ready = () => {};
    constructor(options: ChatClientOptions) {
      provider = options.authProvider!;
    }
    onAuthenticationSuccess(fn: () => void) {
      this.ready = fn;
      return listener();
    }
    onAuthenticationFailure = listener;
    onDisconnect = listener;
    onMessage() {}
    connect() {
      this.ready();
    }
    quit() {}
  },
}));
const initial = {
  username: "synthetic-user",
  channel: "synthetic-channel",
  clientId: "synthetic-client",
  clientSecret: "synthetic-secret",
  accessToken: "synthetic-old",
  refreshToken: "synthetic-refresh",
  expiresIn: 0,
  obtainmentTimestamp: 1,
};
const rotated = {
  access_token: "synthetic-next",
  refresh_token: "synthetic-next-refresh",
  expires_in: 3600,
  scope: ["chat:read", "chat:edit"],
  token_type: "bearer",
};
const logger = { info() {}, warn() {}, error() {} };
let current: OpenClawConfig;
vi.mock("node:dns/promises", { spy: true });
let stateDir: string;
function manager() {
  return new TwitchClientManager(logger);
}
function connect(owner = manager()) {
  return owner.getClient(initial, current, "default");
}
async function reopenState() {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
}
beforeEach(async () => {
  await reopenState();
  stateDir = mkdtempSync(path.join(os.tmpdir(), "twitch-oauth-owner-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  current = { channels: { twitch: { ...initial } } };
  const base = createPluginRuntimeMock();
  setTwitchRuntime({
    ...base,
    config: { ...base.config, current: () => current },
    state: {
      ...base.state,
      openKeyedStoreV2: <T>(
        options: OpenAsyncKeyedStoreOptions,
        authority?: PluginStateActionAuthority,
      ) => {
        if (options.maxEntries === undefined || !authority) {
          throw new Error("OAuth fixture requires bounded state and current authority");
        }
        return createPluginStateKeyedStoreV2ForTests<T>("twitch", options, authority);
      },
    },
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await reopenState();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});
function network(handler: () => Promise<Response>, beforeValidate = () => {}) {
  const tokenPosts: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(resolveRequestUrl(input));
      if (url.pathname === "/oauth2/token") {
        expect(init?.method).toBe("POST");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        const form = new URLSearchParams(await new Response(init?.body).text());
        expect(url.search).toBe("");
        expect(form.get("client_id")).toBe(initial.clientId);
        expect(form.get("client_secret")).toBe(initial.clientSecret);
        expect(form.get("grant_type")).toBe("refresh_token");
        tokenPosts.push(form.get("refresh_token")!);
        return await handler();
      }
      expect(url.href).toBe("https://id.twitch.tv/oauth2/validate");
      beforeValidate();
      return Response.json({
        client_id: initial.clientId,
        login: initial.username,
        user_id: "synthetic-user-id",
        scopes: rotated.scope,
        expires_in: 3600,
      });
    }),
  );
  return tokenPosts;
}
it("restores an undispatched grant after DNS failure at the real request guard", async () => {
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
    await expect(connect()).rejects.toThrow();
    expect(posts).toBe(0);
    expect(lookup).toHaveBeenCalled();
  } finally {
    lookup.mockRestore();
  }
  const attempts = network(async () => Response.json(rotated));
  await connect();
  expect(attempts).toEqual([initial.refreshToken]);
});
it("uses a fresh configured access token for chat scopes without consuming its refresh grant", async () => {
  const fresh = { ...initial, expiresIn: 3600, obtainmentTimestamp: Date.now() };
  current = { channels: { twitch: fresh } };
  const posts = network(async () => {
    throw new Error("refresh endpoint unavailable");
  });
  await manager().getClient(fresh, current, "default");
  expect(
    (await provider.getAccessTokenForIntent!("chat", ["chat:read", "chat:edit"]))?.accessToken,
  ).toBe(initial.accessToken);
  expect(posts).toEqual([]);
});
it("retains a completed rotation when token validation is transiently unavailable", async () => {
  let validations = 0;
  const posts = network(
    async () => Response.json(rotated),
    () => {
      if (++validations === 1) {
        throw new TypeError("synthetic validation offline");
      }
    },
  );
  await expect(connect()).rejects.toThrow();
  await reopenState();
  await connect();
  expect(validations).toBe(2);
  expect((await provider.getAccessTokenForIntent!("chat"))?.accessToken).toBe(rotated.access_token);
  expect(posts).toEqual([initial.refreshToken]);
});
it("persists the initial rotation before chat and reopens the replacement for the next refresh", async () => {
  const posts = network(async () => Response.json(rotated));
  await connect();
  expect((await provider.getAccessTokenForIntent!("chat"))?.accessToken).toBe(rotated.access_token);
  await reopenState();
  await connect();
  expect(posts).toEqual([initial.refreshToken]);
  await provider.refreshAccessTokenForIntent!("chat");
  expect(posts).toEqual([initial.refreshToken, rotated.refresh_token]);
});
it.each(["lost-response", "nested-rejection"] as const)(
  "does not replay %s after reconnect",
  async (mode) => {
    const posts = network(async () => {
      if (mode === "lost-response") {
        throw new Error("synthetic transport loss");
      }
      return Response.json({ error: { code: "invalid_grant" } });
    });
    await expect(connect()).rejects.toThrow();
    await expect(connect()).rejects.toThrow();
    expect(posts).toEqual([initial.refreshToken]);
  },
);
it.each([{ refreshToken: "synthetic-new-login" }, { enabled: false }])(
  "does not publish a held refresh after authority changes: %j",
  async (change) => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const posts = network(async () => {
      entered.resolve();
      await release.promise;
      return Response.json(rotated);
    });
    const outcome = expect(connect()).rejects.toThrow();
    await entered.promise;
    current = { channels: { twitch: { ...initial, ...change } } };
    release.resolve();
    await outcome;
    if ("enabled" in change) {
      await expect(connect()).rejects.toThrow();
    }
    expect(posts).toEqual([initial.refreshToken]);
  },
);
