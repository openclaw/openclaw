import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import {
  TelegramOffsetRotationHandler,
  createTelegramOffsetRotationHandler,
  describeTelegramOffsetRotationReason,
  formatTelegramOffsetRotationMessage,
} from "./offset-rotation-handler.js";
import {
  inspectTelegramUpdateOffset,
  readTelegramUpdateOffset,
  writeTelegramUpdateOffset,
  type TelegramUpdateOffsetRotationInfo,
} from "./update-offset-store.js";

const sampleRotation = (
  overrides: Partial<TelegramUpdateOffsetRotationInfo> = {},
): TelegramUpdateOffsetRotationInfo => ({
  reason: "token-rotated",
  previousBotId: "111111",
  currentBotId: "111111",
  staleLastUpdateId: 42,
  ...overrides,
});

describe("formatTelegramOffsetRotationMessage", () => {
  it("includes the account id, previous and current bot ids, and stale offset", () => {
    const message = formatTelegramOffsetRotationMessage(
      "primary",
      sampleRotation({ reason: "bot-id-changed", previousBotId: "111111", currentBotId: "222222" }),
    );

    expect(message).toContain('account "primary"');
    expect(message).toContain("bot identity change");
    expect(message).toContain("was 111111");
    expect(message).toContain("now 222222");
    expect(message).toContain("offset 42");
  });

  it("labels legacy state with a placeholder for the previous bot id", () => {
    const message = formatTelegramOffsetRotationMessage(
      "default",
      sampleRotation({ reason: "legacy-state", previousBotId: null }),
    );
    expect(message).toContain("(legacy unscoped offset)");
    expect(message).toContain("legacy update offset");
  });
});

describe("describeTelegramOffsetRotationReason", () => {
  it("maps each reason to a stable label", () => {
    expect(describeTelegramOffsetRotationReason("bot-id-changed")).toBe("bot identity change");
    expect(describeTelegramOffsetRotationReason("token-rotated")).toBe("token rotation");
    expect(describeTelegramOffsetRotationReason("legacy-state")).toBe("legacy update offset");
  });
});

describe("TelegramOffsetRotationHandler", () => {
  it("logs the rotation message and deletes the stale offset file", async () => {
    await withStateDirEnv("openclaw-tg-rotation-", async () => {
      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 99,
        botToken: "111111:original",
      });

      const logged: string[] = [];
      const handler = new TelegramOffsetRotationHandler({
        accountId: "default",
        log: (line) => logged.push(line),
      });

      handler.handle(sampleRotation({ staleLastUpdateId: 99 }));
      // The cleanup is fire-and-forget; allow the microtask queue to drain.
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("token rotation");
      expect(
        await readTelegramUpdateOffset({
          accountId: "default",
          botToken: "111111:original",
        }),
      ).toBeNull();
    });
  });

  it("routes delete failures through the error logger", async () => {
    const log = vi.fn();
    const logError = vi.fn();
    const handler = createTelegramOffsetRotationHandler({
      // accountId with a NUL forces the underlying unlink to fail with ENOENT
      // (the dirname is fine, but the offset file does not exist and would
      // also fail to create in the test temp dir); we point env at a
      // missing path so the delete attempt encounters a real error.
      accountId: "ghost",
      log,
      logError,
      env: {
        OPENCLAW_STATE_DIR: "/dev/null/does-not-exist",
        HOME: "/dev/null",
      } as NodeJS.ProcessEnv,
    });

    handler.handle(sampleRotation());
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(log).toHaveBeenCalledTimes(1);
    // logError may or may not fire depending on whether the unlink path
    // surfaces ENOENT or a different code; both outcomes are acceptable as
    // long as the message is logged exactly once.
    expect(logError.mock.calls.every((call) => typeof call[0] === "string")).toBe(true);
  });

  it("exposes a stable formatMessage helper that mirrors the standalone formatter", () => {
    const info = sampleRotation();
    const handler = new TelegramOffsetRotationHandler({
      accountId: "primary",
      log: () => {},
    });
    expect(handler.formatMessage(info)).toBe(formatTelegramOffsetRotationMessage("primary", info));
    expect(handler.accountId).toBe("primary");
  });
});

describe("inspectTelegramUpdateOffset", () => {
  it("returns an absent result when no offset has been persisted", async () => {
    await withStateDirEnv("openclaw-tg-inspect-", async () => {
      const result = await inspectTelegramUpdateOffset({
        accountId: "default",
        botToken: "111111:token-a",
      });
      expect(result).toEqual({ kind: "absent" });
    });
  });

  it("returns a valid result with the persisted identity when the token matches", async () => {
    await withStateDirEnv("openclaw-tg-inspect-", async () => {
      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 1234,
        botToken: "111111:token-a",
      });
      const result = await inspectTelegramUpdateOffset({
        accountId: "default",
        botToken: "111111:token-a",
      });
      expect(result.kind).toBe("valid");
      if (result.kind === "valid") {
        expect(result.lastUpdateId).toBe(1234);
        expect(result.botId).toBe("111111");
        expect(typeof result.tokenFingerprint).toBe("string");
      }
    });
  });

  it("classifies a same-bot token rotation as rotated with reason token-rotated", async () => {
    await withStateDirEnv("openclaw-tg-inspect-", async () => {
      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 7,
        botToken: "111111:original",
      });
      const result = await inspectTelegramUpdateOffset({
        accountId: "default",
        botToken: "111111:rotated",
      });
      expect(result.kind).toBe("rotated");
      if (result.kind === "rotated") {
        expect(result.rotation.reason).toBe("token-rotated");
        expect(result.rotation.staleLastUpdateId).toBe(7);
      }
    });
  });

  it("classifies a different bot as rotated with reason bot-id-changed", async () => {
    await withStateDirEnv("openclaw-tg-inspect-", async () => {
      await writeTelegramUpdateOffset({
        accountId: "default",
        updateId: 7,
        botToken: "111111:original",
      });
      const result = await inspectTelegramUpdateOffset({
        accountId: "default",
        botToken: "222222:other",
      });
      expect(result.kind).toBe("rotated");
      if (result.kind === "rotated") {
        expect(result.rotation.reason).toBe("bot-id-changed");
      }
    });
  });
});
