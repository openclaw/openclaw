// Irc tests cover config schema plugin behavior.
import { describe, expect, it } from "vitest";
import { IrcChannelConfigSchema } from "./config-schema.js";
import type { IrcAccountConfig } from "./types.js";

type ParsedIrcConfig = IrcAccountConfig & {
  accounts?: Record<string, IrcAccountConfig>;
  defaultAccount?: string;
};

function parseIrcConfig(value: unknown) {
  const runtime = IrcChannelConfigSchema.runtime;
  if (!runtime) {
    throw new Error("expected IRC channel config runtime");
  }
  return runtime.safeParse(value);
}

function expectValidConfig(result: ReturnType<typeof parseIrcConfig>) {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error("expected config to be valid");
  }
  return result.data as ParsedIrcConfig;
}

function expectInvalidConfig(result: ReturnType<typeof parseIrcConfig>) {
  expect(result.success).toBe(false);
  if (result.success) {
    throw new Error("expected config to be invalid");
  }
  return result.issues;
}

describe("irc config schema", () => {
  it('rejects dmPolicy="open" without allowFrom "*"', () => {
    const issues = expectInvalidConfig(
      parseIrcConfig({
        dmPolicy: "open",
        allowFrom: ["alice"],
      }),
    );

    expect(issues[0]?.path?.join(".")).toBe("allowFrom");
  });

  it("rejects nickserv register without registerEmail", () => {
    const issues = expectInvalidConfig(
      parseIrcConfig({
        nickserv: {
          register: true,
          password: "secret",
        },
      }),
    );

    expect(issues[0]?.path?.join(".")).toBe("nickserv.registerEmail");
  });

  it("accepts nickserv register with registerEmail only", () => {
    expectValidConfig(
      parseIrcConfig({
        nickserv: {
          register: true,
          registerEmail: "bot@example.com",
        },
      }),
    );
  });
});
