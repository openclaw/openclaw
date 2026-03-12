import assert from "node:assert/strict";
import test from "node:test";
import { wempPlugin } from "../src/channel.js";
import {
  attachOpenClawLogBridge,
  detachOpenClawLogBridge,
  getLogLevel,
  logError,
  logInfo,
  setLogLevel,
} from "../src/log.js";
import type { ResolvedWempAccount } from "../src/types.js";

function accountFixture(accountId: string, webhookPath: string): ResolvedWempAccount {
  return {
    accountId,
    enabled: true,
    configured: true,
    appId: `app-${accountId}`,
    appSecret: `secret-${accountId}`,
    token: `token-${accountId}`,
    webhookPath,
    dm: { policy: "pairing", allowFrom: [] },
    routing: { pairedAgent: "main", unpairedAgent: "wemp-kf" },
    features: {
      menu: { enabled: false, items: [] },
      assistantToggle: { enabled: true, defaultEnabled: true },
      usageLimit: { enabled: false, dailyMessages: 0, dailyTokens: 0, exemptPaired: true },
      handoff: {
        enabled: true,
        contact: "客服微信: abc",
        message: "如需人工支持，请联系：{{contact}}",
      },
      welcome: { enabled: true, subscribeText: "欢迎关注" },
    },
    config: {},
  };
}

function createAccountStartContext(account: ResolvedWempAccount) {
  const controller = new AbortController();
  let status: Record<string, unknown> = {};
  const lines = {
    info: [] as string[],
    warn: [] as string[],
    error: [] as string[],
  };
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
      info: (line: string) => lines.info.push(String(line)),
      warn: (line: string) => lines.warn.push(String(line)),
      error: (line: string) => lines.error.push(String(line)),
    },
  };
  return { ctx, controller, lines };
}

test("structured logs redact sensitive fields", () => {
  const lines: string[] = [];
  const oldLevel = getLogLevel();
  const originalLog = console.log;
  console.log = (line?: unknown) => {
    lines.push(String(line || ""));
  };

  try {
    setLogLevel("info");
    logInfo("sensitive_case", {
      token: "abcdef123456",
      appSecret: "my-app-secret",
      nested: {
        apiKey: "sk-test-1234",
        safe: "visible",
      },
    });
  } finally {
    console.log = originalLog;
    setLogLevel(oldLevel);
  }

  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]) as { data?: Record<string, unknown> };
  const data = (record.data || {}) as Record<string, unknown>;
  assert.equal(data.token, "ab***56");
  assert.equal(data.appSecret, "my***et");
  const nested = (data.nested || {}) as Record<string, unknown>;
  assert.equal(nested.apiKey, "sk***34");
  assert.equal(nested.safe, "visible");
});

test("non-sensitive fields remain unchanged", () => {
  const lines: string[] = [];
  const oldLevel = getLogLevel();
  const originalLog = console.log;
  console.log = (line?: unknown) => {
    lines.push(String(line || ""));
  };

  try {
    setLogLevel("info");
    logInfo("normal_case", {
      accountId: "acc-1",
      webhookPath: "/wemp",
      retries: 2,
    });
  } finally {
    console.log = originalLog;
    setLogLevel(oldLevel);
  }

  const record = JSON.parse(lines[0]) as { data?: Record<string, unknown> };
  const data = (record.data || {}) as Record<string, unknown>;
  assert.equal(data.accountId, "acc-1");
  assert.equal(data.webhookPath, "/wemp");
  assert.equal(data.retries, 2);
});

test("log bridge routes by accountId without changing console json output", () => {
  const consoleLines: string[] = [];
  const bridgeLines: string[] = [];
  const oldLevel = getLogLevel();
  const originalLog = console.log;
  console.log = (line?: unknown) => {
    consoleLines.push(String(line || ""));
  };

  try {
    setLogLevel("info");
    attachOpenClawLogBridge("acc-bridge", {
      info: (line) => bridgeLines.push(line),
    });
    logInfo("webhook_request_in", {
      accountId: "acc-bridge",
      method: "POST",
    });
  } finally {
    detachOpenClawLogBridge("acc-bridge");
    console.log = originalLog;
    setLogLevel(oldLevel);
  }

  assert.equal(consoleLines.length, 1);
  assert.equal(bridgeLines.length, 1);
  assert.equal(bridgeLines[0], consoleLines[0]);
});

test("log bridge supports [wemp:accountId] event prefix when payload has no accountId", () => {
  const consoleLines: string[] = [];
  const bridgeLines: string[] = [];
  const oldLevel = getLogLevel();
  const originalError = console.error;
  console.error = (line?: unknown) => {
    consoleLines.push(String(line || ""));
  };

  try {
    setLogLevel("info");
    attachOpenClawLogBridge("acc-prefixed", {
      error: (line) => bridgeLines.push(line),
    });
    logError("[wemp:acc-prefixed] webhook handler failed", "boom");
  } finally {
    detachOpenClawLogBridge("acc-prefixed");
    console.error = originalError;
    setLogLevel(oldLevel);
  }

  assert.equal(consoleLines.length, 1);
  assert.equal(bridgeLines.length, 1);
  assert.equal(bridgeLines[0], consoleLines[0]);
});

test("startAccount injects and cleans log bridge for concurrent accounts", async () => {
  const originalLog = console.log;
  const oldLevel = getLogLevel();
  const startAccount = (wempPlugin as any)?.gateway?.startAccount;
  assert.equal(typeof startAccount, "function");
  console.log = () => undefined;

  const accountA = accountFixture("acc-bridge-a", "/wemp-bridge-a");
  const accountB = accountFixture("acc-bridge-b", "/wemp-bridge-b");
  const first = createAccountStartContext(accountA);
  const second = createAccountStartContext(accountB);

  try {
    setLogLevel("info");
    const runningA = startAccount(first.ctx);
    const runningB = startAccount(second.ctx);

    const firstBefore = first.lines.info.length;
    const secondBefore = second.lines.info.length;

    logInfo("webhook_request_in", { accountId: accountA.accountId, tag: "first" });
    logInfo("webhook_request_in", { accountId: accountB.accountId, tag: "second" });
    const firstAfterStart = first.lines.info.slice(firstBefore);
    const secondAfterStart = second.lines.info.slice(secondBefore);

    assert.equal(firstAfterStart.length, 1);
    assert.equal(secondAfterStart.length, 1);
    assert.equal((JSON.parse(firstAfterStart[0]) as any)?.data?.accountId, accountA.accountId);
    assert.equal((JSON.parse(secondAfterStart[0]) as any)?.data?.accountId, accountB.accountId);

    first.controller.abort();
    await runningA;

    const firstAfterStop = first.lines.info.length;
    const secondBeforeSecondRound = second.lines.info.length;
    logInfo("webhook_request_in", { accountId: accountA.accountId, tag: "after-stop-a" });
    logInfo("webhook_request_in", { accountId: accountB.accountId, tag: "after-stop-b" });

    assert.equal(first.lines.info.length, firstAfterStop);
    assert.equal(second.lines.info.length, secondBeforeSecondRound + 1);

    second.controller.abort();
    await runningB;

    const secondAfterStop = second.lines.info.length;
    logInfo("webhook_request_in", { accountId: accountB.accountId, tag: "after-stop-all" });
    assert.equal(second.lines.info.length, secondAfterStop);
  } finally {
    first.controller.abort();
    second.controller.abort();
    detachOpenClawLogBridge(accountA.accountId);
    detachOpenClawLogBridge(accountB.accountId);
    console.log = originalLog;
    setLogLevel(oldLevel);
  }
});
