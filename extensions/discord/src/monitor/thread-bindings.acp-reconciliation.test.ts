import { describe, expect, it } from "vitest";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import {
  bindTestThread,
  createTestThreadBindingManager,
  hoisted,
  installThreadBindingLifecycleTestHooks,
} from "./thread-bindings.lifecycle.test-support.js";

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
});
