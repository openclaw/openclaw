import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Message } from "grammy/types";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createChannelReplayGuard,
  type ChannelReplayClaimHandle,
} from "openclaw/plugin-sdk/persistent-dedupe";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimTelegramMessageDispatchReplay,
  commitTelegramMessageDispatchReplay,
  createTelegramMessageDispatchReplayGuard,
  releaseTelegramMessageDispatchReplay,
} from "./message-dispatch-dedupe.js";

type TelegramMessageDispatchReplayGuard = Parameters<
  typeof claimTelegramMessageDispatchReplay
>[0]["guard"];

let stateDir: string;
const DEFAULT_BOT_USER_ID = 99;
const CURRENT_NAMESPACE = "global";

function message(params?: { chatId?: number; messageId?: number }): Message {
  return {
    message_id: params?.messageId ?? 42,
    date: 1736380800,
    chat: { id: params?.chatId ?? 1234, type: "private" },
  } as Message;
}

function claimReplay(
  guard: TelegramMessageDispatchReplayGuard,
  accountId = "default",
  botUserId = DEFAULT_BOT_USER_ID,
) {
  return claimTelegramMessageDispatchReplay({ guard, accountId, botUserId, msg: message() });
}

async function claimed(
  guard: TelegramMessageDispatchReplayGuard,
  accountId = "default",
  botUserId = DEFAULT_BOT_USER_ID,
) {
  const result = await claimReplay(guard, accountId, botUserId);
  assert(result.kind === "claimed", "expected a fresh claim");
  return result.handle;
}

function createLegacyReplayGuard() {
  return createChannelReplayGuard<{ accountId: string; msg: Message }>({
    dedupe: {
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      memoryMaxSize: 50_000,
      pluginId: "telegram-message-dispatch-dedupe",
      namespacePrefix: "telegram.message-dispatch-dedupe",
      stateMaxEntries: 50_000,
    },
    buildReplayKey: ({ accountId, msg }) =>
      JSON.stringify([
        "account",
        accountId,
        JSON.stringify(["message", String(msg.chat.id), msg.message_id]),
      ]),
    namespace: () => CURRENT_NAMESPACE,
  });
}

function createTestReplayGuard(
  forget: TelegramMessageDispatchReplayGuard["forget"] = async () => true,
): TelegramMessageDispatchReplayGuard {
  return {
    claim: async () => ({ kind: "invalid" }),
    forget,
    warmup: async () => 0,
  };
}

function createTestClaim(
  key: string,
  overrides: Partial<ChannelReplayClaimHandle>,
): ChannelReplayClaimHandle {
  return {
    keys: [key],
    commit: async () => true,
    release: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-telegram-dispatch-dedupe-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  resetPluginStateStoreForTests({ closeDatabase: false });
});

afterEach(() => {
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("Telegram message dispatch replay guard", () => {
  it("isolates identical message coordinates across bot identities", async () => {
    const writer = createTelegramMessageDispatchReplayGuard();
    await (await claimed(writer, "default", 101)).commit();
    await (await claimed(writer, "default", 202)).commit();

    const reader = createTelegramMessageDispatchReplayGuard();
    for (const botUserId of [101, 202]) {
      await expect(claimReplay(reader, "default", botUserId)).resolves.toEqual({
        kind: "duplicate",
      });
    }
  });

  it("starts a fresh dedupe window when legacy rows lack bot identity", async () => {
    const legacy = createLegacyReplayGuard();
    const legacyClaim = await legacy.claim({ accountId: "default", msg: message() });
    assert(legacyClaim.kind === "claimed", "expected legacy claim");
    await legacyClaim.handle.commit();

    const current = createTelegramMessageDispatchReplayGuard();
    (await claimed(current)).release();
  });

  it("commits replay keys serially before starting the next write", async () => {
    const events: string[] = [];
    const firstGate = createDeferred<void>();
    const secondGate = createDeferred<void>();
    const secondStarted = createDeferred<void>();
    const guard = createTestReplayGuard();
    const claims = ["first", "second", "third"].map((key) =>
      createTestClaim(key, {
        commit: async () => {
          events.push(`start:${key}`);
          if (key === "first") {
            await firstGate.promise;
          } else if (key === "second") {
            secondStarted.resolve();
            await secondGate.promise;
          }
          events.push(`finish:${key}`);
          return true;
        },
      }),
    );

    const commit = commitTelegramMessageDispatchReplay({ guard, claims });

    expect(events).toEqual(["start:first"]);
    firstGate.resolve();
    await secondStarted.promise;
    expect(events).toEqual(["start:first", "finish:first", "start:second"]);

    secondGate.resolve();
    await commit;
    expect(events).toEqual([
      "start:first",
      "finish:first",
      "start:second",
      "finish:second",
      "start:third",
      "finish:third",
    ]);
  });

  it("rolls back partial multi-key commits after a later disk failure", async () => {
    const diskError = new Error("second key was not persisted");
    const committed = new Set<string>();
    const commitCalls: string[] = [];
    const forgetCalls: string[] = [];
    const releaseCalls: string[] = [];
    const guard = createTestReplayGuard(async (event) => {
      assert("keys" in event && event.keys?.[0]);
      forgetCalls.push(event.keys[0]);
      committed.delete(event.keys[0]);
      return true;
    });
    const keys = ["first", "second", "third"];
    const claims = keys.map((key) =>
      createTestClaim(key, {
        commit: async (options) => {
          commitCalls.push(key);
          committed.add(key);
          if (key === "second") {
            options?.onDiskError?.(diskError);
          }
          return true;
        },
        release: () => {
          releaseCalls.push(key);
        },
      }),
    );

    await expect(
      commitTelegramMessageDispatchReplay({ guard, claims, requirePersistent: true }),
    ).rejects.toBe(diskError);

    expect(commitCalls).toEqual(["first", "second"]);
    expect(forgetCalls).toEqual(["first", "second"]);
    expect(releaseCalls).toEqual(["third"]);
    expect([...committed]).toEqual([]);
  });

  it("uses one persisted namespace across Telegram accounts", async () => {
    const writer = createTelegramMessageDispatchReplayGuard();
    const claims = [await claimed(writer), await claimed(writer, "work")];
    await commitTelegramMessageDispatchReplay({ guard: writer, claims });

    const reader = createTelegramMessageDispatchReplayGuard();
    await expect(reader.warmup(CURRENT_NAMESPACE)).resolves.toBe(2);
    await expect(reader.warmup("default")).resolves.toBe(0);
    for (const accountId of ["default", "work"]) {
      await expect(claimReplay(reader, accountId)).resolves.toMatchObject({ kind: "duplicate" });
    }
  });

  it("keeps accounts isolated and releases retryable pre-dispatch claims", async () => {
    const guard = createTelegramMessageDispatchReplayGuard();
    const first = await claimed(guard);
    await claimed(guard, "work");
    releaseTelegramMessageDispatchReplay({ claims: [first] });
    await claimed(guard);
  });

  it("lets an in-flight duplicate retry after the first claim is released", async () => {
    const guard = createTelegramMessageDispatchReplayGuard();
    const first = await claimed(guard);
    const duplicate = claimReplay(guard);
    releaseTelegramMessageDispatchReplay({ claims: [first], error: new Error("retry") });

    const retry = await duplicate;
    assert(retry.kind === "claimed");
    expect(retry.handle.keys).toEqual(first.keys);
  });
});
