import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, it, vi } from "vitest";
import {
  upsertSessionEntryCore,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import * as entryReads from "../config/sessions/session-entry-read-runtime.js";
import { drainPendingSessionDelivery } from "../infra/session-delivery-queue-recovery.js";
import { startSessionDeliveryRuntime } from "../infra/session-delivery-queue-runtime.js";
import { loadPendingSessionDelivery } from "../infra/session-delivery-queue-storage.js";
import {
  resolveSessionDeliveryQueueName,
  type QueuedSessionDelivery,
} from "../infra/session-delivery-queue.records.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  assertMemoryCallbackDeliveryCurrent,
  getMemoryPluginCallbackAccess,
  listMemorySessionDeliveries,
  verifyMemoryCallbackDelivery,
  withPluginCallbackMemoryOwner,
} from "./plugin-async-callback-memory.js";
import {
  completeHostPluginAsyncCallback,
  issueHostPluginAsyncCallback,
} from "./plugin-async-callback.host.js";
import { settlePluginAsyncCallbackDelivery } from "./plugin-async-callback.js";

const child = vi.hoisted(() => ({
  runId: "incognito-run",
  createdAt: 1,
  collect: false,
  childSessionIdentity: { sessionId: "private-session", lifecycleRevision: "original" },
  execution: { status: "running" },
}));
vi.mock("./subagents/registry/subagent-registry-read.js", () => ({
  getLatestLiveSubagentRunByChildSessionKey: () => child,
}));
vi.mock("../infra/agent-run-registry.js", () => ({
  getAgentRunContext: () => ({
    sessionKey: "agent:main:subagent:incognito-private",
    sessionId: "private-session",
    agentId: "main",
  }),
}));
const DAY = 24 * 60 * 60_000;
const privateMarker = "PRIVATE-CALLBACK-CONTENT-should-not-reach-shared-state";
afterEach(() => vi.restoreAllMocks());

