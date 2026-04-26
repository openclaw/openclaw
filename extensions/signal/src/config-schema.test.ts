import { describe, expect, it } from "vitest";
import { SignalConfigSchema } from "../config-api.js";

const envRef = (id: string) => ({ source: "env" as const, provider: "default", id });

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

    expect(issues.some((issue) => issue.path.join(".").startsWith("groups"))).toBe(true);
  });

  it("accepts SecretRefs for phone-number config fields", () => {
    expectValidSignalConfig({
      account: envRef("SIGNAL_ACCOUNT"),
      allowFrom: [envRef("SIGNAL_OWNER")],
      defaultTo: "${SIGNAL_DEFAULT_TO}",
      groupAllowFrom: [envRef("SIGNAL_GROUP_OWNER")],
      reactionAllowlist: [envRef("SIGNAL_REACTION_OWNER")],
      accounts: {
        work: {
          account: "${SIGNAL_WORK_ACCOUNT}",
          allowFrom: [envRef("SIGNAL_WORK_OWNER")],
          defaultTo: envRef("SIGNAL_WORK_DEFAULT_TO"),
          groupAllowFrom: ["${SIGNAL_WORK_GROUP_OWNER}"],
          reactionAllowlist: ["${SIGNAL_WORK_REACTION_OWNER}"],
        },
      },
    });
  });
});
