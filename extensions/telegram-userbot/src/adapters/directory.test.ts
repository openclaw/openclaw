import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { telegramUserbotDirectoryAdapter } from "./directory.js";

// Mock config adapter
vi.mock("./config.js", () => ({
  resolveTelegramUserbotAccount: vi.fn(
    ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) => {
      const section = cfg.channels?.["telegram-userbot"] as Record<string, unknown> | undefined;
      return {
        accountId: accountId ?? "default",
        name: (section?.name as string) ?? undefined,
        enabled: section?.enabled !== false,
        configured: Boolean(section?.apiId && section?.apiHash),
        apiId: section?.apiId ?? 0,
        apiHash: section?.apiHash ?? "",
        config: section ?? {},
      };
    },
  ),
}));

function makeCfg(extra: Record<string, unknown> = {}): OpenClawConfig {
  return {
    channels: {
      "telegram-userbot": {
        apiId: 12345,
        apiHash: "abc123hash",
        ...extra,
      },
    },
  } as unknown as OpenClawConfig;
}

const runtime = {} as never;

describe("telegramUserbotDirectoryAdapter", () => {
  describe("self", () => {
    it("returns account info when configured", async () => {
      const result = await telegramUserbotDirectoryAdapter.self!({
        cfg: makeCfg({ name: "My Account" }),
        accountId: "default",
        runtime,
      });
      expect(result).toEqual({
        kind: "user",
        id: "default",
        name: "My Account",
      });
    });

    it("returns null when not configured", async () => {
      const cfg = { channels: { "telegram-userbot": {} } } as unknown as OpenClawConfig;
      const result = await telegramUserbotDirectoryAdapter.self!({
        cfg,
        accountId: "default",
        runtime,
      });
      expect(result).toBeNull();
    });

    it("returns null when disabled", async () => {
      const result = await telegramUserbotDirectoryAdapter.self!({
        cfg: makeCfg({ enabled: false }),
        accountId: "default",
        runtime,
      });
      expect(result).toBeNull();
    });
  });

  describe("listPeers", () => {
    it("returns peers from allowFrom config", async () => {
      const result = await telegramUserbotDirectoryAdapter.listPeers!({
        cfg: makeCfg({ allowFrom: [12345, "@johndoe", "67890"] }),
        accountId: "default",
        runtime,
      });
      expect(result).toEqual([
        { kind: "user", id: "12345", name: undefined },
        { kind: "user", id: "@johndoe", name: "@johndoe" },
        { kind: "user", id: "67890", name: undefined },
      ]);
    });

    it("filters by query", async () => {
      const result = await telegramUserbotDirectoryAdapter.listPeers!({
        cfg: makeCfg({ allowFrom: ["@alice", "@bob", "@charlie"] }),
        accountId: "default",
        query: "bob",
        runtime,
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe("@bob");
    });

    it("respects limit", async () => {
      const result = await telegramUserbotDirectoryAdapter.listPeers!({
        cfg: makeCfg({ allowFrom: ["@a", "@b", "@c", "@d"] }),
        accountId: "default",
        limit: 2,
        runtime,
      });
      expect(result).toHaveLength(2);
    });

    it("returns empty when not configured", async () => {
      const cfg = { channels: { "telegram-userbot": {} } } as unknown as OpenClawConfig;
      const result = await telegramUserbotDirectoryAdapter.listPeers!({
        cfg,
        accountId: "default",
        runtime,
      });
      expect(result).toEqual([]);
    });

    it("strips telegram-userbot prefix from entries", async () => {
      const result = await telegramUserbotDirectoryAdapter.listPeers!({
        cfg: makeCfg({ allowFrom: ["telegram-userbot:12345"] }),
        accountId: "default",
        runtime,
      });
      expect(result[0]!.id).toBe("12345");
    });
  });

  describe("listGroups", () => {
    it("returns empty array", async () => {
      const result = await telegramUserbotDirectoryAdapter.listGroups!({
        cfg: makeCfg(),
        accountId: "default",
        runtime,
      });
      expect(result).toEqual([]);
    });
  });
});
