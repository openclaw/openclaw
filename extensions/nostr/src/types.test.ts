import { describe, expect, it } from "vitest";
import { TEST_HEX_PRIVATE_KEY, createConfiguredNostrCfg } from "./test-fixtures.js";
import { listNostrAccountIds, resolveDefaultNostrAccountId, resolveNostrAccount } from "./types.js";

describe("listNostrAccountIds", () => {
  it("returns empty array when not configured", () => {
    const cfg = { channels: {} };
    expect(listNostrAccountIds(cfg)).toEqual([]);
  });

  it("returns empty array when nostr section exists but no privateKey", () => {
    const cfg = { channels: { nostr: { enabled: true } } };
    expect(listNostrAccountIds(cfg)).toEqual([]);
  });

  it("returns default when privateKey is configured", () => {
    const cfg = createConfiguredNostrCfg();
    expect(listNostrAccountIds(cfg)).toEqual(["default"]);
  });

  it("returns configured defaultAccount when privateKey is configured", () => {
    const cfg = createConfiguredNostrCfg({ defaultAccount: "work" });
    expect(listNostrAccountIds(cfg)).toEqual(["work"]);
  });
});

describe("resolveDefaultNostrAccountId", () => {
  it("returns default when configured", () => {
    const cfg = createConfiguredNostrCfg();
    expect(resolveDefaultNostrAccountId(cfg)).toBe("default");
  });

  it("returns default when not configured", () => {
    const cfg = { channels: {} };
    expect(resolveDefaultNostrAccountId(cfg)).toBe("default");
  });

  it("prefers configured defaultAccount when present", () => {
    const cfg = createConfiguredNostrCfg({ defaultAccount: "work" });
    expect(resolveDefaultNostrAccountId(cfg)).toBe("work");
  });
});

describe("resolveNostrAccount", () => {
  it("resolves configured account", () => {
    const cfg = createConfiguredNostrCfg({
      name: "Test Bot",
      relays: ["wss://test.relay"],
      dmPolicy: "pairing" as const,
    });
    const account = resolveNostrAccount({ cfg });

    expect(account.accountId).toBe("default");
    expect(account.name).toBe("Test Bot");
    expect(account.enabled).toBe(true);
    expect(account.configured).toBe(true);
    expect(account.privateKey).toBe(TEST_HEX_PRIVATE_KEY);
    expect(account.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(account.relays).toEqual(["wss://test.relay"]);
  });

  it("resolves unconfigured account with defaults", () => {
    const cfg = { channels: {} };
    const account = resolveNostrAccount({ cfg });

    expect(account.accountId).toBe("default");
    expect(account.enabled).toBe(true);
    expect(account.configured).toBe(false);
    expect(account.privateKey).toBe("");
    expect(account.publicKey).toBe("");
    expect(account.relays).toContain("wss://relay.damus.io");
    expect(account.relays).toContain("wss://nos.lol");
  });

  it("handles disabled channel", () => {
    const cfg = createConfiguredNostrCfg({ enabled: false });
    const account = resolveNostrAccount({ cfg });

    expect(account.enabled).toBe(false);
    expect(account.configured).toBe(true);
  });

  it("handles custom accountId parameter", () => {
    const cfg = createConfiguredNostrCfg();
    const account = resolveNostrAccount({ cfg, accountId: "custom" });

    expect(account.accountId).toBe("custom");
  });

  it("handles allowFrom config", () => {
    const cfg = createConfiguredNostrCfg({
      allowFrom: ["npub1test", "0123456789abcdef"],
    });
    const account = resolveNostrAccount({ cfg });

    expect(account.config.allowFrom).toEqual(["npub1test", "0123456789abcdef"]);
  });

  it("handles invalid private key gracefully", () => {
    const cfg = {
      channels: {
        nostr: {
          privateKey: "invalid-key",
        },
      },
    };
    const account = resolveNostrAccount({ cfg });

    expect(account.configured).toBe(true); // key is present
    expect(account.publicKey).toBe(""); // but can't derive pubkey
  });

  it("preserves all config options", () => {
    const cfg = createConfiguredNostrCfg({
      name: "Bot",
      enabled: true,
      relays: ["wss://relay1", "wss://relay2"],
      dmPolicy: "allowlist" as const,
      allowFrom: ["pubkey1", "pubkey2"],
    });
    const account = resolveNostrAccount({ cfg });

    expect(account.config).toEqual({
      privateKey: TEST_HEX_PRIVATE_KEY,
      name: "Bot",
      enabled: true,
      relays: ["wss://relay1", "wss://relay2"],
      dmPolicy: "allowlist",
      allowFrom: ["pubkey1", "pubkey2"],
    });
  });
});
