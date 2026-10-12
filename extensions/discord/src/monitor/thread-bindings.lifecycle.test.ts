import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginStateSyncKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import {
  bindTestThread,
  createTestThreadBindingManager,
  hoisted,
  installThreadBindingLifecycleTestHooks,
} from "./thread-bindings.lifecycle.test-support.js";
import { resetThreadBindingsForTests } from "./thread-bindings.test-support.js";

const {
  setThreadBindingIdleTimeoutBySessionKeyAsync,
  setThreadBindingMaxAgeBySessionKeyAsync,
  unbindThreadBindingsBySessionKey,
} = await import("./thread-bindings.lifecycle.js");
const { resolveThreadBindingInactivityExpiresAt, resolveThreadBindingMaxAgeExpiresAt } =
  await import("./thread-bindings.state.js");
const target = { accountId: "default", targetSessionKey: "agent:main:subagent:child" };

describe("thread binding lifecycle", () => {
  installThreadBindingLifecycleTestHooks();

  it("ignores a stale sweep result after rebinding", async () => {
    vi.useFakeTimers();
    const probe = createDeferred<void>();
    const manager = await createTestThreadBindingManager({ enableSweeper: true });
    try {
      await bindTestThread(manager);
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
      expect(hoisted.restGet).toHaveBeenCalledOnce();
      await bindTestThread(manager, { targetSessionKey: "agent:main:subagent:replacement" });
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
  });

  it.each([{ idleTimeoutMs: 0, maxAgeMs: 60_000, farewell: "max age of 1m" }])(
    "expires bindings without probing ($farewell)",
    async ({ idleTimeoutMs, maxAgeMs, farewell }) => {
      vi.useFakeTimers();
      try {
        const manager = await createTestThreadBindingManager({
          enableSweeper: true,
          idleTimeoutMs,
          maxAgeMs,
        });
        expect(await bindTestThread(manager, { introText: "intro" })).toMatchObject({
          threadId: "thread-1",
          targetSessionKey: target.targetSessionKey,
        });
        hoisted.sendMessageDiscord.mockClear();
        hoisted.sendWebhookMessageDiscord.mockClear();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(manager.getByThreadId("thread-1")).toBeUndefined();
        expect(hoisted.restGet).not.toHaveBeenCalled();
        expect(hoisted.sendWebhookMessageDiscord).not.toHaveBeenCalled();
        expect(hoisted.sendMessageDiscord).toHaveBeenCalledOnce();
        expect(hoisted.sendMessageDiscord.mock.calls[0]?.[1]).toContain(farewell);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { error: new Error("ECONNRESET"), keeps: true },
    { error: { status: 404, rawError: { code: 10003, message: "Unknown Channel" } }, keeps: false },
  ])(
    "retains a binding only for transient probe failures (keeps=$keeps)",
    async ({ error, keeps }) => {
      vi.useFakeTimers();
      try {
        const manager = await createTestThreadBindingManager({ enableSweeper: true });
        const binding = await bindTestThread(manager);
        hoisted.restGet.mockRejectedValueOnce(error);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(manager.getByThreadId("thread-1")).toEqual(keeps ? binding : undefined);
        expect(hoisted.sendWebhookMessageDiscord).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("preserves explicitly updated lifecycle windows when rebinding", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-20T10:00:00.000Z"));
      const manager = await createTestThreadBindingManager();
      await bindTestThread(manager);
      const idle = await setThreadBindingIdleTimeoutBySessionKeyAsync({
        ...target,
        idleTimeoutMs: 2 * 60 * 60 * 1000,
      });
      const age = await setThreadBindingMaxAgeBySessionKeyAsync({
        ...target,
        maxAgeMs: 3 * 60 * 60 * 1000,
      });
      expect(idle).toHaveLength(1);
      expect(age).toHaveLength(1);
      vi.setSystemTime(new Date("2026-02-20T10:30:00.000Z"));
      const rebound = await bindTestThread(manager, { agentId: undefined });
      expect(rebound).toMatchObject({
        idleTimeoutMs: 2 * 60 * 60 * 1000,
        maxAgeMs: 3 * 60 * 60 * 1000,
      });
      const record = manager.getByThreadId("thread-1")!;
      expect(record).toEqual(rebound);
      expect(
        resolveThreadBindingInactivityExpiresAt({
          record,
          defaultIdleTimeoutMs: manager.getIdleTimeoutMs(),
        }),
      ).toBe(new Date("2026-02-20T12:30:00.000Z").getTime());
      expect(
        resolveThreadBindingMaxAgeExpiresAt({ record, defaultMaxAgeMs: manager.getMaxAgeMs() }),
      ).toBe(new Date("2026-02-20T13:30:00.000Z").getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("rechecks activity touched during the same sweep pass", async () => {
    vi.useFakeTimers();
    try {
      const manager = await createTestThreadBindingManager({
        enableSweeper: true,
        idleTimeoutMs: 60_000,
      });
      await bindTestThread(manager);
      await bindTestThread(manager, {
        threadId: "thread-2",
        targetSessionKey: "agent:main:subagent:second",
        webhookId: "wh-2",
        webhookToken: "tok-2",
      });
      expect(
        await setThreadBindingIdleTimeoutBySessionKeyAsync({ ...target, idleTimeoutMs: 0 }),
      ).toHaveLength(1);
      hoisted.restGet.mockImplementation(async (...args: unknown[]) => {
        const route = typeof args[0] === "string" ? args[0] : "";
        if (route.includes("thread-1")) {
          await manager.touchThread({ threadId: "thread-2", persist: false });
        }
        return { id: route.split("/").at(-1) ?? "thread-1", type: 11, parent_id: "parent-1" };
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(manager.getByThreadId("thread-1")).toMatchObject({ idleTimeoutMs: 0 });
      expect(manager.getByThreadId("thread-2")).toMatchObject({
        threadId: "thread-2",
        targetSessionKey: "agent:main:subagent:second",
      });
      expect(hoisted.sendMessageDiscord).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists unbinds even when no manager is active", async () => {
    await withOpenClawTestState({ label: "discord-unbind-without-manager" }, async () => {
      await resetThreadBindingsForTests();
      const store = createPluginStateSyncKeyedStoreForTests("discord", {
        namespace: "thread-bindings",
        maxEntries: 10_000,
      });
      store.register("default:thread-1", {
        ...target,
        channelId: "parent-1",
        threadId: "thread-1",
        targetKind: "subagent",
        agentId: "main",
        boundBy: "system",
        boundAt: 100,
        lastActivityAt: 100,
        idleTimeoutMs: 60_000,
        maxAgeMs: 0,
      });
      try {
        expect(
          unbindThreadBindingsBySessionKey({ targetSessionKey: target.targetSessionKey }),
        ).toHaveLength(1);
        expect(store.entries()).toStrictEqual([]);
      } finally {
        await resetThreadBindingsForTests();
      }
    });
  });
});
