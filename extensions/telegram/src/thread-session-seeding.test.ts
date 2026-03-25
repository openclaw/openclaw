import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { loadSessionStore, updateSessionStore } from "../../../src/config/sessions.js";
import {
  isTelegramTopicCreateServiceMessage,
  seedTelegramThreadSessionOnTopicCreate,
} from "./thread-session-seeding.js";

const tempDirs: string[] = [];

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-thread-seed-"));
  tempDirs.push(dir);
  return path.join(dir, "sessions.json");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("seedTelegramThreadSessionOnTopicCreate", () => {
  it("creates an empty DM topic session before parent defaults exist", async () => {
    const storePath = await makeStorePath();
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const seeded = await seedTelegramThreadSessionOnTopicCreate({
      cfg,
      accountId: "default",
      chatId: 12345,
      isGroup: false,
      senderId: "12345",
      dmThreadId: 77,
    });

    expect(seeded).toMatchObject({
      created: true,
      sessionKey: "agent:main:main:thread:12345:77",
      parentSessionKey: "agent:main:main",
    });
    expect(loadSessionStore(storePath)[seeded!.sessionKey]).toMatchObject({
      sessionId: expect.any(String),
      updatedAt: expect.any(Number),
    });
  });

  it("snapshots DM topic model and think defaults from the parent at creation time", async () => {
    const storePath = await makeStorePath();
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await updateSessionStore(storePath, (store) => {
      store["agent:main:main"] = {
        sessionId: "parent-dm-session",
        updatedAt: Date.now(),
        futureThreadProviderOverride: "anthropic",
        futureThreadModelOverride: "claude-sonnet-4-6",
        futureThreadThinkingLevelOverride: "off",
      };
      return null;
    });

    const seeded = await seedTelegramThreadSessionOnTopicCreate({
      cfg,
      accountId: "default",
      chatId: 12345,
      isGroup: false,
      senderId: "12345",
      dmThreadId: 88,
    });
    const child = loadSessionStore(storePath)[seeded!.sessionKey];

    expect(child).toMatchObject({
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      thinkingLevel: "off",
    });
  });

  it("snapshots forum-topic defaults from the parent group at creation time", async () => {
    const storePath = await makeStorePath();
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await updateSessionStore(storePath, (store) => {
      store["agent:main:telegram:group:-100123"] = {
        sessionId: "parent-group-session",
        updatedAt: Date.now(),
        futureThreadProviderOverride: "anthropic",
        futureThreadModelOverride: "claude-sonnet-4-6",
        futureThreadThinkingLevelOverride: "off",
      };
      return null;
    });

    const seeded = await seedTelegramThreadSessionOnTopicCreate({
      cfg,
      accountId: "default",
      chatId: -100123,
      isGroup: true,
      senderId: "42",
      resolvedThreadId: 99,
    });
    const child = loadSessionStore(storePath)[seeded!.sessionKey];

    expect(seeded).toMatchObject({
      created: true,
      sessionKey: "agent:main:telegram:group:-100123:topic:99",
      parentSessionKey: "agent:main:telegram:group:-100123",
    });
    expect(child).toMatchObject({
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      thinkingLevel: "off",
    });
  });

  it("snapshots forum-topic adaptive thinking defaults from the parent group at creation time", async () => {
    const storePath = await makeStorePath();
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    await updateSessionStore(storePath, (store) => {
      store["agent:main:telegram:group:-100123"] = {
        sessionId: "parent-group-session-adaptive",
        updatedAt: Date.now(),
        futureThreadProviderOverride: "anthropic",
        futureThreadModelOverride: "claude-sonnet-4-6",
        futureThreadThinkingLevelOverride: "adaptive",
      };
      return null;
    });

    const seeded = await seedTelegramThreadSessionOnTopicCreate({
      cfg,
      accountId: "default",
      chatId: -100123,
      isGroup: true,
      senderId: "42",
      resolvedThreadId: 100,
    });
    const child = loadSessionStore(storePath)[seeded!.sessionKey];

    expect(child).toMatchObject({
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      thinkingLevel: "adaptive",
    });
  });
});

describe("isTelegramTopicCreateServiceMessage", () => {
  it("matches forum topic create service messages", () => {
    expect(
      isTelegramTopicCreateServiceMessage({
        message: {
          message_id: 99,
          forum_topic_created: { name: "Builds" },
        },
        isGroup: true,
        resolvedThreadId: 99,
      }),
    ).toBe(true);
  });

  it("matches DM topic anchor messages when the message id equals the topic id", () => {
    expect(
      isTelegramTopicCreateServiceMessage({
        message: {
          message_id: 314,
          message_thread_id: 314,
          is_topic_message: true,
        } as never,
        isGroup: false,
        dmThreadId: 314,
      }),
    ).toBe(true);
  });

  it("ignores regular DM topic messages after the topic already exists", () => {
    expect(
      isTelegramTopicCreateServiceMessage({
        message: {
          message_id: 315,
          message_thread_id: 314,
          is_topic_message: true,
        } as never,
        isGroup: false,
        dmThreadId: 314,
      }),
    ).toBe(false);
  });
});
