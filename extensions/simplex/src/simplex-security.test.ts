import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  formatSimplexAllowFrom,
  isSimplexAllowlisted,
  parseSimplexAllowlistEntry,
  resolveSimplexAllowFrom,
  resolveSimplexDmPolicy,
} from "./simplex-security.js";
import type { ResolvedSimplexAccount } from "./types.js";

describe("simplex allowlist", () => {
  it("parses wildcard allowlist entries", () => {
    expect(parseSimplexAllowlistEntry("*")).toEqual({ kind: "any", value: "*" });
  });

  it("parses group prefixes", () => {
    expect(parseSimplexAllowlistEntry("group:Team")).toEqual({
      kind: "group",
      value: "team",
    });
    expect(parseSimplexAllowlistEntry("simplex:#MyGroup")).toEqual({
      kind: "group",
      value: "mygroup",
    });
  });

  it("parses sender prefixes", () => {
    expect(parseSimplexAllowlistEntry("@Alice")).toEqual({
      kind: "sender",
      value: "alice",
    });
    expect(parseSimplexAllowlistEntry("contact:Bob")).toEqual({
      kind: "sender",
      value: "bob",
    });
  });

  it("normalizes bare entries as senders", () => {
    expect(parseSimplexAllowlistEntry("Simplex:Carol")).toEqual({
      kind: "sender",
      value: "carol",
    });
  });

  it("ignores empty entries", () => {
    expect(parseSimplexAllowlistEntry("")).toBeNull();
  });

  it("resolves allowlist per-account first", () => {
    const cfg = {
      channels: {
        simplex: {
          allowFrom: ["base"],
          accounts: {
            alpha: {
              allowFrom: ["account"],
            },
          },
        },
      },
    } as OpenClawConfig;
    expect(resolveSimplexAllowFrom({ cfg, accountId: "alpha" })).toEqual(["account"]);
    expect(resolveSimplexAllowFrom({ cfg, accountId: "beta" })).toEqual(["base"]);
  });

  it("formats allowlist entries as normalized lowercase values", () => {
    const formatted = formatSimplexAllowFrom([" simplex:@Alice ", "group:Team "]);
    expect(formatted).toEqual(["@alice", "group:team"]);
  });

  it("resolves dm policy with account override", () => {
    const cfg = {
      channels: {
        simplex: {
          dmPolicy: "allowlist",
          accounts: {
            alpha: {
              dmPolicy: "open",
            },
          },
        },
      },
    } as OpenClawConfig;
    const account: ResolvedSimplexAccount = {
      accountId: "alpha",
      enabled: true,
      configured: true,
      mode: "managed",
      wsUrl: "ws://127.0.0.1:5225",
      wsHost: "127.0.0.1",
      wsPort: 5225,
      cliPath: "simplex-chat",
      config: { dmPolicy: "open" },
    };
    const result = resolveSimplexDmPolicy({
      cfg,
      account,
    });
    expect(result.policy).toBe("open");
  });

  it("matches allowlisted senders and groups", () => {
    expect(
      isSimplexAllowlisted({
        allowFrom: ["*"],
      }),
    ).toBe(true);

    expect(
      isSimplexAllowlisted({
        allowFrom: ["@alice"],
        senderId: "Alice",
      }),
    ).toBe(true);
    expect(
      isSimplexAllowlisted({
        allowFrom: ["12345"],
        senderId: "simplex:@12345",
      }),
    ).toBe(true);

    expect(
      isSimplexAllowlisted({
        allowFrom: ["group:Team"],
        groupId: "team",
        allowGroupId: false,
      }),
    ).toBe(false);

    expect(
      isSimplexAllowlisted({
        allowFrom: ["group:Team"],
        groupId: "TEAM",
        allowGroupId: true,
      }),
    ).toBe(true);
  });
});
