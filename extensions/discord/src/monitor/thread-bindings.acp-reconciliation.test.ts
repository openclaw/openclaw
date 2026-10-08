import assert from "node:assert/strict";
import {
  IncognitoSessionEndedError,
  rethrowIncognitoSessionError,
} from "openclaw/plugin-sdk/acp-runtime";
import { describe, expect, it, vi } from "vitest";
import { getDiscordRuntime } from "../runtime.js";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import {
  bindTestThread,
  createTestThreadBindingManager,
  hoisted,
  installThreadBindingLifecycleTestHooks,
} from "./thread-bindings.lifecycle.test-support.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

const { reconcileAcpThreadBindingsOnStartup } = await import("./thread-bindings.lifecycle.js");
const reconcileOptions = { cfg: EMPTY_DISCORD_TEST_CONFIG, accountId: "default" };
const sessionKey = (name: string) => `agent:codex:acp:${name}`;
const session = (key: string) => ({
  sessionKey: key,
  storeSessionKey: key,
  acp: {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: `runtime:${key}`,
    mode: "persistent",
    state: "running",
    lastActivityAt: 100,
  },
});

async function bindAcp(
  manager: Awaited<ReturnType<typeof createTestThreadBindingManager>>,
  name: string,
) {
  return bindTestThread(manager, {
    threadId: name,
    targetKind: "acp",
    targetSessionKey: sessionKey(name),
    agentId: "codex",
  });
}

