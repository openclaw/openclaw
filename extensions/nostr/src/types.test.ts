import { describe, expect, it } from "vitest";
import { NostrConfigSchema } from "./config-schema.js";
import { listNostrAccountIds, resolveDefaultNostrAccountId, resolveNostrAccount } from "./types.js";

const TEST_PRIVATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
    const cfg = {
      channels: {
        nostr: { privateKey: TEST_PRIVATE_KEY },
      },
    };
    expect(listNostrAccountIds(cfg)).toEqual(["default"]);
  });

  it("returns configured defaultAccount when privateKey is configured", () => {
    const cfg = {
      channels: {
        nostr: { privateKey: TEST_PRIVATE_KEY, defaultAccount: "work" },
      },
    };
    expect(listNostrAccountIds(cfg)).toEqual(["work"]);
  });
});

describe("resolveDefaultNostrAccountId", () => {
  it("returns default when configured", () => {
    const cfg = {
      channels: {
        nostr: { privateKey: TEST_PRIVATE_KEY },
      },
    };
    expect(resolveDefaultNostrAccountId(cfg)).toBe("default");
  });

  it("returns default when not configured", () => {
    const cfg = { channels: {} };
    expect(resolveDefaultNostrAccountId(cfg)).toBe("default");
  });

  it("prefers configured defaultAccount when present", () => {
    const cfg = {
      channels: {
        nostr: { privateKey: TEST_PRIVATE_KEY, defaultAccount: "work" },
      },
    };
    expect(resolveDefaultNostrAccountId(cfg)).toBe("work");
  });
});

describe("resolveNostrAccount", () => {
  it("resolves configured account", () => {
    const cfg = {
      channels: {
        nostr: {
          privateKey: TEST_PRIVATE_KEY,
          name: "Test Bot",
          relays: ["wss://test.relay"],
          dmPolicy: "pairing" as const,
        },
      },
    };
    const account = resolveNostrAccount({ cfg });

    expect(account.accountId).toBe("default");
    expect(account.name).toBe("Test Bot");
    expect(account.enabled).toBe(true);
    expect(account.configured).toBe(true);
    expect(account.privateKey).toBe(TEST_PRIVATE_KEY);
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
    const cfg = {
      channels: {
        nostr: {
          enabled: false,
          privateKey: TEST_PRIVATE_KEY,
        },
      },
    };
    const account = resolveNostrAccount({ cfg });

    expect(account.enabled).toBe(false);
    expect(account.configured).toBe(true);
  });

  it("handles custom accountId parameter", () => {
    const cfg = {
      channels: {
        nostr: { privateKey: TEST_PRIVATE_KEY },
      },
    };
    const account = resolveNostrAccount({ cfg, accountId: "custom" });

    expect(account.accountId).toBe("custom");
  });

  it("handles allowFrom config", () => {
    const cfg = {
      channels: {
        nostr: {
          privateKey: TEST_PRIVATE_KEY,
          allowFrom: ["npub1test", "0123456789abcdef"],
        },
      },
    };
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
    const cfg = {
      channels: {
        nostr: {
          privateKey: TEST_PRIVATE_KEY,
          name: "Bot",
          enabled: true,
          relays: ["wss://relay1", "wss://relay2"],
          dmPolicy: "allowlist" as const,
          allowFrom: ["pubkey1", "pubkey2"],
        },
      },
    };
    const account = resolveNostrAccount({ cfg });

    expect(account.config).toEqual({
      privateKey: TEST_PRIVATE_KEY,
      name: "Bot",
      enabled: true,
      relays: ["wss://relay1", "wss://relay2"],
      dmPolicy: "allowlist",
      allowFrom: ["pubkey1", "pubkey2"],
    });
  });
});

describe("NostrConfigSchema relay URL validation", () => {
  it("accepts wss:// relay URLs", () => {
    const result = NostrConfigSchema.safeParse({
      relays: ["wss://relay.damus.io", "wss://nos.lol"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts ws:// relay URLs", () => {
    const result = NostrConfigSchema.safeParse({
      relays: ["ws://localhost:7777"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects https:// relay URLs", () => {
    const result = NostrConfigSchema.safeParse({
      relays: ["https://relay.damus.io"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects http:// relay URLs", () => {
    const result = NostrConfigSchema.safeParse({
      relays: ["http://evil.com"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects javascript: protocol", () => {
    const result = NostrConfigSchema.safeParse({
      relays: ["javascript:alert(1)"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-URL strings", () => {
    const result = NostrConfigSchema.safeParse({
      relays: ["not-a-url"],
    });
    expect(result.success).toBe(false);
  });
});
