import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureDiscordReactionFeedback, resolveDiscordReactionCapturePath } from "./reaction-feedback.js";

const ORIGINAL_OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

afterEach(() => {
  process.env.OPENCLAW_STATE_DIR = ORIGINAL_OPENCLAW_STATE_DIR;
});

function createLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  };
}

describe("reaction feedback capture", () => {
  it("writes assistant-authored reaction feedback as append-only JSONL", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reaction-feedback-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;

    await captureDiscordReactionFeedback({
      cfg: { channels: { discord: { guilds: {} } } } as never,
      accountId: "default",
      action: "added",
      botUserId: "bot-1",
      data: {
        guild_id: "guild-1",
        channel_id: "channel-1",
        message_id: "message-1",
        user: { id: "user-1" },
        emoji: { name: "👍" },
      } as never,
      fetchedMessage: {
        author: { id: "bot-1", bot: true },
        timestamp: "2026-06-09T12:00:00.000Z",
      },
      threadId: "thread-1",
      logger: createLogger() as never,
    });

    const capturePath = resolveDiscordReactionCapturePath("default");
    const contents = await fs.readFile(capturePath, "utf8");
    const record = JSON.parse(contents.trim()) as {
      action: string;
      assistant_message: boolean;
      author_id: string;
      channel_id: string;
      config_version: string;
      emoji_name: string;
      emoji_type: string;
      guild_id: string;
      message_author_id: string;
      message_created_at: string;
      message_id: string;
      message_provenance: string;
      reactor_id: string;
      reacted_at: string;
      thread_id: string;
    };

    expect(record.action).toBe("added");
    expect(record.assistant_message).toBe(true);
    expect(record.author_id).toBe("bot-1");
    expect(record.message_author_id).toBe("bot-1");
    expect(record.reactor_id).toBe("user-1");
    expect(record.channel_id).toBe("channel-1");
    expect(record.thread_id).toBe("thread-1");
    expect(record.guild_id).toBe("guild-1");
    expect(record.message_id).toBe("message-1");
    expect(record.message_created_at).toBe("2026-06-09T12:00:00.000Z");
    expect(record.message_provenance).toBe("assistant");
    expect(record.emoji_name).toBe("👍");
    expect(record.emoji_type).toBe("unicode");
    expect(record.reacted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(record.config_version).toMatch(/^sha256:/);
  });

  it("skips non-assistant messages", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reaction-feedback-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;

    await captureDiscordReactionFeedback({
      cfg: { channels: { discord: {} } } as never,
      accountId: "default",
      action: "removed",
      botUserId: "bot-1",
      data: {
        guild_id: "guild-1",
        channel_id: "channel-1",
        message_id: "message-1",
        user: { id: "user-1" },
        emoji: { name: "👎" },
      } as never,
      fetchedMessage: {
        author: { id: "human-1", bot: false },
        timestamp: "2026-06-09T12:00:00.000Z",
      },
      logger: createLogger() as never,
    });

    await expect(fs.readFile(resolveDiscordReactionCapturePath("default"), "utf8")).rejects.toThrow(
      /ENOENT/,
    );
  });
});
