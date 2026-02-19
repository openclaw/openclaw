import { describe, expect, it } from "vitest";
import { listNostrAccountIds, resolveDefaultNostrAccountId, resolveNostrAccount } from "./types.js";

const TEST_PRIVATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ALT_PRIVATE_KEY = "1111111111111111111111111111111111111111111111111111111111111111";

describe("listNostrAccountIds", () => {
  it("returns empty array when not configured", () => {
    const cfg = { channels: {} };
    expect(listNostrAccountIds(cfg)).toEqual([]);
  });

  it("returns empty array when nostr section exists but no privateKey", () => {
    const cfg = { channels: { nostr: { enabled: true } } };
    expect(listNostrAccountIds(cfg)).toEqual([]);
  });

  it("returns empty array for invalid private key", () => {
    const cfg = { channels: { nostr: { privateKey: "invalid-key" } } };
    expect(listNostrAccountIds(cfg as any)).toEqual([]);
  });

  it("returns default when privateKey is configured", () => {
    const cfg = {
      channels: {
        nostr: { privateKey: TEST_PRIVATE_KEY },
      },
    };
    expect(listNostrAccountIds(cfg)).toEqual(["default"]);
  });

  it("returns normalized account ids for valid configured personas", () => {
    const cfg = {
      channels: {
        nostr: {
          privateKey: TEST_PRIVATE_KEY,
          accounts: {
            "Haunk 2": { privateKey: ALT_PRIVATE_KEY },
            broken: { privateKey: "invalid" },
          },
        },
      },
    };
    expect(listNostrAccountIds(cfg)).toEqual(["default", "haunk-2"]);
  });

  it("supports default account configured only inside accounts map", () => {
    const cfg = {
      channels: {
        nostr: {
          accounts: {
            default: { privateKey: TEST_PRIVATE_KEY },
          },
        },
      },
    };
    expect(listNostrAccountIds(cfg)).toEqual(["default"]);
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

  it("uses configured defaultAccount when it is available", () => {
    const cfg = {
      channels: {
        nostr: {
          defaultAccount: "haunk",
          accounts: {
            haunk: { privateKey: TEST_PRIVATE_KEY },
            helper: { privateKey: ALT_PRIVATE_KEY },
          },
        },
      },
    };
    expect(resolveDefaultNostrAccountId(cfg)).toBe("haunk");
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

  it("resolves account-specific config from channels.nostr.accounts", () => {
    const cfg = {
      channels: {
        nostr: {
          privateKey: TEST_PRIVATE_KEY,
          relays: ["wss://relay.base"],
          allowFrom: ["base"],
          accounts: {
            haunk: {
              privateKey: ALT_PRIVATE_KEY,
              name: "Haunk",
              relays: ["wss://relay.haunk"],
              allowFrom: ["haunk"],
            },
          },
        },
      },
    };
    const account = resolveNostrAccount({ cfg, accountId: "HAUNK" });

    expect(account.accountId).toBe("haunk");
    expect(account.privateKey).toBe(ALT_PRIVATE_KEY);
    expect(account.name).toBe("Haunk");
    expect(account.relays).toEqual(["wss://relay.haunk"]);
    expect(account.config.allowFrom).toEqual(["haunk"]);
    expect(account.configured).toBe(true);
  });

  it("merges channels.nostr base config into account-specific config", () => {
    const cfg = {
      channels: {
        nostr: {
          privateKey: TEST_PRIVATE_KEY,
          dmPolicy: "allowlist" as const,
          relays: ["wss://relay.base"],
          accounts: {
            helper: {
              privateKey: ALT_PRIVATE_KEY,
            },
          },
        },
      },
    };
    const account = resolveNostrAccount({ cfg, accountId: "helper" });

    expect(account.config.dmPolicy).toBe("allowlist");
    expect(account.relays).toEqual(["wss://relay.base"]);
  });

  it("applies channel enabled + account enabled together", () => {
    const cfg = {
      channels: {
        nostr: {
          enabled: true,
          privateKey: TEST_PRIVATE_KEY,
          accounts: {
            helper: {
              privateKey: ALT_PRIVATE_KEY,
              enabled: false,
            },
          },
        },
      },
    };
    const account = resolveNostrAccount({ cfg, accountId: "helper" });

    expect(account.enabled).toBe(false);
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

    expect(account.configured).toBe(false);
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
