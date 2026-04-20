import type { ChannelDirectoryEntry } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  listWhatsAppDirectoryGroupsFromConfig,
  listWhatsAppDirectoryPeersFromConfig,
} from "../directory-contract-api.js";

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
) {
  const entries = await listDirectoryEntriesWithDefaults(listFn, cfg);
  expect(entries.map((entry) => entry.id)).toEqual(expected);
}

describe("WhatsApp directory contract", () => {
  it("lists peers/groups from config", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          allowFrom: ["+15550000000", "*", "123@g.us"],
          groups: { "999@g.us": { requireMention: true }, "*": {} },
        },
      },
    } as unknown as OpenClawConfig;

    await expectDirectoryIds(listWhatsAppDirectoryPeersFromConfig, cfg, ["+15550000000"]);
    await expectDirectoryIds(listWhatsAppDirectoryGroupsFromConfig, cfg, ["999@g.us"]);
  });

  it("applies query and limit filtering for config-backed directories", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          groups: { "111@g.us": {}, "222@g.us": {}, "333@s.whatsapp.net": {} },
        },
      },
    } as unknown as OpenClawConfig;

    const groups = await listWhatsAppDirectoryGroupsFromConfig({
      cfg,
      accountId: "default",
      query: "@g.us",
      limit: 1,
    });
    expect(groups.map((entry) => entry.id)).toEqual(["111@g.us"]);
  });
});
