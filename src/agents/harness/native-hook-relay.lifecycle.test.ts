import { Agent, Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import * as relayBridge from "./native-hook-relay-bridge.js";
import * as clientStore from "./native-hook-relay-client-store.js";
import { invokeNativeHookRelayBridge } from "./native-hook-relay-client.js";
import * as store from "./native-hook-relay-store.js";
import {
  invokeNativeHookRelay,
  registerNativeHookRelay,
  registerOwnedNativeHookRelay,
  testing,
} from "./native-hook-relay.js";

afterEach(async () => {
  await testing.clearNativeHookRelaysForTests();
  resetGlobalHookRunner();
  vi.restoreAllMocks();
});

it("keeps command preparation synchronous while readiness waits for locator publication", async () => {
  await withOpenClawTestState({ label: "relay-ready-publication" }, async () => {
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const write = store.writeNativeHookRelayBridgeRecord;
    vi.spyOn(store, "writeNativeHookRelayBridgeRecord").mockImplementation(async (params) => {
      entered.resolve();
      await resume.promise;
      await write(params);
    });
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      sessionId: "ready-publication",
      runId: "ready-publication",
    });
    let ready = false;
    const readiness = relay.ready.then(() => {
      ready = true;
    });
    try {
      expect(typeof relay.commandForEvent("post_tool_use")).toBe("string");
      await entered.promise;
      expect(ready).toBe(false);
      expect(Boolean(await store.readNativeHookRelayBridgeRecord({ relayId: relay.relayId }))).toBe(
        false,
      );
      resume.resolve();
      await readiness;
      expect(Boolean(await store.readNativeHookRelayBridgeRecord({ relayId: relay.relayId }))).toBe(
        true,
      );
    } finally {
      resume.resolve();
      await readiness;
      relay.unregister();
      await relay.drain();
    }
  });
});

it("joins unregister when listener startup has not completed", async () => {
  await withOpenClawTestState({ label: "relay-close-startup" }, async () => {
    vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server) {
      return this;
    });
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      sessionId: "close-startup",
      runId: "close-startup",
    });
    relay.unregister();
    await relay.drain();
    await expect(relay.ready).rejects.toThrow("stale registration");
    expect(Boolean(await store.readNativeHookRelayBridgeRecord({ relayId: relay.relayId }))).toBe(
      false,
    );
  });
});

it.each(["listener", "publication"] as const)(
  "preserves the exact %s error while admitting logical hook policy",
  async (stage) => {
    await withOpenClawTestState({ label: `relay-${stage}-failure` }, async () => {
      await store.clearNativeHookRelayBridgeRecordsForTests();
      const failure = new Error(`fixture ${stage} failed`);
      if (stage === "listener") {
        vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server) {
          queueMicrotask(() => this.emit("error", failure));
          return this;
        });
      } else {
        vi.spyOn(store, "writeNativeHookRelayBridgeRecord").mockRejectedValueOnce(failure);
      }
      const policy = vi.fn(async () => ({
        kind: "veto" as const,
        blocked: true as const,
        reason: "fixture policy denied",
      }));
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        sessionId: `${stage}-failure`,
        runId: `${stage}-failure`,
        allowedEvents: ["pre_tool_use"],
        runBeforeToolCall: policy,
      });
      try {
        await expect(relay.ready).rejects.toBe(failure);
        await relay.prepareInvocation();
        const response = await invokeNativeHookRelay({
          provider: "codex",
          relayId: relay.relayId,
          generation: relay.generation,
          requireGeneration: true,
          event: "pre_tool_use",
          rawPayload: {
            tool_name: "Bash",
            tool_input: { command: "echo synthetic" },
          },
        });
        expect(JSON.parse(response.stdout)).toMatchObject({
          hookSpecificOutput: {
            permissionDecision: "deny",
            permissionDecisionReason: "fixture policy denied",
          },
        });
        expect(policy).toHaveBeenCalledOnce();
        expect(
          await store.readNativeHookRelayBridgeRecord({ relayId: relay.relayId }),
        ).toBeUndefined();
      } finally {
        relay.unregister();
        await relay.drain();
      }
    });
  },
);

