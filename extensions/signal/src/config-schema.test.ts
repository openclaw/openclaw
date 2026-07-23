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

  it('rejects dmPolicy="allowlist" without allowFrom', () => {
    const issues = expectInvalidSignalConfig({ dmPolicy: "allowlist" });
    expect(issues.some((issue) => issue.path.includes("allowFrom"))).toBe(true);
  });

  it("accepts account allowlist policy inherited from the channel", () => {
    expectValidSignalConfig({
      allowFrom: ["+15550001111"],
      accounts: { work: { dmPolicy: "allowlist" } },
    });
  });

  it("accepts channel and account scoped reply-to modes", () => {
    expectValidSignalConfig({
      replyToMode: "first",
      replyToModeByChatType: { direct: "all", group: "first" },
      accounts: {
        work: {
          replyToMode: "off",
          replyToModeByChatType: { direct: "first", group: "off" },
        },
      },
    });
  });

  it("rejects unreachable channel and account reply-to overrides", () => {
    expectInvalidSignalConfig({ replyToModeByChatType: { channel: "off" } });
    expectInvalidSignalConfig({
      accounts: { work: { replyToModeByChatType: { channel: "off" } } },
    });
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
