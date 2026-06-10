// Telegram tests cover message dispatch dedupe plugin behavior.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Message } from "grammy/types";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildTelegramMessageDispatchAccountReplayKey,
  buildTelegramMessageDispatchReplayKey,
  claimTelegramMessageDispatchReplay,
  commitTelegramMessageDispatchReplay,
  createTelegramMessageDispatchReplayGuard,
  releaseTelegramMessageDispatchReplay,
  TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE,
} from "./message-dispatch-dedupe.js";

const tempDirs: string[] = [];
let previousStateDir: string | undefined;

function createStateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-telegram-dispatch-dedupe-"));
  tempDirs.push(dir);
  return dir;
}

function message(params?: { chatId?: number; messageId?: number }): Message {
  return {
    message_id: params?.messageId ?? 42,
    date: 1736380800,
    chat: { id: params?.chatId ?? 1234, type: "private" },
  } as Message;
}

function storedReplayKey(accountId: string, msg: Message): string {
  const key = buildTelegramMessageDispatchReplayKey(msg);
  if (!key) {
    throw new Error("expected replay key");
  }
  return buildTelegramMessageDispatchAccountReplayKey({ accountId, key });
}

beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = createStateDir();
  resetPluginStateStoreForTests({ closeDatabase: false });
});

afterEach(() => {
  resetPluginStateStoreForTests();
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Telegram message dispatch replay guard", () => {
  it("keys messages by chat id and message id", () => {
    expect(buildTelegramMessageDispatchReplayKey(message())).toBe(
      JSON.stringify(["message", "1234", 42]),
    );
    expect(buildTelegramMessageDispatchReplayKey(message({ messageId: 0 }))).toBeNull();
  });

  it("persists committed dispatches across guard recreation", async () => {
    const writer = createTelegramMessageDispatchReplayGuard();
    const first = await claimTelegramMessageDispatchReplay({
      guard: writer,
      accountId: "default",
      msg: message(),
    });

    expect(first).toEqual({
      kind: "claimed",
      key: storedReplayKey("default", message()),
    });
    if (first.kind !== "claimed") {
      throw new Error("expected initial claim");
    }
    await commitTelegramMessageDispatchReplay({
      guard: writer,
      keys: [first.key],
    });

    const reader = createTelegramMessageDispatchReplayGuard();
    await expect(
      claimTelegramMessageDispatchReplay({
        guard: reader,
        accountId: "default",
        msg: message(),
      }),
    ).resolves.toEqual({ kind: "duplicate" });
  });

  it("preserves concurrent commits", async () => {
    const writer = createTelegramMessageDispatchReplayGuard();
    const keys = Array.from({ length: 400 }, (_, index) =>
      storedReplayKey("default", message({ messageId: index + 1 })),
    );

    await commitTelegramMessageDispatchReplay({
      guard: writer,
      keys,
    });

    const reader = createTelegramMessageDispatchReplayGuard();
    await expect(reader.warmup(TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE)).resolves.toBe(
      keys.length,
    );
  });

  it("uses one persisted namespace across Telegram accounts", async () => {
    const writer = createTelegramMessageDispatchReplayGuard();
    const first = await claimTelegramMessageDispatchReplay({
      guard: writer,
      accountId: "default",
      msg: message(),
    });
    const second = await claimTelegramMessageDispatchReplay({
      guard: writer,
      accountId: "work",
      msg: message(),
    });
    if (first.kind !== "claimed" || second.kind !== "claimed") {
      throw new Error("expected account claims");
    }

    await commitTelegramMessageDispatchReplay({
      guard: writer,
      keys: [first.key, second.key],
    });

    const reader = createTelegramMessageDispatchReplayGuard();
    await expect(reader.warmup(TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE)).resolves.toBe(2);
    await expect(reader.warmup("default")).resolves.toBe(0);
  });

  it("keeps accounts isolated and releases retryable pre-dispatch claims", async () => {
    const guard = createTelegramMessageDispatchReplayGuard();
    const first = await claimTelegramMessageDispatchReplay({
      guard,
      accountId: "default",
      msg: message(),
    });
    if (first.kind !== "claimed") {
      throw new Error("expected initial claim");
    }

    await expect(
      claimTelegramMessageDispatchReplay({
        guard,
        accountId: "work",
        msg: message(),
      }),
    ).resolves.toEqual({
      kind: "claimed",
      key: storedReplayKey("work", message()),
    });

    releaseTelegramMessageDispatchReplay({
      guard,
      keys: [first.key],
    });
    await expect(
      claimTelegramMessageDispatchReplay({
        guard,
        accountId: "default",
        msg: message(),
      }),
    ).resolves.toEqual({
      kind: "claimed",
      key: first.key,
    });
  });

  it("lets an in-flight duplicate retry after the first claim is released", async () => {
    const guard = createTelegramMessageDispatchReplayGuard();
    const first = await claimTelegramMessageDispatchReplay({
      guard,
      accountId: "default",
      msg: message(),
    });
    if (first.kind !== "claimed") {
      throw new Error("expected initial claim");
    }

    const duplicate = claimTelegramMessageDispatchReplay({
      guard,
      accountId: "default",
      msg: message(),
    });
    releaseTelegramMessageDispatchReplay({
      guard,
      keys: [first.key],
      error: new Error("retry"),
    });

    await expect(duplicate).resolves.toEqual({
      kind: "claimed",
      key: first.key,
    });
  });
});
