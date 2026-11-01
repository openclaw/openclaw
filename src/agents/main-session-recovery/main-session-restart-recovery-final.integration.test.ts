import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  replaceSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import { loadUnfinishedDeliveries } from "../../infra/outbound/delivery-queue-storage.js";
import { installDeliveryQueueTmpDirHooks } from "../../infra/outbound/delivery-queue.test-helpers.js";
import { persistPendingFinalDeliveryMarker } from "../pending-final-delivery-marker.js";
import {
  confirmedExhaustedFinalReceipt,
  markSessionCompletedAfterRecoveryCheckpoint,
} from "./main-session-restart-recovery-checkpoint.js";
import { markOrphanedMainSessionForRecovery } from "./main-session-restart-recovery-marking.js";
import { recoverStore } from "./main-session-restart-recovery-store.js";

describe("exhausted recovery after a confirmed final", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function recordDeliveredFinal() {
    const target = {
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: path.join(fixtures.tmpDir(), "agents/main/sessions/sessions.json"),
    };
    const runId = "source-run";
    const sessionId = "source-session";
    const lifecycleRevision = "source-revision";
    const context = { channel: "matrix", to: "!source:example", threadId: "original" };
    const claim = {
      taskId: "child-source",
      taskRunId: "child-source",
      taskStatus: "succeeded" as const,
      sourceRunId: runId,
      requesterAgentId: target.agentId,
      requesterSessionKey: target.sessionKey,
      sessionId,
      lifecycleRevision,
    };
    const source: SessionEntry = {
      sessionId,
      lifecycleRevision,
      status: "running",
      updatedAt: Date.now(),
      activeWriterRunId: runId,
      lifecycleRunId: runId,
      restartRecoveryHarnessCompletion: claim,
      restartRecoveryDeliveryRunId: runId,
      restartRecoveryDeliverySourceRunId: runId,
      restartRecoveryDeliveryContext: context,
    };
    await replaceSessionEntry(target, source);
    const prepared = await persistPendingFinalDeliveryMarker({
      ...target,
      deliver: true,
      sessionStore: { [target.sessionKey]: source },
      sessionEntry: source,
      suppressVisibleSessionEffects: false,
      sessionReboundDuringRun: false,
      payloads: [{ text: "Original answer." }],
      deliveryContext: context,
      runOwnedSessionId: sessionId,
    });
    const pending = prepared.sessionEntry!.pendingFinalDelivery!;
    const intentId = pending.intentId!;
    const deliveryId = pending.deliveries![0]!.id;
    const receipt = await settlePendingFinalDelivery(
      {
        ...target,
        kind: "pending-final",
        sessionId,
        intentId,
        deliveryId,
        sessionWriterDeliveryAuthority: {
          ...target,
          expectedSessionId: sessionId,
          expectedLifecycleRevision: lifecycleRevision,
          expectedWriterRunId: runId,
          harnessCompletion: claim,
        },
      },
      "delivered",
      ["prepared"],
      {
        stateDir: fixtures.tmpDir(),
        preserveActivity: true,
        identifiedResult: {
          channel: "matrix",
          messageId: "original-platform-id",
          target: { kind: "room", id: context.to },
        },
      },
    );
    expect(receipt.state).toBe("delivered");
    await markOrphanedMainSessionForRecovery({ target, expectedSessionId: sessionId });
    await updateSessionEntry(target, () => ({
      mainRestartRecovery: { cycleId: "exhausted-cycle", revision: 1, chargedAttempts: 3 },
    }));
    const entry = loadSessionEntry(target)!;
    const proof = confirmedExhaustedFinalReceipt(target, entry);
    expect(proof?.durableFinalReceipt).toEqual({
      intentId,
      deliveryId,
      platformMessageId: "original-platform-id",
    });
    return { target, entry, pending: entry.pendingFinalDelivery!, proof: proof! };
  }

  it("settles once without a new send, model turn, or failure notice", async () => {
    const { target, entry, pending, proof } = await recordDeliveredFinal();
    const denied: Record<string, Partial<SessionEntry>> = {
      "unconfirmed receipt": { restartRecoveryTerminalDeliveryEvidence: [] },
      "different session": { sessionId: "replacement-session" },
      "different writer": { activeWriterRunId: "replacement-writer" },
      "different source run": { restartRecoveryDeliverySourceRunId: "replacement-run" },
      "different intent": { pendingFinalDelivery: { ...pending, intentId: "another-intent" } },
      "different original destination": {
        restartRecoveryDeliveryContext: { ...pending.context, to: "!different:example" },
      },
      "different target thread": {
        pendingFinalDelivery: {
          ...pending,
          context: { ...pending.context, threadId: "replacement" },
        },
      },
      "different delivery ID": {
        pendingFinalDelivery: {
          ...pending,
          deliveries: [{ state: "delivered", id: "another-delivery" }],
        },
      },
      "altered completion task": {
        restartRecoveryTerminalDeliveryEvidence: [
          { ...proof, harnessCompletion: { ...proof.harnessCompletion!, taskId: "other-task" } },
        ],
      },
      queued: {
        pendingFinalDelivery: {
          ...pending,
          deliveries: [{ ...pending.deliveries![0]!, state: "queued" }],
        },
      },
      unknown: {
        pendingFinalDelivery: {
          ...pending,
          deliveries: [{ ...pending.deliveries![0]!, state: "unknown" }],
        },
      },
      prepared: {
        pendingFinalDelivery: {
          ...pending,
          deliveries: [{ ...pending.deliveries![0]!, state: "prepared" }],
        },
      },
      media: {
        pendingFinalDelivery: {
          ...pending,
          kind: "replayable",
          text: "Chart.\nMEDIA:/tmp/chart.png",
        },
      },
    };
    for (const [reason, patch] of Object.entries(denied)) {
      expect(
        confirmedExhaustedFinalReceipt(target, { ...entry, ...patch }),
        reason,
      ).toBeUndefined();
    }
    const effect = vi.fn(async (): Promise<never> => {
      throw new Error("Unexpected recovery effect");
    });
    const recover = () =>
      recoverStore({
        storeAgentId: target.agentId,
        storePath: target.storePath,
        stateDir: fixtures.tmpDir(),
        cfg: {},
        handledSessionKeys: new Set(),
        gatewayRuntime: {
          dispatchAgent: effect,
          dispatchSessionMethod: effect,
          waitForAgent: effect,
          sendRecoveryNotice: effect,
        },
      });
    expect(await recover()).toEqual({ started: 0, settled: 1, failed: 0, skipped: 0 });
    expect(loadSessionEntry(target)).toMatchObject({ status: "done", abortedLastRun: false });
    expect(loadSessionEntry(target)?.pendingFinalDelivery).toBeUndefined();
    expect((await recover()).settled).toBe(0);
    expect(effect).not.toHaveBeenCalled();
    expect(await loadUnfinishedDeliveries(fixtures.tmpDir())).toEqual([]);
  });

  it("leaves a replacement owner alone if the writer changes after the scan", async () => {
    const { target, entry, pending, proof } = await recordDeliveredFinal();
    await updateSessionEntry(target, () => ({ activeWriterRunId: "new-writer" }));
    const result = await markSessionCompletedAfterRecoveryCheckpoint({
      ...target,
      entry,
      messages: [],
      reason: "delivered-terminal-receipt",
      pendingFinalDeliveryIntentId: pending.intentId,
      confirmedExhaustedReceipt: proof,
    });
    expect(result.outcome).toBe("changed");
    expect(loadSessionEntry(target)).toMatchObject({
      status: "running",
      activeWriterRunId: "new-writer",
      pendingFinalDelivery: { intentId: pending.intentId },
    });
  });
});
