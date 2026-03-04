/**
 * DingTalk accounts: listAccountIds, resolveAccount.
 */

import { describe, expect, it } from "vitest";
import { listAccountIds, resolveAccount } from "./accounts.js";

describe("listAccountIds", () => {
  it("returns empty when no channel config", () => {
    expect(listAccountIds({})).toEqual([]);
    expect(listAccountIds({ channels: {} })).toEqual([]);
  });

  it("returns default when base appKey or appSecret", () => {
    expect(listAccountIds({ channels: { dingtalk: { appKey: "k" } } })).toEqual(["default"]);
    expect(listAccountIds({ channels: { dingtalk: { appSecret: "s" } } })).toEqual(["default"]);
  });

  it("returns account keys from accounts", () => {
    expect(
      listAccountIds({
        channels: {
          dingtalk: {
            accounts: {
              a: { appKey: "k1" },
              b: { appKey: "k2" },
            },
          },
        },
      }),
    ).toEqual(["a", "b"]);
  });
});

describe("resolveAccount", () => {
  it("returns default account with defaults", () => {
    const account = resolveAccount({ channels: { dingtalk: { enabled: true } } });
    expect(account.accountId).toBe("default");
    expect(account.enabled).toBe(true);
    expect(account.webhookPath).toBe("/webhook/dingtalk");
    expect(account.rateLimitPerMinute).toBe(30);
    expect(account.dmPolicy).toBe("allowlist");
    expect(account.allowFrom).toEqual([]);
  });

  it("merges account overrides", () => {
    const account = resolveAccount(
      {
        channels: {
          dingtalk: {
            webhookPath: "/dt",
            accounts: { my: { webhookPath: "/dt-my", enabled: false } },
          },
        },
      },
      "my",
    );
    expect(account.accountId).toBe("my");
    expect(account.webhookPath).toBe("/dt-my");
    expect(account.enabled).toBe(false);
  });
});
