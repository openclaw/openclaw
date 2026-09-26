import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginStateSyncKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import {
  createNonSweepingTestManager,
  createTestThreadBindingManager,
  expectFields,
  hoisted,
  installThreadBindingLifecycleTestHooks,
  mockCallArg,
  requireBinding,
} from "./thread-bindings.lifecycle.test-support.js";
import { resetThreadBindingsForTests } from "./thread-bindings.test-support.js";

const {
  setThreadBindingIdleTimeoutBySessionKeyAsync,
  setThreadBindingMaxAgeBySessionKeyAsync,
  unbindThreadBindingsBySessionKey,
} = await import("./thread-bindings.lifecycle.js");
const { resolveThreadBindingInactivityExpiresAt, resolveThreadBindingMaxAgeExpiresAt } =
  await import("./thread-bindings.state.js");

describe("thread binding lifecycle", () => {
  installThreadBindingLifecycleTestHooks();

  const createDefaultSweeperManager = () =>
    createTestThreadBindingManager({
      enableSweeper: true,
    });

  const bindDefaultThreadTarget = async (
    manager: Awaited<ReturnType<typeof createTestThreadBindingManager>>,
  ) => {
    await manager.bindTarget({
      threadId: "thread-1",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      agentId: "main",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });
  };

  it.each([false, true])(
    "ignores stale sweep results after rebinding (restart=%s)",
    async (restart) => {
      vi.useFakeTimers();
      const probe = createDeferred<void>();
      let manager = await createDefaultSweeperManager();
      try {
        await bindDefaultThreadTarget(manager);
        hoisted.restGet.mockImplementationOnce(async () => {
          await probe.promise;
          return {
            id: "thread-1",
            type: 11,
            parent_id: "parent-1",
            thread_metadata: { archived: true },
          };
        });
        await vi.advanceTimersByTimeAsync(120_000);
        expect(hoisted.restGet).toHaveBeenCalledTimes(1);

        if (restart) {
          const stopped = manager.stop();
          probe.resolve();
          await stopped;
          manager = await createDefaultSweeperManager();
        }
        await manager.bindTarget({
          threadId: "thread-1",
          channelId: "parent-1",
          targetKind: "subagent",
          targetSessionKey: "agent:main:subagent:replacement",
          agentId: "main",
          webhookId: "wh-1",
          webhookToken: "tok-1",
        });
        probe.resolve();
        await vi.advanceTimersByTimeAsync(0);

        expect(manager.getByThreadId("thread-1")?.targetSessionKey).toBe(
          "agent:main:subagent:replacement",
        );
        expect(hoisted.sendMessageDiscord).not.toHaveBeenCalled();
      } finally {
        probe.resolve();
        await manager.stop();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    {
      name: "auto-unbinds idle-expired bindings and sends inactivity message",
      idleTimeoutMs: 60_000,
      maxAgeMs: 0,
      introText: "intro",
      farewellText: "after 1m of inactivity",
      expectNoProbe: true,
    },
    {
      name: "auto-unbinds max-age-expired bindings and sends max-age message",
      idleTimeoutMs: 0,
      maxAgeMs: 60_000,
      farewellText: "max age of 1m",
      expectNoProbe: false,
    },
  ])("$name", async ({ idleTimeoutMs, maxAgeMs, introText, farewellText, expectNoProbe }) => {
    vi.useFakeTimers();
    try {
      const manager = await createTestThreadBindingManager({
        accountId: "default",
        cfg: EMPTY_DISCORD_TEST_CONFIG,
        persist: false,
        enableSweeper: true,
        idleTimeoutMs,
        maxAgeMs,
      });

      const binding = await manager.bindTarget({
        threadId: "thread-1",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        agentId: "main",
        webhookId: "wh-1",
        webhookToken: "tok-1",
        ...(introText ? { introText } : {}),
      });
      expectFields(binding, "binding", {
        threadId: "thread-1",
        targetSessionKey: "agent:main:subagent:child",
      });
      hoisted.sendMessageDiscord.mockClear();
      hoisted.sendWebhookMessageDiscord.mockClear();

      await vi.advanceTimersByTimeAsync(120_000);

      expect(manager.getByThreadId("thread-1")).toBeUndefined();
      if (expectNoProbe) {
        expect(hoisted.restGet).not.toHaveBeenCalled();
      }
      expect(hoisted.sendWebhookMessageDiscord).not.toHaveBeenCalled();
      expect(hoisted.sendMessageDiscord).toHaveBeenCalledTimes(1);
      const farewell = mockCallArg(hoisted.sendMessageDiscord, 0, 1, "sendMessageDiscord") as
        | string
        | undefined;
      expect(farewell).toContain(farewellText);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each<{
    name: string;
    probeError: unknown;
    keepsBinding: boolean;
  }>([
    {
      name: "keeps binding when thread sweep probe fails transiently",
      probeError: new Error("ECONNRESET"),
      keepsBinding: true,
    },
    {
      name: "unbinds when thread sweep probe reports unknown channel",
      probeError: { status: 404, rawError: { code: 10003, message: "Unknown Channel" } },
      keepsBinding: false,
    },
  ])("$name", async ({ probeError, keepsBinding }) => {
    vi.useFakeTimers();
    try {
      const manager = await createDefaultSweeperManager();
      await bindDefaultThreadTarget(manager);

      hoisted.restGet.mockRejectedValueOnce(probeError);

      await vi.advanceTimersByTimeAsync(120_000);

      if (keepsBinding) {
        expectFields(requireBinding(manager, "thread-1"), "thread binding", {
          threadId: "thread-1",
          targetSessionKey: "agent:main:subagent:child",
          webhookId: "wh-1",
          webhookToken: "tok-1",
        });
      } else {
        expect(manager.getByThreadId("thread-1")).toBeUndefined();
      }
      expect(hoisted.sendWebhookMessageDiscord).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates idle timeout by target session key", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-20T23:00:00.000Z"));
      const manager = await createNonSweepingTestManager({
        accountId: "default",
      });

      await bindDefaultThreadTarget(manager);

      const boundAt = manager.getByThreadId("thread-1")?.boundAt;
      vi.setSystemTime(new Date("2026-02-20T23:15:00.000Z"));

      const updated = await setThreadBindingIdleTimeoutBySessionKeyAsync({
        accountId: "default",
        targetSessionKey: "agent:main:subagent:child",
        idleTimeoutMs: 2 * 60 * 60 * 1000,
      });

      expect(updated).toHaveLength(1);
      const updatedBinding = expectDefined(updated[0], "idle-timeout thread binding");
      expect(updated[0]?.lastActivityAt).toBe(new Date("2026-02-20T23:15:00.000Z").getTime());
      expect(updated[0]?.boundAt).toBe(boundAt);
      expect(
        resolveThreadBindingInactivityExpiresAt({
          record: updatedBinding,
          defaultIdleTimeoutMs: manager.getIdleTimeoutMs(),
        }),
      ).toBe(new Date("2026-02-21T01:15:00.000Z").getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates max age by target session key", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-20T10:00:00.000Z"));
      const manager = await createNonSweepingTestManager({
        accountId: "default",
      });

      await manager.bindTarget({
        threadId: "thread-1",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        agentId: "main",
      });

      vi.setSystemTime(new Date("2026-02-20T10:30:00.000Z"));
      const updated = await setThreadBindingMaxAgeBySessionKeyAsync({
        accountId: "default",
        targetSessionKey: "agent:main:subagent:child",
        maxAgeMs: 3 * 60 * 60 * 1000,
      });

      expect(updated).toHaveLength(1);
      const updatedBinding = expectDefined(updated[0], "max-age thread binding");
      expect(updated[0]?.boundAt).toBe(new Date("2026-02-20T10:30:00.000Z").getTime());
      expect(updated[0]?.lastActivityAt).toBe(new Date("2026-02-20T10:30:00.000Z").getTime());
      expect(
        resolveThreadBindingMaxAgeExpiresAt({
          record: updatedBinding,
          defaultMaxAgeMs: manager.getMaxAgeMs(),
        }),
      ).toBe(new Date("2026-02-20T13:30:00.000Z").getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves explicit lifecycle windows when rebinding the same thread", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-20T10:00:00.000Z"));
      const manager = await createNonSweepingTestManager({
        accountId: "default",
      });

      await bindDefaultThreadTarget(manager);

      await setThreadBindingIdleTimeoutBySessionKeyAsync({
        accountId: "default",
        targetSessionKey: "agent:main:subagent:child",
        idleTimeoutMs: 2 * 60 * 60 * 1000,
      });
      await setThreadBindingMaxAgeBySessionKeyAsync({
        accountId: "default",
        targetSessionKey: "agent:main:subagent:child",
        maxAgeMs: 3 * 60 * 60 * 1000,
      });

      vi.setSystemTime(new Date("2026-02-20T10:30:00.000Z"));
      const rebound = await manager.bindTarget({
        threadId: "thread-1",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        webhookId: "wh-1",
        webhookToken: "tok-1",
      });

      expectFields(rebound, "rebound binding", {
        idleTimeoutMs: 2 * 60 * 60 * 1000,
        maxAgeMs: 3 * 60 * 60 * 1000,
      });
      expectFields(requireBinding(manager, "thread-1"), "thread binding", {
        idleTimeoutMs: 2 * 60 * 60 * 1000,
        maxAgeMs: 3 * 60 * 60 * 1000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps binding when idle timeout is disabled per session key", async () => {
    vi.useFakeTimers();
    try {
      const manager = await createTestThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: true,
        idleTimeoutMs: 60_000,
      });

      await bindDefaultThreadTarget(manager);

      const updated = await setThreadBindingIdleTimeoutBySessionKeyAsync({
        accountId: "default",
        targetSessionKey: "agent:main:subagent:child",
        idleTimeoutMs: 0,
      });
      expect(updated).toHaveLength(1);
      expect(updated[0]?.idleTimeoutMs).toBe(0);

      await vi.advanceTimersByTimeAsync(240_000);

      expectFields(requireBinding(manager, "thread-1"), "thread binding", {
        threadId: "thread-1",
        targetSessionKey: "agent:main:subagent:child",
        idleTimeoutMs: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a binding when activity is touched during the same sweep pass", async () => {
    vi.useFakeTimers();
    try {
      const manager = await createTestThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: true,
        idleTimeoutMs: 60_000,
      });

      await manager.bindTarget({
        threadId: "thread-1",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:first",
        agentId: "main",
        webhookId: "wh-1",
        webhookToken: "tok-1",
      });
      await manager.bindTarget({
        threadId: "thread-2",
        channelId: "parent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:second",
        agentId: "main",
        webhookId: "wh-2",
        webhookToken: "tok-2",
      });

      // Keep the first binding off the idle-expire path so the sweep performs
      // an awaited probe and gives a window for in-pass touches.
      await setThreadBindingIdleTimeoutBySessionKeyAsync({
        accountId: "default",
        targetSessionKey: "agent:main:subagent:first",
        idleTimeoutMs: 0,
      });

      hoisted.restGet.mockImplementation(async (...args: unknown[]) => {
        const route = typeof args[0] === "string" ? args[0] : "";
        if (route.includes("thread-1")) {
          await manager.touchThread({ threadId: "thread-2", persist: false });
        }
        return {
          id: route.split("/").at(-1) ?? "thread-1",
          type: 11,
          parent_id: "parent-1",
        };
      });
      hoisted.sendMessageDiscord.mockClear();

      await vi.advanceTimersByTimeAsync(120_000);

      expectFields(requireBinding(manager, "thread-2"), "thread binding", {
        threadId: "thread-2",
        targetSessionKey: "agent:main:subagent:second",
      });
      expect(hoisted.sendMessageDiscord).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists touched activity timestamps across restart when persistence is enabled", async () => {
    vi.useFakeTimers();
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-thread-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      await resetThreadBindingsForTests();
      vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));
      const manager = await createTestThreadBindingManager({
        accountId: "default",
        persist: true,
        idleTimeoutMs: 60_000,
      });

      await bindDefaultThreadTarget(manager);

      const touchedAt = new Date("2026-02-20T00:00:30.000Z").getTime();
      vi.setSystemTime(touchedAt);
      await manager.touchThread({ threadId: "thread-1" });

      await resetThreadBindingsForTests();
      const reloaded = await createTestThreadBindingManager({
        accountId: "default",
        persist: true,
        idleTimeoutMs: 60_000,
      });

      const record = requireBinding(reloaded, "thread-1");
      expect(record.lastActivityAt).toBe(touchedAt);
      expect(
        resolveThreadBindingInactivityExpiresAt({
          record,
          defaultIdleTimeoutMs: reloaded.getIdleTimeoutMs(),
        }),
      ).toBe(new Date("2026-02-20T00:01:30.000Z").getTime());
    } finally {
      await resetThreadBindingsForTests();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("persists unbinds even when no manager is active", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-thread-bindings-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      await resetThreadBindingsForTests();
      const now = Date.now();
      const store = createPluginStateSyncKeyedStoreForTests("discord", {
        namespace: "thread-bindings",
        maxEntries: 10_000,
      });
      store.register("default:thread-1", {
        accountId: "default",
        channelId: "parent-1",
        threadId: "thread-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        agentId: "main",
        boundBy: "system",
        boundAt: now,
        lastActivityAt: now,
        idleTimeoutMs: 60_000,
        maxAgeMs: 0,
      });

      const removed = unbindThreadBindingsBySessionKey({
        targetSessionKey: "agent:main:subagent:child",
      });
      expect(removed).toHaveLength(1);
      expect(store.entries()).toStrictEqual([]);
    } finally {
      await resetThreadBindingsForTests();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
