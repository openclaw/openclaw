import assert from "node:assert/strict";
import test from "node:test";
import { wempPlugin } from "../src/channel.js";
import type { ResolvedWempAccount, WempMenuItem } from "../src/types.js";

interface MenuCreatePayload {
  button?: Array<Record<string, string>>;
}

function buildMenuAccount(accountId: string, items: WempMenuItem[]): ResolvedWempAccount {
  return {
    accountId,
    enabled: true,
    configured: true,
    appId: `app-${accountId}`,
    appSecret: `secret-${accountId}`,
    token: `token-${accountId}`,
    webhookPath: `/wemp-${accountId}`,
    dm: { policy: "pairing", allowFrom: [] },
    routing: { pairedAgent: "main", unpairedAgent: "wemp-kf" },
    features: {
      menu: { enabled: true, items },
      assistantToggle: { enabled: false, defaultEnabled: false },
      usageLimit: { enabled: false, dailyMessages: 0, dailyTokens: 0, exemptPaired: true },
      handoff: { enabled: false, contact: "", message: "" },
      welcome: { enabled: false, subscribeText: "" },
    },
    config: {},
  };
}

function createAccountStartContext(account: ResolvedWempAccount): {
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

function toUrlString(url: string | URL | Request): string {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.toString();
  return url.url;
}

function parseMenuCreatePayload(init?: RequestInit): MenuCreatePayload {
  if (typeof init?.body !== "string") return {};
  try {
    return JSON.parse(init.body) as MenuCreatePayload;
  } catch {
    return {};
  }
}

function toExpectedButtons(items: WempMenuItem[]): Array<Record<string, string>> {
  return items.map((item) => {
    const next: Record<string, string> = {
      type: item.type,
      name: item.name,
    };
    if (item.key) next.key = item.key;
    if (item.url) next.url = item.url;
    return next;
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 1500): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (check()) return;
    await delay(10);
  }
  assert.fail(`timeout waiting for ${label}`);
}

function sampleMenuA(): WempMenuItem[] {
  return [
    { type: "click", name: "AI 学堂", key: "menu_ai_class" },
    { type: "view", name: "产品服务", url: "https://example.com/service" },
  ];
}

function sampleMenuB(): WempMenuItem[] {
  return [
    { type: "click", name: "AI 入门", key: "menu_ai_intro" },
    { type: "view", name: "官网", url: "https://example.com/home" },
  ];
}

test("menu sync: first start performs initial menu sync successfully", async () => {
  const startAccount = (wempPlugin as any)?.gateway?.startAccount;
  assert.equal(typeof startAccount, "function");

  const accountId = `menu-first-${Date.now()}-${Math.random()}`;
  const account = buildMenuAccount(accountId, sampleMenuA());
  const createPayloads: MenuCreatePayload[] = [];
  const originalFetch = globalThis.fetch;
  const { ctx, controller } = createAccountStartContext(account);
  let running: Promise<void> | null = null;

  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlValue = toUrlString(url);
      if (urlValue.includes("/cgi-bin/token")) {
        return new Response(
          JSON.stringify({
            access_token: `token-${accountId}`,
            expires_in: 7200,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlValue.includes("/cgi-bin/menu/create")) {
        createPayloads.push(parseMenuCreatePayload(init));
        return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected url: ${urlValue}`);
    }) as typeof fetch;

    running = startAccount(ctx);
    await waitFor(() => createPayloads.length >= 1, "first menu sync request");
    assert.deepEqual(createPayloads[0].button, toExpectedButtons(sampleMenuA()));
  } finally {
    controller.abort();
    if (running) await running;
    globalThis.fetch = originalFetch;
  }
});

test("menu sync: config changes trigger another sync with new menu payload", async () => {
  const startAccount = (wempPlugin as any)?.gateway?.startAccount;
  assert.equal(typeof startAccount, "function");

  const accountId = `menu-change-${Date.now()}-${Math.random()}`;
  const menuA = sampleMenuA();
  const menuB = sampleMenuB();
  const createPayloads: MenuCreatePayload[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlValue = toUrlString(url);
    if (urlValue.includes("/cgi-bin/token")) {
      return new Response(
        JSON.stringify({
          access_token: `token-${accountId}`,
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (urlValue.includes("/cgi-bin/menu/create")) {
      createPayloads.push(parseMenuCreatePayload(init));
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected url: ${urlValue}`);
  }) as typeof fetch;

  try {
    const first = createAccountStartContext(buildMenuAccount(accountId, menuA));
    const runningFirst = startAccount(first.ctx);
    await waitFor(() => createPayloads.length >= 1, "first config sync");
    assert.deepEqual(createPayloads[0].button, toExpectedButtons(menuA));
    first.controller.abort();
    await runningFirst;

    const second = createAccountStartContext(buildMenuAccount(accountId, menuB));
    const runningSecond = startAccount(second.ctx);
    await waitFor(() => createPayloads.length >= 2, "second config sync");
    assert.deepEqual(createPayloads[1].button, toExpectedButtons(menuB));
    second.controller.abort();
    await runningSecond;
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("menu sync: if changed menu sync fails, it rolls back to last successful menu", async () => {
  const startAccount = (wempPlugin as any)?.gateway?.startAccount;
  assert.equal(typeof startAccount, "function");

  const accountId = `menu-rollback-${Date.now()}-${Math.random()}`;
  const stableMenu = sampleMenuA();
  const changedMenu = sampleMenuB();
  const createPayloads: MenuCreatePayload[] = [];
  let createCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlValue = toUrlString(url);
    if (urlValue.includes("/cgi-bin/token")) {
      return new Response(
        JSON.stringify({
          access_token: `token-${accountId}`,
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (urlValue.includes("/cgi-bin/menu/create")) {
      createCalls += 1;
      createPayloads.push(parseMenuCreatePayload(init));
      if (createCalls === 2) {
        return new Response(
          JSON.stringify({ errcode: 40018, errmsg: "invalid button name size" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected url: ${urlValue}`);
  }) as typeof fetch;

  try {
    const first = createAccountStartContext(buildMenuAccount(accountId, stableMenu));
    const runningFirst = startAccount(first.ctx);
    await waitFor(() => createPayloads.length >= 1, "stable menu sync");
    first.controller.abort();
    await runningFirst;

    const second = createAccountStartContext(buildMenuAccount(accountId, changedMenu));
    const runningSecond = startAccount(second.ctx);
    await waitFor(() => createPayloads.length >= 3, "rollback menu sync");

    const expectedStable = JSON.stringify(toExpectedButtons(stableMenu));
    const expectedChanged = JSON.stringify(toExpectedButtons(changedMenu));
    assert.equal(JSON.stringify(createPayloads[1].button), expectedChanged);
    const rollbackFound = createPayloads
      .slice(2)
      .some((payload) => JSON.stringify(payload.button) === expectedStable);
    assert.equal(rollbackFound, true);

    second.controller.abort();
    await runningSecond;
  } finally {
    globalThis.fetch = originalFetch;
  }
});
