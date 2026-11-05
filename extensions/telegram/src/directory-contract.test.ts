// Telegram tests cover directory contract plugin behavior.
import { expectDirectoryIds } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { describe, it } from "vitest";
import {
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
} from "../directory-contract-api.js";
describe("Telegram directory contract", () => {
  it("lists peers/groups from config", async () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: { source: "exec", provider: "default", id: "telegram-directory" },
          allowFrom: ["123", "alice", "tg:@bob"],
          dms: { "456": {} },
          groups: { "-1001": {}, "*": {} },
        },
      },
    } as unknown as OpenClawConfig;

    await expectDirectoryIds(
      listTelegramDirectoryPeersFromConfig,
      cfg,
      ["123", "456", "@alice", "@bob"],
      { sorted: true },
    );
    await expectDirectoryIds(listTelegramDirectoryGroupsFromConfig, cfg, ["-1001"]);
  });

  it("keeps fallback semantics when accountId is omitted", async () => {
    await withEnvAsync({ TELEGRAM_BOT_TOKEN: "tok-env" }, async () => {
      const cfg = {
        channels: {
          telegram: {
            allowFrom: ["alice"],
            groups: { "-1001": {} },
            accounts: {
              work: {
                botToken: "tok-work",
                allowFrom: ["bob"],
                groups: { "-2002": {} },
              },
            },
          },
        },
      } as unknown as OpenClawConfig;

      await expectDirectoryIds(listTelegramDirectoryPeersFromConfig, cfg, ["@alice"]);
      await expectDirectoryIds(listTelegramDirectoryGroupsFromConfig, cfg, ["-1001"]);
    });
  });
});
