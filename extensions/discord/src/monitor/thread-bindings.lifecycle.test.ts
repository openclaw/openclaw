import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginStateSyncKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordError } from "../internal/rest.js";
import {
  bindTestThread,
  createTestThreadBindingManager,
  hoisted,
  installThreadBindingLifecycleTestHooks,
} from "./thread-bindings.lifecycle.test-support.js";
import { resetThreadBindingsForTests } from "./thread-bindings.test-support.js";

const {
  setThreadBindingIdleTimeoutBySessionKeyAsync: setIdle,
  setThreadBindingMaxAgeBySessionKeyAsync: setAge,
  unbindThreadBindingsBySessionKey: unbind,
} = await import("./thread-bindings.lifecycle.js");
const {
  resolveThreadBindingInactivityExpiresAt: idleExpiry,
  resolveThreadBindingMaxAgeExpiresAt: ageExpiry,
} = await import("./thread-bindings.state.js");
const target = { accountId: "default", targetSessionKey: "agent:main:subagent:child" };

installThreadBindingLifecycleTestHooks();

describe("thread binding clock-controlled lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ignores a stale sweep result after rebinding", async () => {
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
    }
  });

  it.each(["max-age", "transient", "missing", "forbidden", "unknown-channel"] as const)(
    "sweeps bindings at %s",
    async (reason) => {
      const expires = reason === "max-age";
      const manager = await createTestThreadBindingManager({
        enableSweeper: true,
        ...(expires ? { idleTimeoutMs: 0, maxAgeMs: 60_000 } : {}),
      });
      const binding = await bindTestThread(manager, expires ? { introText: "intro" } : {});
      if (expires) {
        expect(binding).toMatchObject({
          threadId: "thread-1",
          targetSessionKey: target.targetSessionKey,
        });
        hoisted.sendMessageDiscord.mockClear();
        hoisted.sendWebhookMessageDiscord.mockClear();
      } else {
        hoisted.restGet.mockRejectedValueOnce(
          reason === "transient"
            ? new Error("ECONNRESET")
            : new DiscordError(
                new Response(null, {
                  status: reason === "forbidden" ? 403 : reason === "unknown-channel" ? 400 : 404,
                }),
                {
                  code: reason === "unknown-channel" ? "10003" : undefined,
                  message: "Unknown Channel",
                },
              ),
        );
      }
      await vi.advanceTimersByTimeAsync(120_000);
      expect(manager.getByThreadId("thread-1")).toEqual(
        reason === "transient" ? binding : undefined,
      );
      expect(hoisted.sendWebhookMessageDiscord).not.toHaveBeenCalled();
      if (expires) {
        expect(hoisted.restGet).not.toHaveBeenCalled();
        expect(hoisted.sendMessageDiscord).toHaveBeenCalledOnce();
        expect(hoisted.sendMessageDiscord.mock.calls[0]?.[1]).toContain("max age of 1m");
      }
    },
  );

  it("preserves explicitly updated lifecycle windows when rebinding", async () => {
    vi.setSystemTime(new Date("2026-02-20T10:00:00.000Z"));
    const manager = await createTestThreadBindingManager();
    await bindTestThread(manager);
    const idleTimeoutMs = 2 * 60 * 60 * 1000;
    const maxAgeMs = 3 * 60 * 60 * 1000;
    const idle = await setIdle({ ...target, idleTimeoutMs });
    const age = await setAge({ ...target, maxAgeMs });
    expect([idle.length, age.length]).toEqual([1, 1]);
    vi.setSystemTime(new Date("2026-02-20T10:30:00.000Z"));
    const rebound = await bindTestThread(manager, { agentId: undefined });
    expect(rebound).toMatchObject({ idleTimeoutMs, maxAgeMs });
    const record = manager.getByThreadId("thread-1")!;
    expect(record).toEqual(rebound);
    expect([
      idleExpiry({ record, defaultIdleTimeoutMs: manager.getIdleTimeoutMs() }),
      ageExpiry({ record, defaultMaxAgeMs: manager.getMaxAgeMs() }),
    ]).toEqual([Date.parse("2026-02-20T12:30:00.000Z"), Date.parse("2026-02-20T13:30:00.000Z")]);
  });

  it("rechecks activity touched during the same sweep pass", async () => {
    const manager = await createTestThreadBindingManager({
      enableSweeper: true,
      idleTimeoutMs: 60_000,
    });
    await bindTestThread(manager);
    await bindTestThread(manager, {
      threadId: "thread-2",
      targetSessionKey: "agent:main:subagent:second",
    });
    expect(await setIdle({ ...target, idleTimeoutMs: 0 })).toHaveLength(1);
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
  });
});

it("persists unbinds even when no manager is active", async () => {
  await withOpenClawTestState({ label: "discord-unbind-without-manager" }, async () => {
    const store = createPluginStateSyncKeyedStoreForTests("discord", {
      namespace: "thread-bindings",
      maxEntries: 10_000,
    });
    store.register("default:thread-1", { ...target, channelId: "parent-1", threadId: "thread-1" });
    try {
      expect(unbind({ targetSessionKey: target.targetSessionKey })).toHaveLength(1);
      expect(store.entries()).toStrictEqual([]);
    } finally {
      await resetThreadBindingsForTests();
    }
  });
});
