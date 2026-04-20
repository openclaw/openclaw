import type {
  BaseProbeResult,
  BaseTokenResolution,
  ChannelDirectoryEntry,
} from "openclaw/plugin-sdk/channel-contract";
import { type OpenClawConfig, withEnvAsync } from "openclaw/plugin-sdk/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
} from "../directory-contract-api.js";
import type { TelegramProbe } from "./probe.js";
import type { TelegramTokenResolution } from "./token.js";

type DirectoryListFn = (params: {
  cfg: OpenClawConfig;
  accountId?: string;
  query?: string | null;
  limit?: number | null;
}) => Promise<ChannelDirectoryEntry[]>;

async function listDirectoryEntriesWithDefaults(listFn: DirectoryListFn, cfg: OpenClawConfig) {
  return await listFn({
    cfg,
    accountId: "default",
    query: null,
    limit: null,
  });
}

async function expectDirectoryIds(
  listFn: DirectoryListFn,
  cfg: OpenClawConfig,
  expected: string[],
  options?: { sorted?: boolean },
) {
  const entries = await listDirectoryEntriesWithDefaults(listFn, cfg);
  const ids = entries.map((entry) => entry.id);
  expect(options?.sorted ? sortDirectoryIds(ids) : ids).toEqual(
    options?.sorted ? sortDirectoryIds(expected) : expected,
  );
}

function compareDirectoryIds(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortDirectoryIds(values: string[]) {
  return values.toSorted(compareDirectoryIds);
}

describe("Telegram directory contract", () => {
  it("keeps public probe and token resolution aligned with base contracts", () => {
    expectTypeOf<TelegramProbe>().toMatchTypeOf<BaseProbeResult>();
    expectTypeOf<TelegramTokenResolution>().toMatchTypeOf<BaseTokenResolution>();
  });

  it("lists peers/groups from config", async () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "telegram-test",
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

  it("keeps directories readable when tokens are unresolved SecretRefs", async () => {
    const envSecret = {
      source: "env",
      provider: "default",
      id: "MISSING_TEST_SECRET",
    } as const;
    const cfg = {
      channels: {
        telegram: {
          botToken: envSecret,
          allowFrom: ["alice"],
          groups: { "-1001": {} },
        },
      },
    } as unknown as OpenClawConfig;

    await expectDirectoryIds(listTelegramDirectoryPeersFromConfig, cfg, ["@alice"]);
    await expectDirectoryIds(listTelegramDirectoryGroupsFromConfig, cfg, ["-1001"]);
  });

  it("applies query and limit filtering for config-backed directories", async () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "telegram-test",
          groups: { "-1001": {}, "-1002": {}, "-2001": {} },
        },
      },
    } as unknown as OpenClawConfig;

    const groups = await listTelegramDirectoryGroupsFromConfig({
      cfg,
      accountId: "default",
      query: "-100",
      limit: 1,
    });
    expect(groups.map((entry) => entry.id)).toEqual(["-1001"]);
  });
});
