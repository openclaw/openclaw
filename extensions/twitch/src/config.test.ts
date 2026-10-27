import { describe, expect, it } from "vitest";
import { getAccountConfig, resolveTwitchAccountContext } from "./config.js";
import { makeTwitchChannelTestConfig } from "./test-fixtures.js";

describe("getAccountConfig", () => {
  it("normalizes account ids without reading inherited account properties", () => {
    const accounts = Object.create({
      inherited: {
        username: "inherited-bot",
        accessToken: "oauth:inherited",
      },
    }) as Record<string, unknown>;
    accounts.Secondary = {
      username: "secondbot",
      accessToken: "oauth:secondary",
    };

    const cfg = makeTwitchChannelTestConfig({
      accounts,
    });

    expect(getAccountConfig(cfg, "SECONDARY\r\n")).toEqual({
      username: "secondbot",
      accessToken: "oauth:secondary",
    });
    expect(getAccountConfig(cfg, "inherited")).toBeNull();
  });

  it("returns null when core config is null", () => {
    const result = getAccountConfig(null, "default");

    expect(result).toBeNull();
  });
});

describe("resolveTwitchAccountContext", () => {
  it("uses configured defaultAccount when accountId is omitted", () => {
    const context = resolveTwitchAccountContext(
      makeTwitchChannelTestConfig({
        defaultAccount: "secondary",
        accounts: {
          default: {
            username: "default-bot",
            accessToken: "oauth:default-token",
          },
          secondary: {
            username: "second-bot",
            accessToken: "oauth:second-token",
          },
        },
      }) as Parameters<typeof resolveTwitchAccountContext>[0],
    );

    expect(context.accountId).toBe("secondary");
    expect(context.account?.username).toBe("second-bot");
  });
});
