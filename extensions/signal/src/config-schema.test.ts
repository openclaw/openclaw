// Signal tests cover config schema plugin behavior.
import { describe, expect, it } from "vitest";
import { SignalConfigSchema } from "../config-api.js";

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
  });

  it("accepts top-level and per-account aliases", () => {
    expectValidSignalConfig({
      aliases: {
        me: "+15551234567",
        ops: "group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
      },
      accounts: {
        work: {
          aliases: {
            jane: "uuid:123e4567-e89b-12d3-a456-426614174000",
          },
        },
      },
    });
  });

  it("accepts account-owned transport configurations", () => {
    expectValidSignalConfig({
      account: "+15555550123",
      transport: {
        kind: "managed-native",
        cliPath: "/opt/signal-cli",
        url: "http://127.0.0.1:8181",
        httpHost: "127.0.0.1",
        httpPort: 8181,
      },
      accounts: {
        native: {
          transport: {
            kind: "external-native",
            url: "http://signal-native:8080",
          },
        },
        container: {
          transport: {
            kind: "container",
            url: "http://signal-container:8080",
          },
        },
      },
    });
  });

  it("rejects a root container transport without an effective account", () => {
    const issues = expectInvalidSignalConfig({
      transport: {
        kind: "container",
        url: "http://signal-container:8080",
      },
    });

    expect(issues.map((issue) => issue.path.join("."))).toContain("account");
  });

  it("rejects a named container transport without an inherited or owned account", () => {
    const issues = expectInvalidSignalConfig({
      accounts: {
        work: {
          transport: {
            kind: "container",
            url: "http://signal-container:8080",
          },
        },
      },
    });

    expect(issues.map((issue) => issue.path.join("."))).toContain("accounts.work.account");
  });

  it("allows disabled account-less container transports", () => {
    expectValidSignalConfig({
      enabled: false,
      transport: {
        kind: "container",
        url: "http://signal-container:8080",
      },
    });
    expectValidSignalConfig({
      accounts: {
        work: {
          enabled: false,
          transport: {
            kind: "container",
            url: "http://signal-container:8080",
          },
        },
      },
    });
  });

  it("accepts a default-account number stored beside a root container transport", () => {
    expectValidSignalConfig({
      transport: {
        kind: "container",
        url: "http://signal-container:8080",
      },
      accounts: {
        Default: {
          account: "+15555550123",
        },
      },
    });
  });

  it("rejects managed transport ports outside the TCP range", () => {
    expectInvalidSignalConfig({
      transport: {
        kind: "managed-native",
        httpPort: 65_536,
      },
    });
  });

  it("rejects the retired apiMode shape", () => {
    const issues = expectInvalidSignalConfig({ apiMode: "container" });

    expect(issues.map((issue) => issue.path.join("."))).toContain("");
  });

  it("rejects transport fields that belong to another kind", () => {
    expectInvalidSignalConfig({
      transport: {
        kind: "container",
        url: "http://signal-container:8080",
        cliPath: "/opt/signal-cli",
      },
    });
  });

  it("rejects non-HTTP transport URLs", () => {
    expectInvalidSignalConfig({
      transport: {
        kind: "external-native",
        url: "ftp://signal-native:8080",
      },
    });
  });

  it("rejects transport URLs containing credentials", () => {
    expectInvalidSignalConfig({
      transport: {
        kind: "container",
        url: "http://user@signal-container:8080",
      },
    });
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
