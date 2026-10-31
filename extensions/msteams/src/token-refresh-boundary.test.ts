import { lookup as dnsLookup } from "node:dns/promises";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimMSTeamsDelegatedTokenRefresh,
  loadMSTeamsDelegatedTokens,
  saveMSTeamsDelegatedTokens,
} from "./delegated-state.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";
import { resolveDelegatedAccessToken } from "./token.js";

const params = {
  accountId: "synthetic",
  tenantId: "tenant",
  clientId: "client",
  clientSecret: "synthetic-secret",
};
const original = {
  accessToken: "synthetic-old-access",
  refreshToken: "synthetic-old-refresh",
  expiresAt: 1,
  scopes: ["User.Read", "offline_access"],
};
const response = {
  access_token: "synthetic-next-access",
  refresh_token: "synthetic-next-refresh",
  expires_in: 3600,
  scope: "User.Read offline_access",
};
vi.mock("node:dns/promises", { spy: true });
let stateDir: string;
beforeEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  stateDir = mkdtempSync(path.join(os.tmpdir(), "teams-refresh-boundary-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  setMSTeamsRuntime(msteamsRuntimeStub);
  await saveMSTeamsDelegatedTokens(original, params.accountId);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

async function assertRequest(url: RequestInfo | URL, init?: RequestInit) {
  expect(resolveRequestUrl(url)).toBe("https://login.microsoftonline.com/tenant/oauth2/v2.0/token");
  expect(init?.method).toBe("POST");
  expect(new URLSearchParams(await new Response(init?.body).text())).toEqual(
    new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      grant_type: "refresh_token",
      scope: "User.Read offline_access",
      refresh_token: original.refreshToken,
    }),
  );
}

function mockExchange(reply: () => Response | Promise<Response> = () => Response.json(response)) {
  const network = vi.fn<typeof fetch>(async (url, init) => {
    await assertRequest(url, init);
    return reply();
  });
  vi.stubGlobal("fetch", network);
  return network;
}

function holdExchange() {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const network = mockExchange(async () => {
    entered.resolve();
    await release.promise;
    return Response.json(response);
  });
  return { entered, release, network };
}

it("restores an undispatched Microsoft grant after DNS failure at the real request guard", async () => {
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
    await expect(resolveDelegatedAccessToken(params)).resolves.toBeUndefined();
    expect(posts).toBe(0);
    expect(lookup).toHaveBeenCalled();
  } finally {
    lookup.mockRestore();
  }
  expect((await loadMSTeamsDelegatedTokens(params.accountId))?.refreshToken).toBe(
    original.refreshToken,
  );
  mockExchange();
  await expect(resolveDelegatedAccessToken(params)).resolves.toBe(response.access_token);
});

describe("Teams actual delegated HTTP parser and SQLite owner", () => {
  it("coalesces callers and publishes the replacement before returning access", async () => {
    const { entered, release, network } = holdExchange();
    const first = resolveDelegatedAccessToken(params);
    await entered.promise;
    const second = resolveDelegatedAccessToken(params);
    release.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      response.access_token,
      response.access_token,
    ]);
    expect(network).toHaveBeenCalledOnce();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    expect(await loadMSTeamsDelegatedTokens(params.accountId)).toMatchObject({
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
    });
  });

  it("does not replay a structured rejection", async () => {
    const network = mockExchange(() => Response.json({ error: { code: "invalid_grant" } }));
    await expect(resolveDelegatedAccessToken(params)).resolves.toBeUndefined();
    await expect(resolveDelegatedAccessToken(params)).resolves.toBeUndefined();
    expect(network).toHaveBeenCalledOnce();
    expect(await loadMSTeamsDelegatedTokens(params.accountId)).toBeUndefined();
  });

  it.each(["lost-response", "503", "html-503", "unreadable-body", "crash"])(
    "recovers the reusable Microsoft grant after %s",
    async (mode) => {
      if (mode === "crash") {
        expect(
          await claimMSTeamsDelegatedTokenRefresh(
            original,
            "dead-request",
            "dead-owner",
            params.accountId,
          ),
        ).toBeDefined();
      }
      const network = mockExchange(() => {
        if (network.mock.calls.length === 1 && mode !== "crash") {
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
        return Response.json(response);
      });
      if (mode !== "crash") {
        await expect(resolveDelegatedAccessToken(params)).resolves.toBeUndefined();
      }
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      await expect(resolveDelegatedAccessToken(params)).resolves.toBe(response.access_token);
      expect(network).toHaveBeenCalledTimes(mode === "crash" ? 1 : 2);
      expect(await loadMSTeamsDelegatedTokens(params.accountId)).toMatchObject({
        refreshToken: response.refresh_token,
      });
    },
  );

  it("does not overwrite a newer login while the old exchange settles", async () => {
    const { entered, release } = holdExchange();
    const result = resolveDelegatedAccessToken(params);
    await entered.promise;
    const newer = {
      ...original,
      accessToken: "synthetic-login-access",
      refreshToken: "synthetic-login-refresh",
      expiresAt: Date.now() + 3600000,
    };
    await saveMSTeamsDelegatedTokens(newer, params.accountId);
    release.resolve();
    await expect(result).resolves.toBeUndefined();
    expect(await loadMSTeamsDelegatedTokens(params.accountId)).toEqual(newer);
  });
});
