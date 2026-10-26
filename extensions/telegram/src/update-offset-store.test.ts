import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { useTelegramKeyedState } from "./keyed-state.test-support.js";
import {
  deleteTelegramUpdateOffset,
  prepareTelegramAccount,
  readTelegramUpdateOffset,
  writeTelegramUpdateOffset,
  type TelegramAccountRotationInfo,
} from "./update-offset-store.js";

describe("deleteTelegramUpdateOffset", () => {
  const fixture = useTelegramKeyedState<unknown>({
    namespace: "telegram.update-offsets",
    maxEntries: 1_000,
  });
  const writeOffset = (updateId: number, botToken?: string) =>
    writeTelegramUpdateOffset({ accountId: "default", updateId, botToken });
  const state = (lastUpdateId: unknown, botId: string | null) => ({
    version: 3,
    lastUpdateId,
    botId,
    tokenFingerprint: null,
  });

  async function expectRotation(botToken: string, expected: TelegramAccountRotationInfo) {
    const onRotationDetected = vi.fn();
    const offset = await readTelegramUpdateOffset({
      accountId: "default",
      botToken,
      onRotationDetected,
    });
    expect(offset).toBeNull();
    expect(onRotationDetected.mock.calls).toEqual([[expected]]);
  }

  it("only removes the targeted account offset, leaving others intact", async () => {
    await writeTelegramUpdateOffset({ accountId: "default", updateId: 100 });
    await writeTelegramUpdateOffset({ accountId: "alerts", updateId: 200 });

    await deleteTelegramUpdateOffset({ accountId: "default" });

    expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();
    expect(await readTelegramUpdateOffset({ accountId: "alerts" })).toBe(200);
  });

  it("surfaces plugin-state write failures", async () => {
    fixture.install({
      ...fixture.open(),
      async register() {
        throw new Error("store write failed");
      },
    });

    await expect(writeOffset(808)).rejects.toThrow("store write failed");
  });

  it.each([
    ["bot-id-changed", "111111:token-a", "222222:token-b", 1500, "111111", "222222"],
    ["legacy-state", state(777, null), "333333:token-c", 777, null, "333333"],
    ["legacy-state", state(999, "111111"), "111111:any-secret", 999, "111111", "111111"],
    ["token-rotated", "111111:original-secret", "111111:rotated-secret", 42, "111111", "111111"],
  ] as const)(
    "detects %s from %j",
    async (reason, previous, token, id, previousBotId, currentBotId) => {
      if (typeof previous === "string") {
        await writeOffset(id, previous);
        expect(await readTelegramUpdateOffset({ botToken: previous })).toBe(id);
      } else {
        await fixture.store.register("default", previous);
      }
      await expectRotation(token, { reason, previousBotId, currentBotId, staleLastUpdateId: id });
    },
  );

  it("tolerates read-only lookup failures but refuses account preparation without identity", async () => {
    fixture.install({
      ...fixture.open(),
      async lookup() {
        throw new Error("store unavailable");
      },
    });

    expect(await readTelegramUpdateOffset({ accountId: "primary" })).toBeNull();
    await expect(
      prepareTelegramAccount({
        accountId: "primary",
        botToken: "111111:fixture",
        onRotationDetected: () => {},
      }),
    ).rejects.toThrow(/account "primary".*restart.*store unavailable/);
  });

  it("awaits rotation cleanup before returning", async () => {
    await writeOffset(42, "111111:original");

    let cleaned = false;
    const offset = await readTelegramUpdateOffset({
      accountId: "default",
      botToken: "111111:rotated",
      onRotationDetected: async () => {
        await setImmediate();
        cleaned = true;
      },
    });

    expect(offset).toBeNull();
    expect(cleaned).toBe(true);
  });

  it("ignores invalid persisted update IDs from plugin-state", async () => {
    await fixture.store.register("default", state(-1, "111111"));
    expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();

    await fixture.store.register("default", state("not-a-number", "111111"));
    expect(await readTelegramUpdateOffset({ accountId: "default" })).toBeNull();
  });

  it.each([1, 2])("requires Doctor before reading or preparing a v%s offset", async (version) => {
    const original = {
      version,
      lastUpdateId: 777,
      ...(version === 2 ? { botId: "111111" } : {}),
    };
    await fixture.store.register("default", original);
    await expect(readTelegramUpdateOffset({})).rejects.toThrow("openclaw doctor --fix");
    await expect(
      prepareTelegramAccount({
        accountId: "default",
        botToken: "222222:fixture",
        onRotationDetected() {},
      }),
    ).rejects.toThrow("openclaw doctor --fix");
    expect(await fixture.store.lookup("default")).toEqual(original);
  });

  it("rejects writing invalid update IDs", async () => {
    await expect(writeOffset(-1)).rejects.toThrow(/non-negative safe integer/i);
  });
});
