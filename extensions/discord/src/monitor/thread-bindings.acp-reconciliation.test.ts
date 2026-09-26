import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import {
  createNonSweepingTestManager,
  expectFields,
  hoisted,
  installThreadBindingLifecycleTestHooks,
  requireBinding,
  requireRecord,
} from "./thread-bindings.lifecycle.test-support.js";

const { reconcileAcpThreadBindingsOnStartup } = await import("./thread-bindings.lifecycle.js");

describe("thread binding ACP startup reconciliation", () => {
  installThreadBindingLifecycleTestHooks();

  it("removes stale ACP bindings during startup reconciliation", async () => {
    const manager = await createNonSweepingTestManager({
      accountId: "default",
    });

    await manager.bindTarget({
      threadId: "thread-acp-healthy",
      channelId: "parent-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:healthy",
      agentId: "codex",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });
    await manager.bindTarget({
      threadId: "thread-acp-stale",
      channelId: "parent-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:stale",
      agentId: "codex",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });
    await manager.bindTarget({
      threadId: "thread-subagent",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      agentId: "main",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });

    hoisted.readAcpSessionEntryAsync.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      if (sessionKey === "agent:codex:acp:healthy") {
        return {
          sessionKey,
          storeSessionKey: sessionKey,
          acp: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "runtime:healthy",
            mode: "persistent",
            state: "idle",
            lastActivityAt: Date.now(),
          },
        };
      }
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: undefined,
      };
    });

    const result = await reconcileAcpThreadBindingsOnStartup({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      accountId: "default",
    });

    expect(result.checked).toBe(2);
    expect(result.removed).toBe(1);
    expect(result.staleSessionKeys).toContain("agent:codex:acp:stale");
    expectFields(requireBinding(manager, "thread-acp-healthy"), "healthy binding", {
      threadId: "thread-acp-healthy",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:healthy",
    });
    expect(manager.getByThreadId("thread-acp-stale")).toBeUndefined();
    expectFields(requireBinding(manager, "thread-subagent"), "subagent binding", {
      threadId: "thread-subagent",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
    });
    expect(hoisted.sendMessageDiscord).not.toHaveBeenCalled();
    expect(hoisted.sendWebhookMessageDiscord).not.toHaveBeenCalled();
  });

  it("skips a binding replaced while its startup ACP read is pending", async () => {
    const manager = await createNonSweepingTestManager({ accountId: "default" });
    const target = {
      threadId: "thread-acp-held",
      channelId: "parent-1",
      targetKind: "acp" as const,
      targetSessionKey: "agent:codex:acp:original",
      agentId: "codex",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    };
    await manager.bindTarget(target);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    hoisted.readAcpSessionEntryAsync.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return {
        sessionKey: target.targetSessionKey,
        storeSessionKey: target.targetSessionKey,
        acp: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "original-runtime",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 100,
        },
      };
    });
    const healthProbe = vi.fn(async () => ({ status: "stale" as const }));
    const pending = reconcileAcpThreadBindingsOnStartup({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      accountId: "default",
      healthProbe,
    });
    await entered.promise;
    try {
      await manager.bindTarget({ ...target, targetSessionKey: "agent:codex:acp:replacement" });
    } finally {
      release.resolve();
    }
    expect(await pending).toMatchObject({ removed: 0, staleSessionKeys: [] });
    expect(healthProbe).not.toHaveBeenCalled();
    expect(manager.getByThreadId(target.threadId)?.targetSessionKey).toBe(
      "agent:codex:acp:replacement",
    );
  });

  it("keeps ACP bindings when session store reads fail during startup reconciliation", async () => {
    const manager = await createNonSweepingTestManager({
      accountId: "default",
    });

    await manager.bindTarget({
      threadId: "thread-acp-uncertain",
      channelId: "parent-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:uncertain",
      agentId: "codex",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });

    hoisted.readAcpSessionEntryAsync.mockReturnValue({
      sessionKey: "agent:codex:acp:uncertain",
      storeSessionKey: "agent:codex:acp:uncertain",
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      storePath: "/tmp/mock-sessions.json",
      storeReadFailed: true,
      entry: undefined,
      acp: undefined,
    });

    const result = await reconcileAcpThreadBindingsOnStartup({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      accountId: "default",
    });

    expect(result.checked).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.staleSessionKeys).toStrictEqual([]);
    expectFields(requireBinding(manager, "thread-acp-uncertain"), "uncertain binding", {
      threadId: "thread-acp-uncertain",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:uncertain",
    });
  });

  it("does not reconcile plugin-owned direct bindings as stale ACP sessions", async () => {
    const manager = await createNonSweepingTestManager({
      accountId: "default",
    });

    await manager.bindTarget({
      threadId: "user:1177378744822943744",
      channelId: "user:1177378744822943744",
      targetKind: "acp",
      targetSessionKey: "plugin-binding:openclaw-codex-app-server:dm",
      agentId: "codex",
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
      },
    });

    hoisted.readAcpSessionEntryAsync.mockReturnValue(null);

    const result = await reconcileAcpThreadBindingsOnStartup({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      accountId: "default",
    });

    expect(result.checked).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.staleSessionKeys).toStrictEqual([]);
    const binding = expectFields(
      manager.getByThreadId("user:1177378744822943744"),
      "plugin direct binding",
      {
        threadId: "user:1177378744822943744",
      },
    );
    expectFields(requireRecord(binding.metadata, "binding metadata"), "binding metadata", {
      pluginBindingOwner: "plugin",
      pluginId: "openclaw-codex-app-server",
    });
  });

  it("removes ACP bindings when health probe marks running session as stale", async () => {
    const manager = await createNonSweepingTestManager({
      accountId: "default",
    });

    await manager.bindTarget({
      threadId: "thread-acp-running",
      channelId: "parent-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:running",
      agentId: "codex",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });

    hoisted.readAcpSessionEntryAsync.mockReturnValue({
      sessionKey: "agent:codex:acp:running",
      storeSessionKey: "agent:codex:acp:running",
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime:running",
        mode: "persistent",
        state: "running",
        lastActivityAt: Date.now() - 5 * 60 * 1000,
      },
    });

    const result = await reconcileAcpThreadBindingsOnStartup({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      accountId: "default",
      healthProbe: async () => ({ status: "stale", reason: "status-timeout-running-stale" }),
    });

    expect(result.checked).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.staleSessionKeys).toContain("agent:codex:acp:running");
    expect(manager.getByThreadId("thread-acp-running")).toBeUndefined();
  });

  it("keeps running ACP bindings when health probe is uncertain", async () => {
    const manager = await createNonSweepingTestManager({
      accountId: "default",
    });

    await manager.bindTarget({
      threadId: "thread-acp-running-uncertain",
      channelId: "parent-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:running-uncertain",
      agentId: "codex",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });

    hoisted.readAcpSessionEntryAsync.mockReturnValue({
      sessionKey: "agent:codex:acp:running-uncertain",
      storeSessionKey: "agent:codex:acp:running-uncertain",
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime:running-uncertain",
        mode: "persistent",
        state: "running",
        lastActivityAt: Date.now(),
      },
    });

    const result = await reconcileAcpThreadBindingsOnStartup({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      accountId: "default",
      healthProbe: async () => ({ status: "uncertain", reason: "status-timeout" }),
    });

    expect(result.checked).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.staleSessionKeys).toStrictEqual([]);
    expectFields(
      requireBinding(manager, "thread-acp-running-uncertain"),
      "running uncertain binding",
      {
        threadId: "thread-acp-running-uncertain",
        targetKind: "acp",
        targetSessionKey: "agent:codex:acp:running-uncertain",
      },
    );
  });

  it("keeps ACP bindings in stored error state when no explicit stale probe verdict exists", async () => {
    const manager = await createNonSweepingTestManager({
      accountId: "default",
    });

    await manager.bindTarget({
      threadId: "thread-acp-error",
      channelId: "parent-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:error",
      agentId: "codex",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });

    hoisted.readAcpSessionEntryAsync.mockReturnValue({
      sessionKey: "agent:codex:acp:error",
      storeSessionKey: "agent:codex:acp:error",
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime:error",
        mode: "persistent",
        state: "error",
        lastActivityAt: Date.now(),
      },
    });

    const result = await reconcileAcpThreadBindingsOnStartup({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      accountId: "default",
    });

    expect(result.checked).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.staleSessionKeys).toStrictEqual([]);
    expectFields(requireBinding(manager, "thread-acp-error"), "error binding", {
      threadId: "thread-acp-error",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:error",
    });
  });

  it("starts ACP health probes in parallel during startup reconciliation", async () => {
    const manager = await createNonSweepingTestManager({
      accountId: "default",
    });

    await manager.bindTarget({
      threadId: "thread-acp-probe-1",
      channelId: "parent-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:probe-1",
      agentId: "codex",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });
    await manager.bindTarget({
      threadId: "thread-acp-probe-2",
      channelId: "parent-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:probe-2",
      agentId: "codex",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });

    hoisted.readAcpSessionEntryAsync.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: `runtime:${sessionKey}`,
          mode: "persistent",
          state: "running",
          lastActivityAt: Date.now(),
        },
      };
    });

    let resolveFirstProbe: ((value: { status: "healthy" }) => void) | undefined;
    const firstProbe = new Promise<{ status: "healthy" }>((resolve) => {
      resolveFirstProbe = resolve;
    });
    let probeCallCount = 0;
    let secondProbeStartedBeforeFirstResolved = false;

    const reconcilePromise = reconcileAcpThreadBindingsOnStartup({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      accountId: "default",
      healthProbe: async () => {
        probeCallCount += 1;
        if (probeCallCount === 1) {
          return await firstProbe;
        }
        secondProbeStartedBeforeFirstResolved = true;
        return { status: "healthy" as const };
      },
    });

    await vi.waitFor(() => {
      expect(probeCallCount).toBe(2);
    });
    const observedParallelStart = secondProbeStartedBeforeFirstResolved;

    resolveFirstProbe?.({ status: "healthy" });
    const result = await reconcilePromise;

    expect(observedParallelStart).toBe(true);
    expect(result.checked).toBe(2);
    expect(result.removed).toBe(0);
  });

  it("caps ACP startup health probe concurrency", async () => {
    const manager = await createNonSweepingTestManager({
      accountId: "default",
    });

    for (let index = 0; index < 12; index += 1) {
      const key = `agent:codex:acp:cap-${index}`;
      await manager.bindTarget({
        threadId: `thread-acp-cap-${index}`,
        channelId: "parent-1",
        targetKind: "acp",
        targetSessionKey: key,
        agentId: "codex",
        webhookId: "wh-1",
        webhookToken: "tok-1",
      });
    }

    hoisted.readAcpSessionEntryAsync.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey = (paramsUnknown as { sessionKey?: string }).sessionKey ?? "";
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: `runtime:${sessionKey}`,
          mode: "persistent",
          state: "running",
          lastActivityAt: Date.now(),
        },
      };
    });

    const PROBE_LIMIT = 8;
    let probeCalls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseFirstWave: (() => void) | undefined;
    const firstWaveGate = new Promise<void>((resolve) => {
      releaseFirstWave = resolve;
    });

    const reconcilePromise = reconcileAcpThreadBindingsOnStartup({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      accountId: "default",
      healthProbe: async () => {
        probeCalls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (probeCalls <= PROBE_LIMIT) {
          await firstWaveGate;
        }
        inFlight -= 1;
        return { status: "healthy" as const };
      },
    });

    await vi.waitFor(() => {
      expect(probeCalls).toBe(PROBE_LIMIT);
    });
    expect(maxInFlight).toBe(PROBE_LIMIT);

    releaseFirstWave?.();
    const result = await reconcilePromise;
    expect(result.checked).toBe(12);
    expect(result.removed).toBe(0);
    expect(maxInFlight).toBeLessThanOrEqual(PROBE_LIMIT);
  });
});