describe("thread binding ACP startup reconciliation", () => {
  installThreadBindingLifecycleTestHooks();

  it("removes missing ACP sessions while preserving valid and plugin-owned bindings", async () => {
    const manager = await createTestThreadBindingManager();
    await bindAcp(manager, "healthy");
    await bindAcp(manager, "stale");
    await bindTestThread(manager);
    await bindTestThread(manager, {
      threadId: "user:123",
      channelId: "user:123",
      targetKind: "acp",
      targetSessionKey: "plugin-binding:owner:dm",
      metadata: { pluginBindingOwner: "plugin", pluginId: "owner" },
    });
    hoisted.readAcpSessionEntry.mockImplementation(
      ({ sessionKey: key }: { sessionKey: string }) => {
        const entry = session(key);
        return key === sessionKey("healthy")
          ? { ...entry, acp: { ...entry.acp, state: "error" } }
          : { ...entry, acp: undefined };
      },
    );
    expect(await reconcileAcpThreadBindingsOnStartup(reconcileOptions)).toEqual({
      checked: 2,
      removed: 1,
      staleSessionKeys: [sessionKey("stale")],
    });
    expect(manager.getByThreadId("stale")).toBeUndefined();
    expect(manager.getByThreadId("healthy")).toMatchObject({
      targetKind: "acp",
      targetSessionKey: sessionKey("healthy"),
    });
    expect(manager.getByThreadId("thread-1")).toMatchObject({
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
    });
    expect(manager.getByThreadId("user:123")).toMatchObject({
      metadata: { pluginBindingOwner: "plugin", pluginId: "owner" },
    });
    expect(hoisted.sendMessageDiscord).not.toHaveBeenCalled();
    expect(hoisted.sendWebhookMessageDiscord).not.toHaveBeenCalled();
  });

  it("keeps bindings when their session store cannot be read", async () => {
    const manager = await createTestThreadBindingManager();
    await bindAcp(manager, "uncertain");
    hoisted.readAcpSessionEntry.mockReturnValue({
      ...session(sessionKey("uncertain")),
      acp: undefined,
      storeReadFailed: true,
    });
    expect(await reconcileAcpThreadBindingsOnStartup(reconcileOptions)).toEqual({
      checked: 1,
      removed: 0,
      staleSessionKeys: [],
    });
    expect(manager.getByThreadId("uncertain")?.targetSessionKey).toBe(sessionKey("uncertain"));
  });

  it("propagates a refused session join without deleting its binding", async () => {
    const manager = await createTestThreadBindingManager();
    await bindAcp(manager, "refused");
    const error = new IncognitoSessionEndedError();
    hoisted.readAcpSessionEntry.mockImplementation(() => {
      throw error;
    });

    await expect(reconcileAcpThreadBindingsOnStartup(reconcileOptions)).rejects.toBe(error);
    expect(manager.getByThreadId("refused")?.targetSessionKey).toBe(sessionKey("refused"));
  });

  it("removes a running binding after an explicit stale health verdict", async () => {
    const manager = await createTestThreadBindingManager();
    await bindAcp(manager, "running");
    hoisted.readAcpSessionEntry.mockReturnValue(session(sessionKey("running")));
    expect(
      await reconcileAcpThreadBindingsOnStartup({
        ...reconcileOptions,
        healthProbe: async () => ({ status: "stale", reason: "status-timeout-running-stale" }),
      }),
    ).toEqual({ checked: 1, removed: 1, staleSessionKeys: [sessionKey("running")] });
    expect(manager.getByThreadId("running")).toBeUndefined();
  });

  it("propagates a nested health-probe refusal and keeps the binding", async () => {
    const manager = await createTestThreadBindingManager();
    await bindAcp(manager, "probe-refused");
    hoisted.readAcpSessionEntry.mockReturnValue(session(sessionKey("probe-refused")));
    const error = new AggregateError([new IncognitoSessionEndedError()], "ACP probe failed");
    await expect(
      reconcileAcpThreadBindingsOnStartup({
        ...reconcileOptions,
        healthProbe: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(manager.getByThreadId("probe-refused")?.targetSessionKey).toBe(
      sessionKey("probe-refused"),
    );
  });

  it.each(["before-delete", "after-commit"] as const)(
    "propagates prepared cleanup refusal at %s while preserving acknowledged deletion",
    async (phase) => {
      const manager = await createTestThreadBindingManager({ persist: true });
      await bindAcp(manager, "prepared");
      const runtime = getDiscordRuntime();
      const open = runtime.state.openKeyedStore.bind(runtime.state);
      const persisted = open<ThreadBindingRecord>({
        namespace: "thread-bindings",
        maxEntries: 10_000,
      });
      const orphanKey = "zz-orphan";
      if (phase === "after-commit") {
        const binding = (await persisted.entries()).find(
          ({ value }) => value.threadId === "prepared",
        )?.value;
        assert(binding);
        await persisted.register(orphanKey, {
          ...binding,
          threadId: "orphan",
          targetSessionKey: sessionKey("orphan"),
        });
      }
      const error = new IncognitoSessionEndedError();
      let current = true;
      const opened = vi
        .spyOn(runtime.state, "openKeyedStore")
        .mockImplementation(<T>(options: Parameters<typeof open>[0]) => {
          const store = open<T>(options);
          const remove = store.delete.bind(store);
          vi.spyOn(store, "delete").mockImplementation(async (...args) => {
            if (phase === "before-delete") {
              current = false;
            } else if (args[0] === orphanKey) {
              current = false;
              throw new Error("Orphan cleanup failed after target deletion");
            }
            return remove(...args);
          });
          return store;
        });
      const release = vi.fn();
      try {
        const failure = await reconcileAcpThreadBindingsOnStartup({
          ...reconcileOptions,
          prepareSession: async ({ sessionKey: key }) => ({
            session: {
              cfg: EMPTY_DISCORD_TEST_CONFIG,
              storePath: "/fixture",
              ...session(key),
              acp: undefined,
            },
            assertCurrent() {
              if (!current) {
                throw error;
              }
            },
            release,
          }),
        }).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(() => rethrowIncognitoSessionError(failure)).toThrow();
        const stored = (await persisted.entries()).map(({ value }) => value.targetSessionKey);
        if (phase === "before-delete") {
          expect(manager.getByThreadId("prepared")?.targetSessionKey).toBe(sessionKey("prepared"));
          expect(stored).toContain(sessionKey("prepared"));
        } else {
          expect(manager.getByThreadId("prepared")).toBeUndefined();
          expect(stored).toEqual([sessionKey("orphan")]);
        }
        expect(release).toHaveBeenCalledOnce();
      } finally {
        opened.mockRestore();
        await manager.stop();
      }
    },
  );
});