it("renews logical invocation beyond its original expiry when the listener is unavailable", async () => {
  await withOpenClawTestState({ label: "relay-logical-renewal" }, async () => {
    await store.clearNativeHookRelayBridgeRecordsForTests();
    const failure = new Error("fixture listener failed");
    vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server) {
      queueMicrotask(() => this.emit("error", failure));
      return this;
    });
    const policy = vi.fn(async () => ({
      kind: "veto" as const,
      blocked: true as const,
      reason: "renewed policy denied",
    }));
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      sessionId: "logical-renewal",
      runId: "logical-renewal",
      ttlMs: 60_000,
      allowedEvents: ["pre_tool_use"],
      runBeforeToolCall: policy,
    });
    await expect(relay.ready).rejects.toBe(failure);
    const originalExpiry = relay.expiresAtMs;
    const clock = vi.spyOn(Date, "now").mockReturnValue(originalExpiry - 1);
    try {
      relay.renew(60_000);
      // A known transport failure may still be reported by the strict resource drain.
      await relay.drain().catch((error: unknown) => expect(error).toBe(failure));
      clock.mockReturnValue(originalExpiry + 1);
      const response = await invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        generation: relay.generation,
        requireGeneration: true,
        event: "pre_tool_use",
        rawPayload: { tool_name: "Bash", tool_input: { command: "echo synthetic" } },
      });
      expect(JSON.parse(response.stdout)).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: "renewed policy denied",
        },
      });
      expect(policy).toHaveBeenCalledOnce();
      expect(relay.expiresAtMs).toBeGreaterThan(originalExpiry + 1);
      expect(
        await store.readNativeHookRelayBridgeRecord({ relayId: relay.relayId }),
      ).toBeUndefined();
    } finally {
      clock.mockRestore();
      relay.unregister();
      await relay.drain();
    }
  });
});

it.each(["cancellation", "replacement", "foreground retirement"] as const)(
  "rejects logical preparation after %s while publication is held",
  async (retirement) => {
    await withOpenClawTestState({ label: "relay-prepare-retirement" }, async () => {
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const write = store.writeNativeHookRelayBridgeRecord;
      vi.spyOn(store, "writeNativeHookRelayBridgeRecord").mockImplementationOnce(async (params) => {
        entered.resolve();
        await resume.promise;
        await write(params);
      });
      const policy = vi.fn(() => ({ block: true, blockReason: "retired policy must not run" }));
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_tool_call", handler: policy }]),
      );
      const host = await createAdmittedHostCapabilityTestFixture({ runId: "prepare-retirement" });
      const abort = new AbortController();
      const relay = registerOwnedNativeHookRelay({
        provider: "codex",
        relayId: "prepare-retirement",
        sessionId: "prepare-retirement",
        runId: "prepare-retirement",
        signal: abort.signal,
        allowedEvents: ["pre_tool_use"],
        runBeforeToolCall: host.hostCapabilities.runBeforeToolCall,
        assertActive: host.hostCapabilities.assertActive,
        retention: {
          readClaim: () => undefined,
          shouldRetainAfterForegroundClose: () => retirement === "foreground retirement",
          allowPreToolUse: () => false,
          onDispose: () => {},
        },
      });
      let successor: ReturnType<typeof registerOwnedNativeHookRelay> | undefined;
      let preparation: Promise<void> | undefined;
      let settled = false;
      try {
        preparation = relay.prepareInvocation();
        void preparation.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await entered.promise;
        expect(settled).toBe(false);
        if (retirement === "cancellation") {
          abort.abort();
        } else if (retirement === "replacement") {
          successor = registerOwnedNativeHookRelay({
            provider: "codex",
            relayId: relay.relayId,
            sessionId: "prepare-retirement",
            runId: "prepare-successor",
          });
        } else {
          relay.unregister();
          expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeDefined();
        }
        resume.resolve();
        await expect(preparation).rejects.toThrow(/inactive|foreground|abort/i);
        await expect(
          invokeNativeHookRelay({
            provider: "codex",
            relayId: relay.relayId,
            generation: relay.generation,
            requireGeneration: true,
            event: "pre_tool_use",
            rawPayload: { tool_name: "Bash", tool_input: { command: "echo synthetic" } },
          }),
        ).rejects.toThrow();
        expect(policy).not.toHaveBeenCalled();
        if (successor) {
          await successor.ready;
          expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)?.runId).toBe(
            "prepare-successor",
          );
          expect(
            await store.readNativeHookRelayBridgeRecord({ relayId: relay.relayId }),
          ).toBeDefined();
        }
      } finally {
        resume.resolve();
        abort.abort();
        successor?.unregister();
        await Promise.allSettled([
          preparation,
          relay.drain(),
          ...(successor ? [successor.drain()] : []),
        ]);
        host.closeHost();
        host.closeAdmission();
        resetGlobalHookRunner();
      }
    });
  },
);

