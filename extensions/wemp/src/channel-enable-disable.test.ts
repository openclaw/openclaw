import assert from "node:assert/strict";
import test from "node:test";
import { wempPlugin } from "../src/channel.js";
import type { ResolvedWempAccount } from "../src/types.js";
import {
  registerWempWebhook,
  resolveRegisteredWebhook,
  unregisterWempWebhookByAccountId,
} from "../src/webhook.js";

function accountFixture(params: {
  accountId: string;
  enabled: boolean;
  webhookPath: string;
}): ResolvedWempAccount {
  return {
    accountId: params.accountId,
    enabled: params.enabled,
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
      handoff: { enabled: false, contact: "", message: "" },
      welcome: { enabled: false, subscribeText: "" },
    },
    config: {},
  };
}

function createStartAccountContext(account: ResolvedWempAccount): {
  ctx: any;
  controller: AbortController;
} {
  const controller = new AbortController();
  let status: Record<string, unknown> = {};
  const ctx = {
    account,
    runtime: {
      channel: {
        dispatchInbound: async () => undefined,
      },
    },
    abortSignal: controller.signal,
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
  return { ctx, controller };
}

test("startAccount skips webhook registration for disabled account and cleans stale registrations", async (t) => {
  const startAccount = (wempPlugin as any)?.gateway?.startAccount;
  assert.equal(typeof startAccount, "function");

  const uid = `${Date.now()}-${Math.random()}`;
  const accountId = `acc-disabled-${uid}`;
  const stalePath = `/wemp-stale-${uid}`;
  const disabledPath = `/wemp-disabled-${uid}`;

  registerWempWebhook(
    accountFixture({
      accountId,
      enabled: true,
      webhookPath: stalePath,
    }),
  );
  assert.ok(resolveRegisteredWebhook(stalePath));

  const disabledAccount = accountFixture({
    accountId,
    enabled: false,
    webhookPath: disabledPath,
  });
  const { ctx, controller } = createStartAccountContext(disabledAccount);
  const running = startAccount(ctx);

  t.after(async () => {
    controller.abort();
    await running;
    unregisterWempWebhookByAccountId(accountId);
  });

  assert.equal(resolveRegisteredWebhook(stalePath), null);
  assert.equal(resolveRegisteredWebhook(disabledPath), null);

  const status = ctx.getStatus();
  assert.equal(status.running, false);
  assert.equal(status.connected, false);
  assert.equal(status.lastError, "account_disabled");
});

test("stopAccount unregisters webhook and marks runtime stopped without abort", async (t) => {
  const startAccount = (wempPlugin as any)?.gateway?.startAccount;
  const stopAccount = (wempPlugin as any)?.gateway?.stopAccount;
  assert.equal(typeof startAccount, "function");
  assert.equal(typeof stopAccount, "function");

  const uid = `${Date.now()}-${Math.random()}`;
  const account = accountFixture({
    accountId: `acc-stop-${uid}`,
    enabled: true,
    webhookPath: `/wemp-stop-${uid}`,
  });
  const { ctx, controller } = createStartAccountContext(account);
  const running = startAccount(ctx);

  t.after(async () => {
    controller.abort();
    await running;
    unregisterWempWebhookByAccountId(account.accountId);
  });

  assert.equal(resolveRegisteredWebhook(account.webhookPath)?.accountId, account.accountId);
  await stopAccount(ctx);
  assert.equal(resolveRegisteredWebhook(account.webhookPath), null);
  const status = ctx.getStatus();
  assert.equal(status.running, false);
  assert.equal(status.connected, false);
  assert.equal(status.lastError, "account_stopped");
  await running;
});
