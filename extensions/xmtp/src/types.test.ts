import { describe, expect, it } from "vitest";
import { listXmtpAccountIds, resolveDefaultXmtpAccountId, resolveXmtpAccount } from "./types.js";

const TEST_WALLET_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_DB_KEY = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";

describe("listXmtpAccountIds", () => {
  it("returns empty array when not configured", () => {
    const cfg = { channels: {} };
    expect(listXmtpAccountIds(cfg)).toEqual([]);
  });

  it("returns default when wallet key exists", () => {
    const cfg = {
      channels: {
        xmtp: {
          walletKey: TEST_WALLET_KEY,
        },
      },
    };
    expect(listXmtpAccountIds(cfg)).toEqual(["default"]);
  });
});

describe("resolveDefaultXmtpAccountId", () => {
  it("returns default when configured", () => {
    const cfg = {
      channels: {
        xmtp: {
          walletKey: TEST_WALLET_KEY,
        },
      },
    };
    expect(resolveDefaultXmtpAccountId(cfg)).toBe("default");
  });

  it("returns default when unconfigured", () => {
    const cfg = { channels: {} };
    expect(resolveDefaultXmtpAccountId(cfg)).toBe("default");
  });
});

describe("resolveXmtpAccount", () => {
  it("resolves configured account and derives address", () => {
    const cfg = {
      channels: {
        xmtp: {
          name: "XMTP Bot",
          enabled: true,
          walletKey: TEST_WALLET_KEY,
          dbEncryptionKey: TEST_DB_KEY,
          env: "dev" as const,
          dbPath: "/tmp/xmtp",
          dmPolicy: "pairing" as const,
          allowFrom: ["0x1234567890abcdef1234567890abcdef12345678"],
        },
      },
    };

    const account = resolveXmtpAccount({ cfg });

    expect(account.accountId).toBe("default");
    expect(account.name).toBe("XMTP Bot");
    expect(account.enabled).toBe(true);
    expect(account.configured).toBe(true);
    expect(account.walletKey).toBe(TEST_WALLET_KEY);
    expect(account.walletKeySource).toBe("config");
    expect(account.dbEncryptionKey).toBe(TEST_DB_KEY);
    expect(account.dbEncryptionKeySource).toBe("config");
    expect(account.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(account.env).toBe("dev");
    expect(account.config).toEqual({
      name: "XMTP Bot",
      enabled: true,
      walletKey: TEST_WALLET_KEY,
      walletKeyFile: undefined,
      dbEncryptionKey: TEST_DB_KEY,
      dbEncryptionKeyFile: undefined,
      env: "dev",
      dbPath: "/tmp/xmtp",
      dmPolicy: "pairing",
      allowFrom: ["0x1234567890abcdef1234567890abcdef12345678"],
    });
  });

  it("resolves unconfigured account with defaults", () => {
    const cfg = { channels: {} };
    const account = resolveXmtpAccount({ cfg });

    expect(account.accountId).toBe("default");
    expect(account.enabled).toBe(true);
    expect(account.configured).toBe(false);
    expect(account.walletKey).toBe("");
    expect(account.walletKeySource).toBe("none");
    expect(account.dbEncryptionKey).toBe("");
    expect(account.dbEncryptionKeySource).toBe("none");
    expect(account.address).toBe("");
    expect(account.env).toBe("production");
  });

  it("handles disabled channel", () => {
    const cfg = {
      channels: {
        xmtp: {
          enabled: false,
          walletKey: TEST_WALLET_KEY,
          dbEncryptionKey: TEST_DB_KEY,
        },
      },
    };

    const account = resolveXmtpAccount({ cfg });
    expect(account.enabled).toBe(false);
    expect(account.configured).toBe(true);
    expect(account.walletKeySource).toBe("config");
    expect(account.dbEncryptionKeySource).toBe("config");
  });

  it("uses provided accountId", () => {
    const cfg = {
      channels: {
        xmtp: {
          walletKey: TEST_WALLET_KEY,
          dbEncryptionKey: TEST_DB_KEY,
        },
      },
    };

    const account = resolveXmtpAccount({ cfg, accountId: "custom" });
    expect(account.accountId).toBe("custom");
  });

  it("handles invalid wallet key gracefully", () => {
    const cfg = {
      channels: {
        xmtp: {
          walletKey: "not-a-private-key",
          dbEncryptionKey: TEST_DB_KEY,
        },
      },
    };

    const account = resolveXmtpAccount({ cfg });
    expect(account.configured).toBe(true);
    expect(account.address).toBe("");
    expect(account.walletKeySource).toBe("config");
    expect(account.dbEncryptionKeySource).toBe("config");
  });
});