it("does not start transport when locator lookup consumes the caller deadline", async () => {
  await withOpenClawTestState({ label: "relay-lookup-deadline" }, async () => {
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      sessionId: "lookup-deadline",
      runId: "lookup-deadline",
    });
    await relay.ready;
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const read = clientStore.readNativeHookRelayClientBridgeRecord;
    vi.spyOn(clientStore, "readNativeHookRelayClientBridgeRecord").mockImplementation(
      async (params) => {
        const record = await read(params);
        entered.resolve();
        await resume.promise;
        return record;
      },
    );
    const startedAt = Date.now();
    const invocation = invokeNativeHookRelayBridge({
      provider: "codex",
      relayId: relay.relayId,
      generation: relay.generation,
      event: "post_tool_use",
      rawPayload: { hook_event_name: "PostToolUse", tool_name: "fixture", tool_response: {} },
      timeoutMs: 100,
    });
    void invocation.catch(() => undefined);
    await entered.promise;
    const connect = vi.spyOn(Agent.prototype, "createConnection");
    const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt + 101);
    try {
      resume.resolve();
      await expect(invocation).rejects.toThrow("timed out");
      expect(connect.mock.calls.length).toBe(0);
    } finally {
      clock.mockRestore();
      resume.resolve();
      await Promise.allSettled([invocation]);
      relay.unregister();
      await relay.drain();
    }
  });
});

it("allows a later renewal after one storage renewal fails", async () => {
  await withOpenClawTestState({ label: "relay-renewal-recovery" }, async () => {
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      sessionId: "renewal-recovery",
      runId: "renewal-recovery",
      ttlMs: 60_000,
    });
    await relay.ready;
    vi.spyOn(store, "renewOrRestoreNativeHookRelayBridgeRecord").mockRejectedValueOnce(
      new Error("fixture renewal failed"),
    );
    const expiresAtMs = relay.expiresAtMs;
    try {
      relay.renew(120_000);
      await expect(relay.drain()).rejects.toThrow("fixture renewal failed");
      expect(relay.expiresAtMs).toBe(expiresAtMs);

      relay.renew(180_000);
      await relay.drain();
      const renewed = await store.readNativeHookRelayBridgeRecord({ relayId: relay.relayId });
      expect(renewed?.expiresAtMs).toBe(relay.expiresAtMs);
      expect(relay.expiresAtMs).toBeGreaterThan(expiresAtMs);
    } finally {
      relay.unregister();
      await relay.drain();
    }
  });
});

it("joins a renewal accepted while an earlier drain reports failure", async () => {
  await withOpenClawTestState({ label: "relay-drain-renewal-race" }, async () => {
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      sessionId: "drain-renewal-race",
      runId: "drain-renewal-race",
      ttlMs: 60_000,
    });
    await relay.ready;
    const failure = new Error("fixture first renewal failed");
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const renew = store.renewOrRestoreNativeHookRelayBridgeRecord;
    vi.spyOn(store, "renewOrRestoreNativeHookRelayBridgeRecord")
      .mockRejectedValueOnce(failure)
      .mockImplementationOnce(async (params) => {
        entered.resolve();
        await resume.promise;
        return await renew(params);
      });
    const drain = relayBridge.drainNativeHookRelayBridge;
    vi.spyOn(relayBridge, "drainNativeHookRelayBridge").mockImplementationOnce(async (bridge) => {
      try {
        await drain(bridge);
      } catch (error) {
        relay.renew(180_000);
        throw error;
      }
    });
    const expiresAtMs = relay.expiresAtMs;
    relay.renew(120_000);
    const draining = relay.drain();
    let settled = false;
    void draining.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await entered.promise;
      expect(settled).toBe(false);
      resume.resolve();
      await expect(draining).rejects.toBe(failure);
      expect(relay.expiresAtMs).toBeGreaterThan(expiresAtMs);
    } finally {
      resume.resolve();
      await Promise.allSettled([draining]);
      relay.unregister();
      await relay.drain();
    }
  });
});