async function withMemory(
  run: (fixture: {
    issue: (ttlMs?: number) => ReturnType<typeof issueHostPluginAsyncCallback>;
    stop: () => Promise<void>;
    advance: (ms: number) => Promise<void>;
    reset: () => Promise<void>;
    observe: () => void;
    delivered: QueuedSessionDelivery[];
    fail: () => void;
    drain: (id: string) => Promise<QueuedSessionDelivery | null>;
    assertNoDiskCallbacks: () => void;
    logs: string[];
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "callback-memory", scenario: "minimal" }, async (state) => {
    const clock = createGatewaySchedulerClock(Date.now());
    vi.spyOn(Date, "now").mockImplementation(clock.clock.now);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:subagent:incognito-private",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    };
    await upsertSessionEntryCore(scope, {
      sessionId: "private-session",
      lifecycleRevision: "original",
      incognito: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const shared = openOpenClawStateDatabase({ env: state.env });
    const queueContext = captureOpenClawStateWorkerContext();
    const delivered: QueuedSessionDelivery[] = [];
    const logs: string[] = [];
    const log = {
      info: (s: string) => logs.push(s),
      warn: (s: string) => logs.push(s),
      error: (s: string) => logs.push(s),
    };
    let fail = false;
    const deliver = async (entry: QueuedSessionDelivery) => {
      expect(await verifyMemoryCallbackDelivery(entry)).toBe(true);
      assertMemoryCallbackDeliveryCurrent(entry);
      if (fail) {
        throw new Error(privateMarker);
      }
      delivered.push(entry);
    };
    const stop = startSessionDeliveryRuntime({
      scheduler,
      queueContext,
      log,
      deliver,
      onSettled: settlePluginAsyncCallbackDelivery,
    });
    const issue = (ttlMs = 60_000) =>
      issueHostPluginAsyncCallback({
        pluginId: "fixture",
        toolName: "render",
        sessionKey: scope.sessionKey,
        sessionId: "private-session",
        runId: child.runId,
        agentId: "main",
        ttlMs,
        assertInvocationCurrent: () => {},
        assertPluginCurrent: () => {},
      });
    try {
      await run({
        issue,
        stop,
        delivered,
        logs,
        advance: async (ms) => {
          await clock.advanceBy(ms);
        },
        observe: () => sessionChanges.emit(scope),
        reset: async () => {
          await patchSessionEntryCore(scope, () => ({ lifecycleRevision: "replacement" }));
        },
        fail: () => {
          fail = true;
        },
        drain: (id) =>
          drainPendingSessionDelivery({
            id,
            queueContext,
            log,
            logLabel: "private-test",
            deliver,
            onSettled: settlePluginAsyncCallbackDelivery,
            bypassBackoff: true,
          }),
        assertNoDiskCallbacks: () => {
          expect(
            shared.db.prepare("SELECT count(*) AS count FROM delivery_queue_entries").get(),
          ).toMatchObject({ count: 0 });
          expect(
            shared.db
              .prepare(
                "SELECT count(*) AS count FROM plugin_state_entries WHERE plugin_id = 'core:plugin-async-callback'",
              )
              .get(),
          ).toMatchObject({ count: 0 });
        },
      });
    } finally {
      await stop();
      await scheduler.stop();
    }
  });
}

it("issues through the host, atomically redeems in RAM, and loses every receipt on restart", async () => {
  await withMemory(async ({ issue, advance, stop, delivered, assertNoDiskCallbacks }) => {
    const handle = await issue();
    expect(handle.storage).toBe("memory");
    expect(await handle.status()).toMatchObject({ status: "pending", storage: "memory" });
    await expect(issue()).rejects.toThrow("outstanding callback");
    expect(
      await completeHostPluginAsyncCallback({
        pluginId: "another-plugin",
        token: handle.token,
        resultText: privateMarker,
        assertPluginCurrent: () => {},
      }),
    ).toBe("unknown");
    expect(
      (
        await Promise.all([handle.complete(privateMarker), handle.complete(privateMarker)])
      ).toSorted(),
    ).toEqual(["accepted", "duplicate"]);
    expect(await handle.status()).toMatchObject({ status: "accepted" });
    assertNoDiskCallbacks();
    await advance(0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      kind: "nativeChildFollowup",
      expectedSessionId: "private-session",
      pausedRunId: "incognito-run",
    });
    expect(delivered[0]?.kind === "nativeChildFollowup" && delivered[0].message).toContain(
      privateMarker,
    );
    expect(await handle.status()).toMatchObject({ status: "delivered" });
    await stop();
    expect(await handle.complete(privateMarker)).toBe("unknown");
    expect(await handle.status()).toEqual({ status: "unknown" });
    expect(listMemorySessionDeliveries()).toEqual([]);
    assertNoDiskCallbacks();
  });
});

it("kills retained access and queued payload on a same-ID lifecycle reset", async () => {
  await withMemory(async ({ issue, reset, assertNoDiskCallbacks }) => {
    const handle = await issue();
    const access = await getMemoryPluginCallbackAccess(handle.token, "fixture");
    expect(access).toBeDefined();
    expect(await handle.complete(privateMarker)).toBe("accepted");
    const queued = listMemorySessionDeliveries().find(
      (entry) => entry.kind === "nativeChildFollowup" && !entry.callbackExpiryKey,
    )!;
    await reset();
    expect(access!.complete(privateMarker)).toEqual({ status: "unknown" });
    expect(await handle.status()).toEqual({ status: "unknown" });
    expect(() => assertMemoryCallbackDeliveryCurrent(queued)).toThrow("retired");
    expect(listMemorySessionDeliveries()).toEqual([]);
    assertNoDiskCallbacks();
  });
});

it("uses canonical bounded retry settlement without persisting or logging private errors", async () => {
  await withMemory(async ({ issue, drain, fail, assertNoDiskCallbacks, logs }) => {
    const handle = await issue();
    await handle.complete(privateMarker);
    const queued = listMemorySessionDeliveries().find(
      (entry) => entry.kind === "nativeChildFollowup" && !entry.callbackExpiryKey,
    )!;
    fail();
    for (let attempt = 0; attempt < 6; attempt++) {
      await drain(queued.id);
    }
    expect(await handle.status()).toMatchObject({ status: "failed" });
    expect(logs.join("\n")).not.toContain(privateMarker);
    expect(logs.join("\n")).toContain("Incognito callback delivery failed");
    expect((await issue()).storage).toBe("memory");
    assertNoDiskCallbacks();
  });
});

it("caps redemption at 24 hours and retires memory at the existing session deadline", async () => {
  await withMemory(async ({ issue, advance, assertNoDiskCallbacks }) => {
    await expect(issue(DAY + 1)).rejects.toThrow("deadline");
    const handle = await issue(DAY);
    expect(handle.expiresAt).toBe(Date.now() + DAY);
    await advance(DAY);
    expect(await handle.status()).toEqual({ status: "unknown" });
    expect(await handle.complete(privateMarker)).toBe("unknown");
    expect(listMemorySessionDeliveries()).toEqual([]);
    assertNoDiskCallbacks();
  });
});

it("rejects private queue IDs at the persistent boundary, including after restart", async () => {
  expect(() => resolveSessionDeliveryQueueName("memory:native-child:old")).toThrow(
    "cannot enter a persistent queue",
  );
  await withOpenClawTestState({ label: "callback-no-ram-owner" }, async () => {
    const context = captureOpenClawStateWorkerContext();
    expect(await loadPendingSessionDelivery("memory:native-child:old", context)).toBeNull();
    expect(
      await completeHostPluginAsyncCallback({
        pluginId: "fixture",
        token: "memory:unknown",
        resultText: privateMarker,
        assertPluginCurrent: () => {},
      }),
    ).toBe("unknown");
  });
});

it("preserves admitted RAM results on transient observation read errors", async () => {
  await withMemory(async ({ issue, observe, advance, assertNoDiskCallbacks }) => {
    const handle = await issue();
    expect(await handle.complete(privateMarker)).toBe("accepted");
    const read = vi
      .spyOn(entryReads, "withSessionEntryReadOnlyInWorker")
      .mockRejectedValueOnce(new Error(privateMarker));
    try {
      observe();
      expect(read).toHaveBeenCalledOnce();
      await expect(read.mock.results[0]!.value).rejects.toThrow(privateMarker);
    } finally {
      read.mockRestore();
    }
    expect(await handle.status()).toMatchObject({ status: "accepted" });
    await advance(0);
    expect(await handle.status()).toMatchObject({ status: "delivered" });
    assertNoDiskCallbacks();
  });
});

it("releases a pending RAM expiry reservation after verification retries exhaust", async () => {
  await withMemory(async ({ issue, drain, assertNoDiskCallbacks, logs }) => {
    const handle = await issue();
    const expiry = listMemorySessionDeliveries()[0]!;
    const read = vi
      .spyOn(entryReads, "withSessionEntryReadOnlyInWorker")
      .mockRejectedValue(new Error(privateMarker));
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        await drain(expiry.id);
      }
    } finally {
      read.mockRestore();
    }
    expect(await handle.status()).toMatchObject({ status: "failed" });
    expect((await issue()).storage).toBe("memory");
    expect(logs.join("\n")).not.toContain(privateMarker);
    assertNoDiskCallbacks();
  });
});

it("binds lifetime capture to the runtime rather than the issuing invocation context", async () => {
  const context = new AsyncLocalStorage<string>();
  await context.run("runtime", async () =>
    withMemory(async () => {
      await context.run("invocation", async () => {
        expect(await withPluginCallbackMemoryOwner(async () => context.getStore())).toBe("runtime");
      });
    }),
  );
});
