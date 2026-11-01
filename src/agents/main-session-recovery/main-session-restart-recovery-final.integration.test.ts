import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { loadUnfinishedDeliveries } from "../../infra/outbound/delivery-queue-storage.js";
import { installDeliveryQueueTmpDirHooks } from "../../infra/outbound/delivery-queue.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { persistPendingFinalDeliveryMarker } from "../pending-final-delivery-marker.js";
import {
  claimMainSessionRecoveryOwner,
  refreshMainSessionRecoveryOwner,
} from "./main-session-recovery-store.js";
import { markOrphanedMainSessionForRecovery } from "./main-session-restart-recovery-marking.js";
import { recoverStore } from "./main-session-restart-recovery-store.js";

describe("prepared final startup recovery", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  const dispatch = vi.fn(async (): Promise<never> => {
    throw new Error("A prepared final must not dispatch an agent or a recovery notice");
  });
  const gatewayRuntime: GatewayRecoveryRuntime = {
    dispatchAgent: dispatch,
    dispatchSessionMethod: dispatch,
    waitForAgent: dispatch,
    sendRecoveryNotice: dispatch,
  };
  let prepareBarrier: (() => Promise<void>) | undefined;
  const send = vi.fn(async (_params: { to: string; text: string }) => ({
    channel: "matrix",
    messageId: "final-1",
  }));
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
    dispatch.mockClear();
    send.mockClear();
    prepareBarrier = undefined;
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              deliveryCapabilities: { durableFinal: { text: true } },
              sendText: async ({
                to,
                text,
                onPlatformSendDispatch,
                assertDirectAdapterHandoff,
              }) => {
                await prepareBarrier?.();
                await onPlatformSendDispatch?.();
                assertDirectAdapterHandoff?.();
                return send({ to, text });
              },
            },
          }),
        },
      ]),
    );
  });
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
  });

  async function fixture() {
    const target = {
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: path.join(fixtures.tmpDir(), "agents/main/sessions/sessions.json"),
    };
    const entry = {
      sessionId: "source-session",
      status: "running" as const,
      lifecycleRevision: "source-revision",
      activeWriterRunId: "source-run",
      lifecycleRunId: "source-run",
      restartRecoveryDeliveryRunId: "source-run",
      restartRecoveryDeliverySourceRunId: "source-run",
      restartRecoveryDeliveryContext: { channel: "matrix", to: "!source:example" },
      updatedAt: Date.now(),
    };
    await replaceSessionEntry(target, entry);
    const marker = await persistPendingFinalDeliveryMarker({
      ...target,
      deliver: true,
      sessionStore: { [target.sessionKey]: entry },
      sessionEntry: entry,
      suppressVisibleSessionEffects: false,
      sessionReboundDuringRun: false,
      payloads: [{ text: "The completed original answer." }],
      deliveryContext: entry.restartRecoveryDeliveryContext,
      runOwnedSessionId: entry.sessionId,
    });
    expect(marker.pendingFinalDeliveryMarkerPersisted).toBe(true);
    expect(await loadUnfinishedDeliveries(fixtures.tmpDir())).toEqual([]);
    await markOrphanedMainSessionForRecovery({ target, expectedSessionId: entry.sessionId });
    expect(loadSessionEntry(target)?.abortedLastRun).toBe(true);
    const recover = () =>
      recoverStore({
        storeAgentId: target.agentId,
        storePath: target.storePath,
        stateDir: fixtures.tmpDir(),
        cfg: {},
        handledSessionKeys: new Set(),
        gatewayRuntime,
      });
    return { target, recover, marker: marker.sessionEntry!.pendingFinalDelivery! };
  }

  it.each([0, 3])(
    "delivers the producer's prepared answer once with %i charged model attempts",
    async (chargedAttempts) => {
      const { target, recover } = await fixture();
      if (chargedAttempts) {
        await updateSessionEntry(target, () => ({
          mainRestartRecovery: { cycleId: "exhausted-final-cycle", revision: 1, chargedAttempts },
        }));
      }
      expect(await recover()).toEqual({ started: 0, settled: 1, failed: 0, skipped: 0 });
      expect(send).toHaveBeenCalledExactlyOnceWith({
        to: "!source:example",
        text: "The completed original answer.",
      });
      expect(loadSessionEntry(target)).toMatchObject({ status: "done", abortedLastRun: false });
      expect(loadSessionEntry(target)?.pendingFinalDelivery).toBeUndefined();
      expect(await loadUnfinishedDeliveries(fixtures.tmpDir())).toEqual([]);
      await recover();
      expect(send).toHaveBeenCalledOnce();
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("requires the original sender authority before delivering a saved internal answer", async () => {
    const { target, recover } = await fixture();
    await updateSessionEntry(target, () => ({ restartRecoverySourceIngress: "internal" }));

    await recover();

    expect(send).not.toHaveBeenCalledWith({
      to: "!source:example",
      text: "The completed original answer.",
    });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "matrix",
        to: "!source:example",
        idempotencyKey: expect.stringMatching(/^main-session-restart-recovery:/),
      }),
    );
    expect(loadSessionEntry(target)?.mainRestartRecovery?.tombstone).toBeDefined();
  });

  it("defers to the exact queued owner while a second recovery scan overlaps", async () => {
    const { target, recover, marker } = await fixture();
    const entered = createDeferred();
    const release = createDeferred();
    prepareBarrier = async () => {
      entered.resolve();
      await release.promise;
    };
    const first = recover();
    await entered.promise;
    try {
      expect(
        (await loadUnfinishedDeliveries(fixtures.tmpDir()))[0]?.deliveryCompletion,
      ).toMatchObject({
        kind: "pending-final",
        deliveryId: marker.deliveries![0]!.id,
        intentId: marker.intentId,
      });
      expect(await recover()).toEqual({ started: 0, settled: 0, failed: 0, skipped: 1 });
      expect(send).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    await first;
    expect(send).toHaveBeenCalledOnce();
    expect(loadSessionEntry(target)?.status).toBe("done");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["policy", "invalid-route", "multiple-deliveries"] as const)(
    "does not fall back to model recovery for a captured final with %s",
    async (change) => {
      const { target, recover, marker } = await fixture();
      await updateSessionEntry(target, () =>
        change === "policy"
          ? { sendPolicy: "deny" }
          : {
              pendingFinalDelivery: {
                ...marker,
                ...(change === "invalid-route"
                  ? { context: { channel: "matrix", to: "" } }
                  : {
                      deliveries: [
                        ...marker.deliveries!,
                        { id: "second-prepared-delivery", state: "prepared" as const },
                      ],
                    }),
              },
            },
      );
      expect(await recover()).toEqual({ started: 0, settled: 0, failed: 0, skipped: 1 });
      expect(send).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(loadSessionEntry(target)?.pendingFinalDelivery?.intentId).toBe(marker.intentId);
      expect(await loadUnfinishedDeliveries(fixtures.tmpDir())).toEqual([]);
    },
  );

  it.each(["writer", "route", "route-removed", "policy"] as const)(
    "fences a changed %s before platform I/O",
    async (change) => {
      const { target, recover } = await fixture();
      prepareBarrier = async () => {
        await updateSessionEntry(target, (entry) =>
          change === "writer"
            ? { activeWriterRunId: "new-run" }
            : change === "policy"
              ? { sendPolicy: "deny" }
              : {
                  pendingFinalDelivery: {
                    ...entry.pendingFinalDelivery!,
                    context:
                      change === "route-removed"
                        ? undefined
                        : { channel: "matrix", to: "!different:example" },
                  },
                },
        );
      };
      await recover();
      expect(send).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("does not repeat a transport attempt whose result was lost", async () => {
    const { target, recover } = await fixture();
    send.mockRejectedValueOnce(new Error("transport result lost after dispatch"));
    await recover();
    expect(send).toHaveBeenCalledOnce();
    const pending = loadSessionEntry(target)?.pendingFinalDelivery;
    const deliveryId = pending?.deliveries?.[0]?.id;
    // The durable queue retains ambiguity; its source completion stays queued
    // until that owner reconciles or settles the attempt.
    expect(pending?.deliveries).toEqual([{ id: deliveryId, state: "queued" }]);
    expect(await loadUnfinishedDeliveries(fixtures.tmpDir())).toMatchObject([
      {
        id: deliveryId,
        recoveryState: "unknown_after_send",
        deliveryCompletion: { kind: "pending-final", intentId: pending?.intentId, deliveryId },
      },
    ]);
    expect(await recover()).toEqual({ started: 0, settled: 0, failed: 0, skipped: 1 });
    expect(send).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("preserves a real foreground claim admitted during final preparation", async () => {
    const { target, recover } = await fixture();
    let claim: Awaited<ReturnType<typeof claimMainSessionRecoveryOwner>> | undefined;
    prepareBarrier = async () => {
      claim = await claimMainSessionRecoveryOwner({
        target,
        sessionId: "source-session",
        runId: "new-foreground-run",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      });
      expect(claim.kind).toBe("claimed");
    };
    await recover();
    if (claim?.kind !== "claimed") {
      throw new Error("expected the real admitted foreground claim");
    }
    const retained = await refreshMainSessionRecoveryOwner(claim.lease);
    expect({ sends: send.mock.calls.length, ownerRetained: Boolean(retained) }).toEqual({
      sends: 0,
      ownerRetained: true,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
