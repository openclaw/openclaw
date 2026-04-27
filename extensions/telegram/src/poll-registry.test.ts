import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findTelegramPollRegistryEntry, recordTelegramPollRegistryEntry } from "./poll-registry.js";

describe("telegram poll registry", () => {
  let stateDir = "";
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalStateDir = process.env.OPENCLAW_STATE_DIR;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-poll-registry-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("stores and retrieves poll registry entries", async () => {
    await recordTelegramPollRegistryEntry({
      pollId: "poll-1",
      chatId: "-100123",
      messageThreadId: 77,
      question: "Ready?",
      options: ["Yes", "No"],
    });

    await expect(findTelegramPollRegistryEntry({ pollId: "poll-1" })).resolves.toEqual(
      expect.objectContaining({
        pollId: "poll-1",
        chatId: "-100123",
        messageThreadId: 77,
        question: "Ready?",
        options: ["Yes", "No"],
      }),
    );
  });

  it("prunes the registry to the newest 100 entries", async () => {
    for (let index = 0; index < 101; index += 1) {
      await recordTelegramPollRegistryEntry({
        pollId: `poll-${index}`,
        chatId: "123",
        question: `Question ${index}`,
        options: ["A", "B"],
      });
    }

    const registryPath = path.join(stateDir, "telegram", "poll-registry-default.json");
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as {
      polls: Array<{ pollId: string }>;
    };

    expect(registry.polls).toHaveLength(100);
    expect(registry.polls.some((entry) => entry.pollId === "poll-0")).toBe(false);
    expect(registry.polls.some((entry) => entry.pollId === "poll-100")).toBe(true);
  });
});
