import { describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "./channel-runtime-api.js";
import { resolveFeishuLoginExplicitSetPaths } from "./channel.js";

describe("Feishu auth writeback", () => {
  it("marks only the account fields touched by login as explicit", () => {
    const previousConfig = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            primary: {
              enabled: true,
              appId: "old-app",
              allowFrom: ["ou_primary"],
            },
            untouched: {
              enabled: true,
              appId: "untouched-app",
              allowFrom: ["ou_untouched"],
            },
          },
        },
      },
    } satisfies ClawdbotConfig;
    const nextConfig = structuredClone(previousConfig);
    nextConfig.channels.feishu.accounts.primary.appId = "new-app";

    const explicitSetPaths = resolveFeishuLoginExplicitSetPaths({
      previousConfig,
      nextConfig,
    });

    expect(explicitSetPaths).toContainEqual(["channels", "feishu", "accounts", "primary", "appId"]);
    expect(explicitSetPaths).not.toContainEqual(["channels", "feishu", "accounts", "untouched"]);
    expect(explicitSetPaths).not.toContainEqual([
      "channels",
      "feishu",
      "accounts",
      "untouched",
      "allowFrom",
    ]);
  });

  it("marks new account leaf fields without blessing the whole account subtree", () => {
    const previousConfig = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            existing: {
              enabled: true,
              allowFrom: ["ou_existing"],
            },
          },
        },
      },
    } satisfies ClawdbotConfig;
    const nextConfig = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            ...previousConfig.channels.feishu.accounts,
            fresh: {
              enabled: true,
              appId: "fresh-app",
              allowFrom: ["ou_fresh"],
            },
          },
        },
      },
    } satisfies ClawdbotConfig;

    const explicitSetPaths = resolveFeishuLoginExplicitSetPaths({
      previousConfig,
      nextConfig,
    });

    expect(explicitSetPaths).toEqual(
      expect.arrayContaining([
        ["channels", "feishu", "accounts", "fresh", "enabled"],
        ["channels", "feishu", "accounts", "fresh", "appId"],
        ["channels", "feishu", "accounts", "fresh", "allowFrom"],
      ]),
    );
    expect(explicitSetPaths).not.toContainEqual(["channels", "feishu", "accounts", "fresh"]);
    expect(explicitSetPaths).not.toContainEqual([
      "channels",
      "feishu",
      "accounts",
      "existing",
      "allowFrom",
    ]);
  });
});
