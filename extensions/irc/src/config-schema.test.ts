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

  it.each([
    {
      label: "channels.irc.password",
      config: {
        host: "irc.example.com",
        nick: "clawwork",
        password: { source: "env", provider: "default", id: "NS_PW" },
      },
    },
    {
      label: "channels.irc.accounts.work.password",
      config: {
        accounts: {
          work: {
            host: "irc.example.com",
            nick: "clawwork",
            password: { source: "env", provider: "default", id: "NS_PW" },
          },
        },
      },
    },
    {
      label: "channels.irc.nickserv.password",
      config: {
        host: "irc.example.com",
        nick: "clawwork",
        nickserv: { password: { source: "env", provider: "default", id: "NS_PW" } },
      },
    },
    {
      label: "channels.irc.accounts.work.nickserv.password",
      config: {
        accounts: {
          work: {
            host: "irc.example.com",
            nick: "clawwork",
            nickserv: {
              service: "NickServ",
              password: { source: "env", provider: "default", id: "NS_PW" },
            },
          },
        },
      },
    },
  ])("accepts a SecretRef at $label", ({ config }) => {
    expectValidConfig(parseIrcConfig(config));
  });
});
