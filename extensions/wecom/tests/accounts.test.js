/**
 * Tests for multi-account resolution (wecom/accounts.js)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  listAccountIds,
  resolveAccount,
  detectAccountConflicts,
  findAccountByToken,
  resolveAllAccounts,
} from "../wecom/accounts.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function legacyCfg(overrides = {}) {
  return {
    channels: {
      wecom: {
        token: "legacy-token",
        encodingAesKey: "aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsb3dvcmxkYWI",
        ...overrides,
      },
    },
  };
}

function multiCfg(accounts = {}) {
  return { channels: { wecom: accounts } };
}

// ── listAccountIds ────────────────────────────────────────────────────────────

describe("listAccountIds — legacy single-account config", () => {
  it('returns ["default"] for a legacy config with top-level token', () => {
    const ids = listAccountIds(legacyCfg());
    assert.deepEqual(ids, ["default"]);
  });

  it("returns [] when wecom is disabled (enabled: false)", () => {
    const ids = listAccountIds(legacyCfg({ enabled: false }));
    assert.deepEqual(ids, []);
  });

  it("returns [] when channels.wecom is absent", () => {
    assert.deepEqual(listAccountIds({}), []);
    assert.deepEqual(listAccountIds(null), []);
    assert.deepEqual(listAccountIds({ channels: {} }), []);
  });
});

describe("listAccountIds — dictionary multi-account config", () => {
  it("returns account keys that are objects (not reserved keys)", () => {
    const cfg = multiCfg({
      bot1: { token: "t1", encodingAesKey: "k1" },
      bot2: { token: "t2", encodingAesKey: "k2" },
    });
    const ids = listAccountIds(cfg);
    assert.deepEqual(ids.sort(), ["bot1", "bot2"]);
  });

  it("excludes RESERVED_KEYS from account IDs", () => {
    const cfg = multiCfg({
      // NOTE: do NOT add "token" here — that would trigger isLegacyConfig().
      // Instead use other RESERVED_KEYS to verify they are excluded.
      enabled: true, // reserved — should be ignored as an account id
      webhookPath: "/custom", // reserved — should be ignored
      bot1: { token: "t1" },
    });
    const ids = listAccountIds(cfg);
    assert.deepEqual(ids, ["bot1"]);
  });

  it("normalises account keys to lowercase with underscores", () => {
    const cfg = multiCfg({
      "My Bot": { token: "t1" },
    });
    const ids = listAccountIds(cfg);
    assert.deepEqual(ids, ["my_bot"]);
  });

  it("skips keys whose value is not a plain object (e.g. scalar/array)", () => {
    const cfg = multiCfg({
      notAnAccount: "some-string",
      alsoNot: [1, 2, 3],
      realBot: { token: "t1" },
    });
    const ids = listAccountIds(cfg);
    assert.deepEqual(ids, ["realbot"]);
  });
});

describe("listAccountIds — instances[] array config", () => {
  it("extracts account IDs from instances array entries by name", () => {
    const cfg = multiCfg({
      instances: [
        { name: "BotA", token: "ta" },
        { name: "BotB", token: "tb" },
      ],
    });
    const ids = listAccountIds(cfg);
    assert.deepEqual(ids.sort(), ["bota", "botb"]);
  });

  it("ignores entries without a name field", () => {
    const cfg = multiCfg({
      instances: [{ token: "no-name" }, { name: "valid-bot", token: "t1" }],
    });
    const ids = listAccountIds(cfg);
    assert.deepEqual(ids, ["valid-bot"]);
  });

  it("deduplicates normalised instance names", () => {
    const cfg = multiCfg({
      instances: [
        { name: "Bot A", token: "t1" },
        { name: "bot_a", token: "t2" }, // normalises to same id
      ],
    });
    const ids = listAccountIds(cfg);
    assert.equal(ids.length, 1);
  });
});

// ── resolveAccount ────────────────────────────────────────────────────────────

describe("resolveAccount — legacy config", () => {
  it('resolves "default" to the top-level wecom block', () => {
    const cfg = legacyCfg();
    const account = resolveAccount(cfg, "default");
    assert.equal(account.accountId, "default");
    assert.equal(account.token, "legacy-token");
  });

  it("returns enabled:false for unknown accountId in legacy config", () => {
    const account = resolveAccount(legacyCfg(), "other");
    assert.equal(account.enabled, false);
  });

  it("returns null when channels.wecom is absent", () => {
    assert.equal(resolveAccount({}, "default"), null);
  });
});

describe("resolveAccount — dictionary config", () => {
  it("resolves a named account with correct fields", () => {
    const cfg = multiCfg({
      bot1: {
        token: "tok-bot1",
        encodingAesKey: "aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsb3dvcmxkYWI",
      },
    });
    const account = resolveAccount(cfg, "bot1");
    assert.equal(account.accountId, "bot1");
    assert.equal(account.token, "tok-bot1");
    assert.equal(account.configured, true);
  });

  it("resolveAccount sets webhookPath to /webhooks/wecom for default account", () => {
    const account = resolveAccount(legacyCfg(), "default");
    assert.equal(account.webhookPath, "/webhooks/wecom");
  });

  it("resolveAccount sets namespaced webhookPath for non-default accounts", () => {
    const cfg = multiCfg({ bot1: { token: "t" } });
    const account = resolveAccount(cfg, "bot1");
    assert.equal(account.webhookPath, "/webhooks/wecom/bot1");
  });

  it("returns enabled:false for missing account in dictionary config", () => {
    const cfg = multiCfg({ bot1: { token: "t" } });
    const account = resolveAccount(cfg, "nonexistent");
    assert.equal(account.enabled, false);
  });

  it("detects agentConfigured when all three agent fields are present", () => {
    const cfg = multiCfg({
      bot1: {
        token: "t",
        agent: { corpId: "ww123", corpSecret: "sec", agentId: 1000001 },
      },
    });
    const account = resolveAccount(cfg, "bot1");
    assert.equal(account.agentConfigured, true);
    assert.ok(account.agentCredentials);
    assert.equal(account.agentCredentials.corpId, "ww123");
  });

  it("configured is false when neither token/key nor agent fields are set", () => {
    const cfg = multiCfg({ emptybot: {} });
    const account = resolveAccount(cfg, "emptybot");
    assert.equal(account.configured, false);
  });
});

describe("resolveAccount — instances[] config", () => {
  it("resolves an account from the instances array by name", () => {
    const cfg = multiCfg({
      instances: [{ name: "BotX", token: "tx", encodingAesKey: "k" }],
    });
    const account = resolveAccount(cfg, "botx");
    assert.equal(account.accountId, "botx");
    assert.equal(account.token, "tx");
  });

  it("merges top-level defaults into instances entries", () => {
    const cfg = multiCfg({
      dm: { enabled: true },
      instances: [{ name: "BotY", token: "ty" }],
    });
    const account = resolveAccount(cfg, "boty");
    assert.deepEqual(account.config.dm, { enabled: true });
  });
});

// ── detectAccountConflicts ────────────────────────────────────────────────────

describe("detectAccountConflicts", () => {
  it("returns empty array when there are no conflicts", () => {
    const cfg = multiCfg({
      bot1: { token: "unique-token-1" },
      bot2: { token: "unique-token-2" },
    });
    assert.deepEqual(detectAccountConflicts(cfg), []);
  });

  it("detects duplicate bot tokens", () => {
    const cfg = multiCfg({
      bot1: { token: "SAME-TOKEN" },
      bot2: { token: "same-token" }, // same after lowercase
    });
    const conflicts = detectAccountConflicts(cfg);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].type, "duplicate_token");
  });

  it("detects duplicate agent corpId+agentId pairs", () => {
    const cfg = multiCfg({
      bot1: {
        token: "t1",
        agent: { corpId: "wwSAME", corpSecret: "s1", agentId: 1000001 },
      },
      bot2: {
        token: "t2",
        agent: { corpId: "wwSAME", corpSecret: "s2", agentId: 1000001 },
      },
    });
    const conflicts = detectAccountConflicts(cfg);
    const agentConflicts = conflicts.filter(
      (c) => c.type === "duplicate_agent",
    );
    assert.equal(agentConflicts.length, 1);
  });

  it("ignores disabled accounts when detecting conflicts", () => {
    const cfg = multiCfg({
      bot1: { token: "SAME", enabled: true },
      bot2: { token: "same", enabled: false },
    });
    const conflicts = detectAccountConflicts(cfg);
    assert.deepEqual(conflicts, []);
  });
});

// ── findAccountByToken ────────────────────────────────────────────────────────

describe("findAccountByToken", () => {
  it("finds an account by its bot token (case-insensitive)", () => {
    const cfg = multiCfg({
      bot1: { token: "MyToken" },
      bot2: { token: "OtherToken" },
    });
    assert.equal(findAccountByToken(cfg, "mytoken"), "bot1");
    assert.equal(findAccountByToken(cfg, "MYTOKEN"), "bot1");
  });

  it("returns null when no account has the given token", () => {
    const cfg = multiCfg({ bot1: { token: "tok" } });
    assert.equal(findAccountByToken(cfg, "unknown"), null);
  });

  it("returns null when token is falsy", () => {
    const cfg = multiCfg({ bot1: { token: "tok" } });
    assert.equal(findAccountByToken(cfg, ""), null);
    assert.equal(findAccountByToken(cfg, null), null);
  });
});
