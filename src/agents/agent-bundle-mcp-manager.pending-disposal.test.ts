// Disposal settlement owns the last cleanup of bindings left by empty successors.
import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
  withTestTimeout,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { bindSessionMcpStoreOwner } from "../config/sessions/session-mcp-store-admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { startCatalogRecoveryMcpServer } from "./agent-bundle-mcp-catalog-recovery.test-support.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.js";
import {
  createSessionMcpRuntimeManager as createFixtureManager,
  makeManagerRuntime,
  unopenedMcpConfig,
} from "./agent-bundle-mcp-manager.test-support.js";

const tempDirTracker = useAutoCleanupTempDirTracker(afterEach);
type RuntimeParams = Parameters<ReturnType<typeof createSessionMcpRuntimeManager>["acquire"]>[0];

async function verifyPendingDisposal(
  mode: "idle sweep" | "captured retirement" | "store retirement",
) {
  const terminate = createDeferred();
  const server = await startCatalogRecoveryMcpServer("idle-empty-successor", {
    holdTermination: terminate.promise,
  });
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  const manager = createSessionMcpRuntimeManager({ scheduler });
  const params: RuntimeParams = {
    sessionId: "idle-empty-successor",
    sessionKey: "agent:test:idle-empty-successor",
    workspaceDir: tempDirTracker.make("mcp-idle-empty-successor-"),
    manifestRegistry: { plugins: [] },
    cfg: {
      plugins: { enabled: false },
      mcp: {
        sessionIdleTtlMs: 100,
        servers: { fixture: { url: server.url, transport: "streamable-http" } },
      },
    },
  };
  const sessionKey = expectDefined(params.sessionKey, "MCP session key");
  const source = { agentId: "test", databaseIdentity: "first" };
  const admission = {};
  bindSessionMcpStoreOwner(admission, { ...source, sessionId: params.sessionId, sessionKey });
  let sweep: Promise<void> | undefined;
  let retirement: Promise<void> | undefined;
  try {
    const original = await manager.acquire({ ...params, storeAdmission: admission });
    try {
      expect((await original.runtime.getCatalog()).tools).toHaveLength(1);
      clock.setTime(original.runtime.lastUsedAt + 100);
    } finally {
      original.releaseLease();
    }
    sweep = manager.sweepIdleRuntimes();
    await withTestTimeout(server.terminationStarted, 2_000, "MCP idle disposal did not start");

    const cfg = { plugins: { enabled: false }, mcp: { servers: {} } };
    await manager.reloadConfig({ cfg });
    if (mode === "captured retirement") {
      expect(manager.peekSession({ sessionId: params.sessionId })).toBeUndefined();
      const captured = expectDefined(
        manager.captureSessionRetirement({ sessionId: params.sessionId }),
        "pending MCP disposal",
      );
      let retired = false;
      retirement = captured
        .retire(() => {})
        .then(() => {
          retired = true;
        });
      await nextTurn();
      expect(retired).toBe(false);
    }
    const acquiring = manager.acquire({ ...params, cfg });
    if (mode === "store retirement") {
      const captured = expectDefined(
        manager.captureStoreRetirement(params.sessionId),
        "closing store",
      );
      let retired = false;
      retirement = captured(source).then(() => {
        retired = true;
      });
      await nextTurn();
      expect(retired).toBe(false);
    }
    expect(manager.resolveSessionId(sessionKey)).toBe(params.sessionId);
    terminate.resolve();
    await Promise.all([sweep, retirement]);
    const successor = await acquiring;
    try {
      expect((await successor.runtime.getCatalog()).tools).toEqual([]);
    } finally {
      successor.releaseLease();
    }
    expect(manager.listRuntimeKeys()).toEqual([]);
    expect(manager.resolveSessionId(sessionKey)).toBeUndefined();
    expect(server.terminationCount()).toBe(1);
  } finally {
    terminate.resolve();
    await Promise.allSettled([sweep, retirement]);
    try {
      await manager.disposeAll();
    } finally {
      try {
        await server.close();
      } finally {
        await scheduler.stop();
      }
    }
  }
}

it.for(["idle sweep", "captured retirement", "store retirement"] as const)(
  "forgets an empty successor binding after %s settles",
  verifyPendingDisposal,
);

it.for(["success", "failure"] as const)(
  "joins the physical close during replacement (%s)",
  async (outcome, { signal }) => {
    const original = { started: createDeferred(), finish: createDeferred() };
    const successor = { started: createDeferred(), finish: createDeferred() };
    let current = original;
    const scheduler = createTestGatewayScheduler();
    const manager = createFixtureManager({
      scheduler,
      createRuntime: async (input) => {
        const disposal = current;
        return makeManagerRuntime(input, undefined, {
          joinCleanup: async () => {
            disposal.started.resolve();
            await disposal.finish.promise;
          },
        });
      },
    });
    const params = {
      sessionId: "reused",
      workspaceDir: tempDirTracker.make("mcp-reused-session-"),
      cfg: unopenedMcpConfig,
      manifestRegistry: { plugins: [] },
    };
    try {
      await manager.getOrCreate(params);
      current = successor;
      const replacing = manager.getOrCreate({
        ...params,
        cfg: {
          ...unopenedMcpConfig,
          mcp: { servers: { fixture: { command: process.execPath, args: ["--version"] } } },
        },
      });
      await withinTest(
        awaitGateBeforeSettlement(
          original.started.promise,
          replacing,
          "replacement skipped original cleanup",
        ),
        signal,
      );
      const captured = expectDefined(manager.captureSessionRetirement(params), "original disposal");
      let joined = false;
      const retirement = captured
        .retire(() => {})
        .finally(() => {
          joined = true;
        });
      await nextTurn();
      expect(joined).toBe(false);
      if (outcome === "failure") {
        const error = new Error("original transport cleanup failed");
        const failures = Promise.all([
          expect(retirement).rejects.toBe(error),
          expect(replacing).rejects.toBe(error),
        ]);
        original.finish.reject(error);
        await failures;
        await expect(captured.retire(() => {})).rejects.toBe(error);
        return;
      }
      original.finish.resolve();
      await Promise.all([retirement, replacing]);
      const secondClose = manager.disposeSession(params.sessionId);
      await withinTest(
        awaitGateBeforeSettlement(
          successor.started.promise,
          secondClose,
          "successor cleanup was skipped",
        ),
        signal,
      );
      // The old handle must finish while the new generation's close is still blocked.
      await withinTest(
        captured.retire(() => {}),
        signal,
      );
      successor.finish.resolve();
      await secondClose;
    } finally {
      original.finish.resolve();
      successor.finish.resolve();
      await manager.disposeAll();
      await scheduler.stop();
    }
  },
);
