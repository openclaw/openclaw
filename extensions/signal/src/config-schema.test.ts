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
});
