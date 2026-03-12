import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { getAccessToken, sendCustomTextMessage } from "../src/api.js";
import { getWempDataRoot } from "../src/storage.js";
import type { ResolvedWempAccount } from "../src/types.js";

const DATA_DIR = getWempDataRoot();

interface FileSnapshot {
  existed: boolean;
  content: string;
}

function snapshotFile(file: string): FileSnapshot {
  if (!existsSync(file)) return { existed: false, content: "" };
  return { existed: true, content: readFileSync(file, "utf8") };
}

function restoreFile(file: string, snapshot: FileSnapshot): void {
  if (snapshot.existed) {
    writeFileSync(file, snapshot.content, "utf8");
    return;
  }
  rmSync(file, { force: true });
}

function accountFixture(accountId: string): ResolvedWempAccount {
  return {
    accountId,
    enabled: true,
    configured: true,
    appId: "app",
    appSecret: "secret",
    token: "token",
    webhookPath: "/wemp",
    dm: { policy: "pairing", allowFrom: [] },
    routing: { pairedAgent: "main", unpairedAgent: "wemp-kf" },
    features: {
      menu: { enabled: false, items: [] },
      assistantToggle: { enabled: false, defaultEnabled: false },
      usageLimit: { enabled: false, dailyMessages: 0, dailyTokens: 0, exemptPaired: true },
      handoff: { enabled: false, contact: "", message: "" },
      welcome: { enabled: false, subscribeText: "" },
    },
    config: {},
  };
}

test("sendCustomTextMessage enters local cooldown after WeChat rate limit response", async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  const accountId = `acct-${Date.now()}-${Math.random()}`;

  globalThis.fetch = (async (url: string | URL) => {
    fetchCount += 1;
    const value = String(url);
    if (value.includes("/cgi-bin/token")) {
      return new Response(
        JSON.stringify({
          access_token: `token-${accountId}`,
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        errcode: 45009,
        errmsg: "api freq out of limit",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const account = accountFixture(accountId);
  const first = await sendCustomTextMessage(account, "open-id-1", "hello");
  assert.equal(first.ok, false);
  assert.equal(first.errcode, 45009);
  assert.equal(fetchCount, 2);

  const second = await sendCustomTextMessage(account, "open-id-1", "hello-again");
  assert.equal(second.ok, false);
  assert.equal(second.errcode, 45009);
  assert.match(String(second.errmsg || ""), /rate_limited_local_cooldown/);
  assert.equal(fetchCount, 2);
});

test("getAccessToken loads persisted cache after module reload", async (t) => {
  mkdirSync(DATA_DIR, { recursive: true });
  const cacheFile = path.join(DATA_DIR, "access-token-cache.json");
  const snapshot = snapshotFile(cacheFile);
  t.after(() => {
    restoreFile(cacheFile, snapshot);
  });

  writeFileSync(cacheFile, "{}", "utf8");
  const seed = `${Date.now()}-${Math.random()}`;
  const account = accountFixture(`acct-token-${seed}`);

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let fetchCount = 0;
  globalThis.fetch = (async (url: string | URL) => {
    fetchCount += 1;
    const value = String(url);
    if (value.includes("/cgi-bin/token")) {
      return new Response(
        JSON.stringify({
          access_token: `token-${seed}`,
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected url: ${value}`);
  }) as typeof fetch;

  const tokenA = await getAccessToken(account);
  assert.equal(tokenA, `token-${seed}`);
  assert.equal(fetchCount, 1);
  const persisted = JSON.parse(readFileSync(cacheFile, "utf8")) as Record<
    string,
    { token?: string }
  >;
  assert.equal(persisted[account.accountId]?.token, `token-${seed}`);

  globalThis.fetch = (async () => {
    throw new Error("should not fetch token when persisted cache is valid");
  }) as typeof fetch;

  const apiUrl = new URL("../src/api.ts", import.meta.url);
  apiUrl.searchParams.set("seed", seed);
  const reloadedApi = await import(apiUrl.href);
  const tokenB = await reloadedApi.getAccessToken(account);
  assert.equal(tokenB, `token-${seed}`);
  assert.equal(fetchCount, 1);
});

test("getAccessToken deduplicates concurrent refresh requests", async (t) => {
  const seed = `${Date.now()}-${Math.random()}`;
  const account = accountFixture(`acct-token-concurrency-${seed}`);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let tokenFetchCount = 0;
  globalThis.fetch = (async (url: string | URL) => {
    const value = String(url);
    if (!value.includes("/cgi-bin/token")) {
      throw new Error(`unexpected url: ${value}`);
    }
    tokenFetchCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return new Response(
      JSON.stringify({
        access_token: `token-concurrency-${seed}`,
        expires_in: 7200,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const [tokenA, tokenB] = await Promise.all([
    getAccessToken(account, true),
    getAccessToken(account, true),
  ]);

  assert.equal(tokenA, `token-concurrency-${seed}`);
  assert.equal(tokenB, `token-concurrency-${seed}`);
  assert.equal(tokenFetchCount, 1);
});
