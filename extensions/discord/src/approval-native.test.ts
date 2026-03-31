import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clearSessionStoreCacheForTest } from "../../../src/config/sessions.js";
import { createDiscordNativeApprovalAdapter } from "./approval-native.js";

const STORE_PATH = path.join(os.tmpdir(), "openclaw-discord-approval-native-test.json");

function writeStore(store: Record<string, unknown>) {
  fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  clearSessionStoreCacheForTest();
}

describe("createDiscordNativeApprovalAdapter", () => {
  it("normalizes prefixed turn-source channel ids", async () => {
    const adapter = createDiscordNativeApprovalAdapter();

    const target = await adapter.native?.resolveOriginTarget?.({
      cfg: {} as never,
      accountId: "main",
      approvalKind: "plugin",
      request: {
        id: "abc",
        request: {
          title: "Plugin approval",
          description: "Let plugin proceed",
          turnSourceChannel: "discord",
          turnSourceTo: "channel:123456789",
          turnSourceAccountId: "main",
        },
        createdAtMs: 1,
        expiresAtMs: 2,
      },
    });

    expect(target).toEqual({ to: "123456789" });
  });

  it("falls back to approver DMs for Discord DM sessions with raw turn-source ids", async () => {
    const adapter = createDiscordNativeApprovalAdapter();

    const target = await adapter.native?.resolveOriginTarget?.({
      cfg: {} as never,
      accountId: "main",
      approvalKind: "plugin",
      request: {
        id: "abc",
        request: {
          title: "Plugin approval",
          description: "Let plugin proceed",
          sessionKey: "agent:main:discord:dm:123456789",
          turnSourceChannel: "discord",
          turnSourceTo: "123456789",
          turnSourceAccountId: "main",
        },
        createdAtMs: 1,
        expiresAtMs: 2,
      },
    });

    expect(target).toBeNull();
  });

  it("ignores session-store turn targets for Discord DM sessions", async () => {
    writeStore({
      "agent:main:discord:dm:123456789": {
        sessionId: "sess",
        updatedAt: Date.now(),
        origin: { provider: "discord", to: "123456789", accountId: "main" },
        lastChannel: "discord",
        lastTo: "123456789",
        lastAccountId: "main",
      },
    });

    const adapter = createDiscordNativeApprovalAdapter();
    const target = await adapter.native?.resolveOriginTarget?.({
      cfg: { session: { store: STORE_PATH } } as never,
      accountId: "main",
      approvalKind: "plugin",
      request: {
        id: "abc",
        request: {
          title: "Plugin approval",
          description: "Let plugin proceed",
          sessionKey: "agent:main:discord:dm:123456789",
          turnSourceChannel: "discord",
          turnSourceTo: "123456789",
          turnSourceAccountId: "main",
        },
        createdAtMs: 1,
        expiresAtMs: 2,
      },
    });

    expect(target).toBeNull();
  });

  it("accepts raw turn-source ids when a Discord channel session backs them", async () => {
    const adapter = createDiscordNativeApprovalAdapter();

    const target = await adapter.native?.resolveOriginTarget?.({
      cfg: {} as never,
      accountId: "main",
      approvalKind: "plugin",
      request: {
        id: "abc",
        request: {
          title: "Plugin approval",
          description: "Let plugin proceed",
          sessionKey: "agent:main:discord:channel:123456789",
          turnSourceChannel: "discord",
          turnSourceTo: "123456789",
          turnSourceAccountId: "main",
        },
        createdAtMs: 1,
        expiresAtMs: 2,
      },
    });

    expect(target).toEqual({ to: "123456789" });
  });

  it("falls back to extracting the channel id from the session key", async () => {
    const adapter = createDiscordNativeApprovalAdapter();

    const target = await adapter.native?.resolveOriginTarget?.({
      cfg: {} as never,
      accountId: "main",
      approvalKind: "plugin",
      request: {
        id: "abc",
        request: {
          title: "Plugin approval",
          description: "Let plugin proceed",
          sessionKey: "agent:main:discord:channel:987654321",
        },
        createdAtMs: 1,
        expiresAtMs: 2,
      },
    });

    expect(target).toEqual({ to: "987654321" });
  });
});