it("removes the locator after an admitted publication finishes during unregister", async () => {
  await withOpenClawTestState({ label: "relay-publication-close" }, async () => {
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const published = createDeferredCore();
    const deleted = createDeferredCore();
    const write = store.writeNativeHookRelayBridgeRecord;
    const remove = store.deleteNativeHookRelayBridgeRecordIfOwned;
    vi.spyOn(store, "writeNativeHookRelayBridgeRecord").mockImplementation(async (params) => {
      entered.resolve();
      await resume.promise;
      try {
        await write(params);
      } finally {
        published.resolve();
      }
    });
    vi.spyOn(store, "deleteNativeHookRelayBridgeRecordIfOwned").mockImplementation(
      async (params) => {
        try {
          return await remove(params);
        } finally {
          deleted.resolve();
        }
      },
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "publication-close",
      runId: "publication-close",
    });
    try {
      await entered.promise;
      relay.unregister();
      expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeUndefined();
      resume.resolve();
      await published.promise;
      await deleted.promise;
      expect(Boolean(await store.readNativeHookRelayBridgeRecord({ relayId: relay.relayId }))).toBe(
        false,
      );
    } finally {
      resume.resolve();
      await published.promise;
      relay.unregister();
      await testing.clearNativeHookRelaysForTests();
    }
  });
});

it("does not restore an old locator when renewal finishes after unregister", async () => {
  await withOpenClawTestState({ label: "relay-renewal-close" }, async () => {
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const renewed = createDeferredCore();
    const deleted = createDeferredCore();
    const renew = store.renewOrRestoreNativeHookRelayBridgeRecord;
    const remove = store.deleteNativeHookRelayBridgeRecordIfOwned;
    vi.spyOn(store, "renewOrRestoreNativeHookRelayBridgeRecord").mockImplementation(
      async (params) => {
        entered.resolve();
        await resume.promise;
        try {
          return await renew(params);
        } finally {
          renewed.resolve();
        }
      },
    );
    vi.spyOn(store, "deleteNativeHookRelayBridgeRecordIfOwned").mockImplementation(
      async (params) => {
        try {
          return await remove(params);
        } finally {
          deleted.resolve();
        }
      },
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "renewal-close",
      runId: "renewal-close",
    });
    try {
      await vi.waitFor(async () => {
        expect(
          Boolean(await store.readNativeHookRelayBridgeRecord({ relayId: relay.relayId })),
        ).toBe(true);
      });
      relay.renew(60_000);
      await entered.promise;
      relay.unregister();
      resume.resolve();
      await renewed.promise;
      await deleted.promise;
      expect(Boolean(await store.readNativeHookRelayBridgeRecord({ relayId: relay.relayId }))).toBe(
        false,
      );
    } finally {
      resume.resolve();
      relay.unregister();
      await testing.clearNativeHookRelaysForTests();
    }
  });
});

it("does not publish renewal expiry before the durable renewal succeeds", async () => {
  await withOpenClawTestState({ label: "relay-renewal-expiry" }, async () => {
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const renewed = createDeferredCore();
    const renew = store.renewOrRestoreNativeHookRelayBridgeRecord;
    vi.spyOn(store, "renewOrRestoreNativeHookRelayBridgeRecord").mockImplementation(
      async (params) => {
        entered.resolve();
        await resume.promise;
        try {
          return await renew(params);
        } finally {
          renewed.resolve();
        }
      },
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "renewal-expiry",
      runId: "renewal-expiry",
    });
    try {
      await vi.waitFor(async () => {
        expect(
          Boolean(await store.readNativeHookRelayBridgeRecord({ relayId: relay.relayId })),
        ).toBe(true);
      });
      const expiresAtMs = relay.expiresAtMs;
      relay.renew(60_000);
      await entered.promise;
      expect(relay.expiresAtMs).toBe(expiresAtMs);
    } finally {
      resume.resolve();
      await renewed.promise;
      relay.unregister();
      await testing.clearNativeHookRelaysForTests();
    }
  });
});
