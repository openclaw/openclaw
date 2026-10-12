// Discord tests prove a stale-ambient expiry never outlives the config its classifier read.
import { ChannelType } from "discord-api-types/v10";
import type { ChannelIngressQueueRecord } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInternalTestClient } from "../internal/test-builders.test-support.js";
import { createDiscordStaleAmbientPendingDisposition } from "./ingress-stale-policy.js";
import { createDiscordLivePolicyReader } from "./live-policy.js";
import type { resolveDiscordAllowlistConfig } from "./provider.allowlist.js";

const mocks = vi.hoisted(() => ({
  resolveAllowlist: vi.fn<typeof resolveDiscordAllowlistConfig>(),
}));
vi.mock("./provider.allowlist.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provider.allowlist.js")>()),
  resolveDiscordAllowlistConfig: mocks.resolveAllowlist,
}));

type ResolvedAllowlist = Awaited<ReturnType<typeof resolveDiscordAllowlistConfig>>;
const publish = (cfg: OpenClawConfig) => setRuntimeConfigSnapshot(cfg, cfg);
const STALE_AT = 0;
const NOW = 60 * 60 * 1_000;

const BASE: OpenClawConfig = {
  channels: { discord: { token: "synthetic-token" } },
  agents: { list: [{ id: "main" }] },
} as unknown as OpenClawConfig;
/** The provider denies mention patterns in c1; only the policy edit lifts it. */
const DENY_IN_C1 = {
  channels: { discord: { token: "synthetic-token", mentionPatterns: { denyIn: ["c1"] } } },
};
const HELPER = { groupChat: { mentionPatterns: ["\\bhelper\\b"] } };

/**
 * Every classifier input, each edited so the same stale row becomes addressed:
 * agent identity and patterns, global group-chat patterns, broadcast
 * participants, and the Discord provider's mention-pattern policy.
 */
type Edit = { name: string; content: string; base?: OpenClawConfig; edit: OpenClawConfig };
// SAFETY: fixtures author only the config fields the classifier reads.
const EDITS = [
  {
    name: "agent identity name",
    content: "claw please look",
    edit: { ...BASE, agents: { list: [{ id: "main", identity: { name: "claw" } }] } },
  },
  {
    name: "keyed agent mention patterns",
    content: "helper, can you look",
    edit: { ...BASE, agents: { list: [{ id: "main" }], entries: { helper: HELPER } } },
  },
  {
    name: "global group-chat mention patterns",
    content: "helper, can you look",
    edit: { ...BASE, messages: { groupChat: { mentionPatterns: ["\\bhelper\\b"] } } },
  },
  {
    name: "broadcast participants",
    content: "@helper can you look",
    base: {
      ...BASE,
      ...DENY_IN_C1,
      agents: { entries: { helper: HELPER } },
    },
    edit: {
      ...BASE,
      ...DENY_IN_C1,
      agents: { entries: { helper: HELPER } },
      broadcast: { "discord:c1": ["helper"] },
    },
  },
  {
    name: "Discord mention-pattern policy",
    content: "helper, can you look",
    base: {
      ...BASE,
      ...DENY_IN_C1,
      agents: { entries: { helper: HELPER } },
    },
    edit: { ...BASE, agents: { entries: { helper: HELPER } } },
  },
] as unknown[] as Edit[];

function staleRow(content: string): ChannelIngressQueueRecord<unknown> {
  return {
    id: "m1",
    channelId: "discord",
    accountId: "default",
    queueName: "discord:default",
    payload: {
      version: 1,
      receivedAt: STALE_AT,
      rawMessage: {
        id: "m1",
        channel_id: "c1",
        guild_id: "g1",
        content,
        timestamp: new Date(STALE_AT).toISOString(),
        mention_everyone: false,
        mentions: [],
        attachments: [],
        author: { id: "user-1", username: "alice" },
      },
    },
    receivedAt: STALE_AT,
    updatedAt: STALE_AT,
    laneKey: "channel:c1",
    attempts: 0,
  };
}

/** Runs the stale policy on a live reader; `afterRead` lands between snapshot and verdict. */
async function decide(params: { cfg: OpenClawConfig; content: string; afterRead?: () => void }) {
  publish(params.cfg);
  const read = createDiscordLivePolicyReader({ cfg: params.cfg, accountId: "default" });
  const disposition = createDiscordStaleAmbientPendingDisposition({
    botUserId: "bot-1",
    client: createInternalTestClient(),
    readPolicy: async () => {
      const policy = await read();
      params.afterRead?.();
      return policy;
    },
    resolveChannelInfo: () => ({ guildId: "g1", name: "general", type: ChannelType.GuildText }),
    isChannelInventoryHydrating: () => false,
  });
  return await disposition(staleRow(params.content), { laneKey: "channel:c1", now: NOW });
}

beforeEach(() => {
  mocks.resolveAllowlist.mockReset();
  mocks.resolveAllowlist.mockImplementation(async ({ guildEntries, allowFrom }) => ({
    guildEntries: guildEntries as ResolvedAllowlist["guildEntries"],
    allowFrom: allowFrom as string[] | undefined,
  }));
});
afterEach(() => clearRuntimeConfigSnapshot());

describe("discord stale ambient policy freshness", () => {
  it.each(EDITS)("expires the row under the unedited snapshot ($name)", async (row) => {
    await expect(decide({ cfg: row.base ?? BASE, content: row.content })).resolves.toMatchObject({
      kind: "fail",
      reason: "stale-ambient-backlog",
    });
  });

  it.each(EDITS)("addresses the row under the edited config ($name)", async (row) => {
    await expect(decide({ cfg: row.edit, content: row.content })).resolves.toBeNull();
  });

  it.each(EDITS)("drops a verdict whose snapshot an edit superseded ($name)", async (row) => {
    await expect(
      decide({ cfg: row.base ?? BASE, content: row.content, afterRead: () => publish(row.edit) }),
    ).resolves.toBeNull();
  });

  it.each(EDITS)("invalidates a returned verdict at its commit ($name)", async (row) => {
    // 🌊 on 08d7a0292c: the edit lands after the policy returned, before the
    // drain's write; the verdict's guard is what the queue re-checks at commit.
    const verdict = await decide({ cfg: row.base ?? BASE, content: row.content });
    expect(verdict).toMatchObject({ kind: "fail", reason: "stale-ambient-backlog" });
    const guard = (verdict as { isStillValid?: () => boolean }).isStillValid;
    expect(guard?.()).toBe(true);
    publish(row.edit);
    expect(guard?.()).toBe(false);
  });

  it("keeps a verdict when only the same published config is re-read", async () => {
    const cfg = BASE;
    await expect(
      decide({ cfg, content: "just chatting", afterRead: () => publish(cfg) }),
    ).resolves.toMatchObject({ kind: "fail" });
  });
});
