import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSentMessageCache,
  resetSentMessageCacheForTest,
  wasSentByBot,
} from "./sent-message-cache.js";
import { detectTelegramLegacyStateMigrations } from "./state-migrations.js";
import { getCachedSticker, resetTelegramStickerCacheForTests } from "./sticker-cache-store.js";
import { createTelegramThreadBindingManager, __testing } from "./thread-bindings.js";
import {
  getTopicName,
  resolveTopicNameCacheScope,
  resetTopicNameCacheForTest,
  resetTopicNameCacheStoreForTest,
} from "./topic-name-cache.js";
import {
  readTelegramUpdateOffset,
  resetTelegramUpdateOffsetsForTests,
} from "./update-offset-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  clearSentMessageCache();
  resetSentMessageCacheForTest();
  resetTopicNameCacheStoreForTest();
  await __testing.resetTelegramThreadBindingsForTests({ clearStore: true });
  resetTelegramStickerCacheForTests();
  await resetTelegramUpdateOffsetsForTests();
  resetPluginStateStoreForTests();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStateDir(): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-migrate-"));
  tempDirs.push(stateDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return stateDir;
}

function applyContext(stateDir: string) {
  return {
    cfg: {},
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
  };
}

describe("Telegram legacy state migrations", () => {
  it("imports update offsets into plugin state and removes the JSON files", async () => {
    const stateDir = makeStateDir();
    const telegramDir = path.join(stateDir, "telegram");
    fs.mkdirSync(telegramDir, { recursive: true });
    const sourcePath = path.join(telegramDir, "update-offset-default.json");
    fs.writeFileSync(
      sourcePath,
      `${JSON.stringify({ version: 2, lastUpdateId: 42, botId: "111111" })}\n`,
    );

    const plan = detectTelegramLegacyStateMigrations({ stateDir }).find(
      (entry) => entry.label === "Telegram update offset",
    );
    expect(plan).toBeTruthy();
    const result = await plan!.apply(applyContext(stateDir));

    expect(result.changes.join("\n")).toContain("Imported 1 Telegram update offset");
    await expect(
      readTelegramUpdateOffset({ accountId: "default", botToken: "111111:token" }),
    ).resolves.toBe(42);
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("imports sticker cache rows into plugin state and removes the JSON file", async () => {
    const stateDir = makeStateDir();
    const telegramDir = path.join(stateDir, "telegram");
    fs.mkdirSync(telegramDir, { recursive: true });
    const sourcePath = path.join(telegramDir, "sticker-cache.json");
    fs.writeFileSync(
      sourcePath,
      `${JSON.stringify({
        version: 1,
        stickers: {
          sticker1: {
            fileId: "file-1",
            fileUniqueId: "unique-1",
            description: "A useful sticker",
            cachedAt: "2026-03-01T10:00:00.000Z",
            emoji: ":)",
          },
        },
      })}\n`,
    );

    const plan = detectTelegramLegacyStateMigrations({ stateDir }).find(
      (entry) => entry.label === "Telegram sticker cache",
    );
    expect(plan).toBeTruthy();
    const result = await plan!.apply(applyContext(stateDir));

    expect(result.changes.join("\n")).toContain("Imported 1 Telegram sticker cache");
    expect(getCachedSticker("unique-1")?.description).toBe("A useful sticker");
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("imports thread bindings into plugin state and removes the JSON files", async () => {
    const stateDir = makeStateDir();
    const telegramDir = path.join(stateDir, "telegram");
    fs.mkdirSync(telegramDir, { recursive: true });
    const sourcePath = path.join(telegramDir, "thread-bindings-work.json");
    fs.writeFileSync(
      sourcePath,
      `${JSON.stringify({
        version: 1,
        bindings: [
          {
            accountId: "ignored",
            conversationId: "-100200300:topic:77",
            targetKind: "subagent",
            targetSessionKey: "agent:main:subagent:child-1",
            boundAt: 1_700_000_000_000,
            lastActivityAt: 1_700_000_000_100,
          },
        ],
      })}\n`,
    );

    const plan = detectTelegramLegacyStateMigrations({ stateDir }).find(
      (entry) => entry.label === "Telegram thread bindings",
    );
    expect(plan).toBeTruthy();
    const result = await plan!.apply(applyContext(stateDir));

    expect(result.changes.join("\n")).toContain("Imported 1 Telegram thread bindings");
    const manager = createTelegramThreadBindingManager({
      cfg: { channels: { telegram: { token: "test-token" } } } as never,
      accountId: "work",
      persist: true,
      enableSweeper: false,
    });
    expect(manager.getByConversationId("-100200300:topic:77")?.targetSessionKey).toBe(
      "agent:main:subagent:child-1",
    );
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("imports sent-message cache sidecars into plugin state and removes the JSON files", async () => {
    const stateDir = makeStateDir();
    const legacyStorePath = path.join(stateDir, "sessions", "work.json");
    const sourcePath = `${legacyStorePath}.telegram-sent-messages.json`;
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(
      sourcePath,
      `${JSON.stringify({
        "-100123": {
          "77": Date.now(),
        },
      })}\n`,
    );

    const plan = detectTelegramLegacyStateMigrations({ stateDir }).find(
      (entry) => entry.label === "Telegram sent-message cache",
    );
    expect(plan).toBeTruthy();
    const result = await plan!.apply(applyContext(stateDir));

    expect(result.changes.join("\n")).toContain("Imported 1 Telegram sent-message cache");
    resetSentMessageCacheForTest();
    expect(wasSentByBot("-100123", 77, { accountId: "default" })).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("imports topic-name cache sidecars into plugin state and removes the JSON files", async () => {
    const stateDir = makeStateDir();
    const legacyStorePath = path.join(stateDir, "sessions", "work.json");
    const sourcePath = `${legacyStorePath}.telegram-topic-names.json`;
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(
      sourcePath,
      `${JSON.stringify({
        "-100123:42": {
          name: "Deployments",
          iconColor: 0x6fb9f0,
          updatedAt: 1_700_000_000_000,
        },
      })}\n`,
    );

    const plan = detectTelegramLegacyStateMigrations({ stateDir }).find(
      (entry) => entry.label === "Telegram topic-name cache",
    );
    expect(plan).toBeTruthy();
    const result = await plan!.apply(applyContext(stateDir));

    expect(result.changes.join("\n")).toContain("Imported 1 Telegram topic-name cache");
    resetTopicNameCacheForTest();
    expect(getTopicName("-100123", "42", resolveTopicNameCacheScope(legacyStorePath))).toBe(
      "Deployments",
    );
    expect(fs.existsSync(sourcePath)).toBe(false);
  });
});
