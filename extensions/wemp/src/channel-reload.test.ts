import assert from "node:assert/strict";
import test from "node:test";
import { wempPlugin } from "../src/channel.js";
import type { ResolvedWempAccount } from "../src/types.js";
import { resolveRegisteredWebhook, unregisterWempWebhookByAccountId } from "../src/webhook.js";

function accountFixture(params: {
  accountId: string;
  webhookPath: string;
  enabled?: boolean;
}): ResolvedWempAccount {
  return {
    accountId: params.accountId,
    enabled: params.enabled ?? true,
    configured: true,
    appId: `app-${params.accountId}`,
    appSecret: "secret",
    token: `token-${params.accountId}`,
    webhookPath: params.webhookPath,
    dm: { policy: "pairing", allowFrom: [] },
    routing: { pairedAgent: "main", unpairedAgent: "wemp-kf" },
    features: {
      menu: { enabled: false, items: [] },
      assistantToggle: { enabled: false, defaultEnabled: false },
      usageLimit: { enabled: false, dailyMessages: 0, dailyTokens: 0, exemptPaired: true },
      handoff: {
        enabled: false,
        contact: "",
        message: "如需人工支持，请联系：{{contact}}",
        autoResumeMinutes: 30,
        activeReply: "当前会话已转人工处理，请稍候。",
      },
      welcome: { enabled: false, subscribeText: "" },
    },
    config: {},
  };
}

function createReloadContext(account: ResolvedWempAccount): any {
  let status: Record<string, unknown> = {};
  return {
    account,
    runtime: {
      channel: {
        dispatchInbound: async () => undefined,
      },
    },
    getStatus: () => status,
    setStatus: (next: Record<string, unknown>) => {
      status = { ...(next || {}) };
    },
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
}

test("reloadAccount updates webhook registration and supports disable cleanup", async (t) => {
  const reloadAccount = (wempPlugin as any)?.gateway?.reloadAccount;
  assert.equal(typeof reloadAccount, "function");

  const uid = `${Date.now()}-${Math.random()}`;
  const accountId = `acc-reload-${uid}`;
  const firstPath = `/wemp-reload-a-${uid}`;
  const secondPath = `/wemp-reload-b-${uid}`;

  t.after(() => {
    unregisterWempWebhookByAccountId(accountId);
  });

  const firstCtx = createReloadContext(
    accountFixture({
      accountId,
      webhookPath: firstPath,
      enabled: true,
    }),
  );
  await reloadAccount(firstCtx);
  assert.equal(resolveRegisteredWebhook(firstPath)?.accountId, accountId);

  const secondCtx = createReloadContext(
    accountFixture({
      accountId,
      webhookPath: secondPath,
      enabled: true,
    }),
  );
  await reloadAccount(secondCtx);
  assert.equal(resolveRegisteredWebhook(firstPath), null);
  assert.equal(resolveRegisteredWebhook(secondPath)?.accountId, accountId);

  const disabledCtx = createReloadContext(
    accountFixture({
      accountId,
      webhookPath: secondPath,
      enabled: false,
    }),
  );
  await reloadAccount(disabledCtx);
  assert.equal(resolveRegisteredWebhook(secondPath), null);
  assert.equal(disabledCtx.getStatus().running, false);
  assert.equal(disabledCtx.getStatus().connected, false);
  assert.equal(disabledCtx.getStatus().lastError, "account_disabled");
});

test("reloadAccount rolls back to previous webhook when new config is invalid", async (t) => {
  const reloadAccount = (wempPlugin as any)?.gateway?.reloadAccount;
  assert.equal(typeof reloadAccount, "function");

  const uid = `${Date.now()}-${Math.random()}`;
  const accountId = `acc-reload-rollback-${uid}`;
  const stablePath = `/wemp-reload-stable-${uid}`;
  const invalidPath = `/wemp-reload-invalid-${uid}`;

  t.after(() => {
    unregisterWempWebhookByAccountId(accountId);
  });

  const stableAccount = accountFixture({
    accountId,
    webhookPath: stablePath,
    enabled: true,
  });
  await reloadAccount(createReloadContext(stableAccount));
  assert.equal(resolveRegisteredWebhook(stablePath)?.accountId, accountId);

  const invalidAccount = accountFixture({
    accountId,
    webhookPath: invalidPath,
    enabled: true,
  });
  invalidAccount.token = "";
  const invalidCtx = createReloadContext(invalidAccount);
  await reloadAccount(invalidCtx);

  assert.equal(resolveRegisteredWebhook(stablePath)?.accountId, accountId);
  assert.equal(resolveRegisteredWebhook(invalidPath), null);
  assert.equal(invalidCtx.getStatus().running, true);
  assert.equal(invalidCtx.getStatus().connected, true);
  assert.match(
    String(invalidCtx.getStatus().lastError || ""),
    /reload_rolled_back:invalid_account_config/,
  );
});
