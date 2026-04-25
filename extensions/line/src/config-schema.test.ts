import { describe, expect, it } from "vitest";
import { LineConfigSchema } from "./config-schema.js";

function expectValidLineConfig(config: unknown) {
  const res = LineConfigSchema.safeParse(config);
  expect(res.success).toBe(true);
  if (!res.success) {
    throw new Error("expected LINE config to be valid");
  }
  return res.data;
}

function expectInvalidLineConfig(config: unknown) {
  const res = LineConfigSchema.safeParse(config);
  expect(res.success).toBe(false);
  if (res.success) {
    throw new Error("expected LINE config to be invalid");
  }
  return res.error.issues;
}

describe("line config schema", () => {
  it('rejects dmPolicy="open" without allowFrom "*"', () => {
    const issues = expectInvalidLineConfig({
      dmPolicy: "open",
      allowFrom: ["U123"],
    });

    expect(issues[0]?.path.join(".")).toBe("allowFrom");
  });

  it('rejects dmPolicy="open" without allowFrom', () => {
    const issues = expectInvalidLineConfig({
      dmPolicy: "open",
    });

    expect(issues[0]?.path.join(".")).toBe("allowFrom");
  });

  it('accepts dmPolicy="open" with allowFrom "*"', () => {
    const cfg = expectValidLineConfig({
      dmPolicy: "open",
      allowFrom: ["*"],
    });

    expect(cfg.dmPolicy).toBe("open");
  });

  it('rejects account-level dmPolicy="open" without account allowFrom "*"', () => {
    const issues = expectInvalidLineConfig({
      accounts: {
        work: {
          dmPolicy: "open",
          allowFrom: ["U123"],
        },
      },
    });

    expect(issues[0]?.path.join(".")).toBe("accounts.work.allowFrom");
    expect(issues[0]?.message).toBe(
      'LINE account dmPolicy="open" requires that account allowFrom to include "*"',
    );
  });

  it('accepts account-level dmPolicy="open" with account allowFrom "*"', () => {
    const cfg = expectValidLineConfig({
      accounts: {
        work: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });

    expect(cfg.accounts?.work?.dmPolicy).toBe("open");
  });
});
