// Signal tests cover config schema plugin behavior.
import { describe, expect, it } from "vitest";
import { SignalConfigSchema } from "../config-api.js";
import { signalConfigAdapter } from "./shared.js";

function expectValidSignalConfig(config: unknown) {
  const res = SignalConfigSchema.safeParse(config);
  expect(res.success).toBe(true);
}

function expectInvalidSignalConfig(config: unknown) {
  const res = SignalConfigSchema.safeParse(config);
  expect(res.success).toBe(false);
  if (res.success) {
    throw new Error("expected Signal config to be invalid");
  }
  return res.error.issues;
}

describe("signal groups schema", () => {
  it("clears note-to-self root account fields when deleting the default account", () => {
    const updated = signalConfigAdapter.deleteAccount?.({
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            accountUuid: "123e4567-e89b-12d3-a456-426614174000",
            ingressMode: "note-to-self",
            httpUrl: "http://signal.test",
          },
        },
      },
      accountId: "default",
    });

    expect(updated?.channels?.signal).toBeUndefined();
  });

  it("materializes note-to-self root defaults when deleting the default account with named accounts", () => {
    const updated = signalConfigAdapter.deleteAccount?.({
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            accountUuid: "123e4567-e89b-12d3-a456-426614174000",
            ingressMode: "note-to-self",
            accounts: {
              work: {
                account: "+15555550123",
              },
            },
          },
        },
      },
      accountId: "default",
    });

    expect(updated?.channels?.signal).toMatchObject({
      accounts: {
        work: {
          account: "+15555550123",
          accountUuid: "123e4567-e89b-12d3-a456-426614174000",
          ingressMode: "note-to-self",
        },
      },
    });
    expect(updated?.channels?.signal?.account).toBeUndefined();
    expect(updated?.channels?.signal?.accountUuid).toBeUndefined();
    expect(updated?.channels?.signal?.ingressMode).toBeUndefined();
  });

  it("materializes inherited note-to-self account numbers when deleting the default account", () => {
    const updated = signalConfigAdapter.deleteAccount?.({
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            accountUuid: "123e4567-e89b-12d3-a456-426614174000",
            configPath: "/tmp/signal-cli",
            ingressMode: "note-to-self",
            accounts: {
              work: {},
            },
          },
        },
      },
      accountId: "default",
    });

    expect(updated?.channels?.signal).toMatchObject({
      accounts: {
        work: {
          account: "+15555550123",
          accountUuid: "123e4567-e89b-12d3-a456-426614174000",
          configPath: "/tmp/signal-cli",
          ingressMode: "note-to-self",
        },
      },
    });
    expect(updated?.channels?.signal?.account).toBeUndefined();
    expect(updated?.channels?.signal?.accountUuid).toBeUndefined();
    expect(updated?.channels?.signal?.ingressMode).toBeUndefined();
    expectValidSignalConfig(updated?.channels?.signal);
  });

  it("materializes inherited note-to-self transport fields for explicit named accounts", () => {
    const updated = signalConfigAdapter.deleteAccount?.({
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            accountUuid: "123e4567-e89b-12d3-a456-426614174000",
            configPath: "/tmp/signal-cli",
            httpUrl: "http://signal.test",
            ingressMode: "note-to-self",
            accounts: {
              work: {
                account: "+15555550123",
              },
            },
          },
        },
      },
      accountId: "default",
    });

    expect(updated?.channels?.signal).toMatchObject({
      accounts: {
        work: {
          account: "+15555550123",
          accountUuid: "123e4567-e89b-12d3-a456-426614174000",
          configPath: "/tmp/signal-cli",
          httpUrl: "http://signal.test",
          ingressMode: "note-to-self",
        },
      },
    });
    expect(updated?.channels?.signal?.account).toBeUndefined();
    expect(updated?.channels?.signal?.accountUuid).toBeUndefined();
    expect(updated?.channels?.signal?.configPath).toBeUndefined();
    expect(updated?.channels?.signal?.ingressMode).toBeUndefined();
    expectValidSignalConfig(updated?.channels?.signal);
  });

  it("does not copy the default UUID onto explicit accounts with a different number", () => {
    const updated = signalConfigAdapter.deleteAccount?.({
      cfg: {
        channels: {
          signal: {
            account: "+15555550123",
            accountUuid: "123e4567-e89b-12d3-a456-426614174000",
            configPath: "/tmp/signal-cli",
            ingressMode: "note-to-self",
            accounts: {
              work: {
                account: "+15555550999",
              },
            },
          },
        },
      },
      accountId: "default",
    });

    expect(updated?.channels?.signal?.accounts?.work).toMatchObject({
      account: "+15555550999",
      configPath: "/tmp/signal-cli",
      ingressMode: "note-to-self",
    });
    expect(updated?.channels?.signal?.accounts?.work?.accountUuid).toBeUndefined();
  });

  it('rejects dmPolicy="open" without allowFrom "*"', () => {
    const issues = expectInvalidSignalConfig({
      dmPolicy: "open",
      allowFrom: ["+15555550123"],
    });

    expect(issues[0]?.path.join(".")).toBe("allowFrom");
  });

  it('accepts dmPolicy="open" with allowFrom "*"', () => {
    const res = SignalConfigSchema.safeParse({ dmPolicy: "open", allowFrom: ["*"] });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.dmPolicy).toBe("open");
    }
  });

  it("defaults dm/group policy", () => {
    const res = SignalConfigSchema.safeParse({});

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.dmPolicy).toBe("pairing");
      expect(res.data.groupPolicy).toBe("allowlist");
    }
  });

  it("accepts historyLimit", () => {
    const res = SignalConfigSchema.safeParse({ historyLimit: 6 });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.historyLimit).toBe(6);
    }
  });

  it("accepts textChunkLimit", () => {
    const res = SignalConfigSchema.safeParse({
      enabled: true,
      textChunkLimit: 2222,
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.textChunkLimit).toBe(2222);
    }
  });

  it("accepts accountUuid for loop protection", () => {
    expectValidSignalConfig({
      accountUuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
    const compact = SignalConfigSchema.safeParse({
      accountUuid: "a1b2c3d4e5f67890abcdef1234567890",
    });

    expect(compact.success).toBe(true);
    if (compact.success) {
      expect(compact.data.accountUuid).toBe("a1b2c3d4e5f67890abcdef1234567890");
    }
  });

  it("rejects non-canonical accountUuid values", () => {
    expectInvalidSignalConfig({ accountUuid: "uuid:a1b2c3d4-e5f6-7890-abcd-ef1234567890" });
    expectInvalidSignalConfig({ accountUuid: " a1b2c3d4-e5f6-7890-abcd-ef1234567890 " });
  });

  it("accepts note-to-self ingress mode", () => {
    expectValidSignalConfig({
      ingressMode: "note-to-self",
      account: "+15550001111",
    });
  });

  it("rejects note-to-self ingress mode without a self identifier", () => {
    const issues = expectInvalidSignalConfig({
      ingressMode: "note-to-self",
    });

    expect(issues[0]?.path.join(".")).toBe("ingressMode");

    const emptyAccountsIssues = expectInvalidSignalConfig({
      ingressMode: "note-to-self",
      accounts: {},
    });
    expect(emptyAccountsIssues[0]?.path.join(".")).toBe("ingressMode");

    const blankIssues = expectInvalidSignalConfig({
      ingressMode: "note-to-self",
      account: "   ",
    });
    expect(blankIssues[0]?.path.join(".")).toBe("ingressMode");
  });

  it("accepts note-to-self accounts that inherit the root transport account", () => {
    expectValidSignalConfig({
      account: "+15550001111",
      accountUuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      accounts: {
        work: {
          ingressMode: "note-to-self",
        },
      },
    });
  });

  it("accepts note-to-self accounts with an explicit account", () => {
    expectValidSignalConfig({
      ingressMode: "note-to-self",
      accounts: {
        work: {
          account: "+15550001111",
        },
      },
    });
  });

  it("accepts channel apiMode", () => {
    for (const apiMode of ["auto", "native", "container"]) {
      expectValidSignalConfig({ apiMode });
    }
  });

  it("rejects per-account apiMode", () => {
    const issues = expectInvalidSignalConfig({
      accounts: {
        primary: {
          apiMode: "container",
        },
      },
    });

    expect(issues.map((issue) => issue.path.join("."))).toContain("accounts.primary");
  });

  it("accepts top-level group overrides", () => {
    expectValidSignalConfig({
      groups: {
        "*": {
          requireMention: false,
        },
        "+1234567890": {
          requireMention: true,
        },
      },
    });
  });

  it("accepts per-account group overrides", () => {
    expectValidSignalConfig({
      accounts: {
        primary: {
          groups: {
            "*": {
              requireMention: false,
            },
          },
        },
      },
    });
  });

  it("rejects unknown keys in group entries", () => {
    const issues = expectInvalidSignalConfig({
      groups: {
        "*": {
          requireMention: false,
          nope: true,
        },
      },
    });

    expect(issues.map((issue) => issue.path.join("."))).toEqual(["groups.*"]);
  });
});
