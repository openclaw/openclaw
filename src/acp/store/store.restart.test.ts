import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpGatewayStore } from "./store.js";

const tempRoots: string[] = [];

async function createStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-store-restart-"));
  tempRoots.push(root);
  return {
    root,
    store: new AcpGatewayStore({
      storePath: path.join(root, "acp", "gateway-node-runtime-store.json"),
    }),
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })),
  );
});

describe("AcpGatewayStore restart recovery", () => {
  it("keeps projector replay state independent from the runtime cursor after reload", async () => {
    const { root, store } = await createStore();
    const now = 1_700_000_000_000;

    await store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-1",
      now,
    });
    await store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      requestId: "req-1",
      now,
    });
    await store.recordRunDeliveryTarget({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      targetId: "primary",
      channel: "telegram",
      to: "telegram:thread-1",
      routeMode: "originating",
      now: now + 1,
    });
    await store.appendWorkerEvent({
      nodeId: "node-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      seq: 1,
      event: {
        type: "text_delta",
        stream: "output",
        text: "hello",
      },
      now: now + 2,
    });
    await store.appendWorkerEvent({
      nodeId: "node-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      seq: 2,
      event: {
        type: "text_delta",
        stream: "output",
        text: " world",
      },
      now: now + 3,
    });
    await store.recordCheckpoint({
      checkpointKey: "runtime:run-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      cursorSeq: 2,
      now: now + 4,
    });

    const restarted = new AcpGatewayStore({
      storePath: path.join(root, "acp", "gateway-node-runtime-store.json"),
    });

    expect(await restarted.getCheckpoint("runtime:run-1")).toMatchObject({
      cursorSeq: 2,
    });
    expect(await restarted.getCheckpoint("projector:run-1:primary")).toBeNull();
    expect(
      await restarted.getProjectionState({ runId: "run-1", targetId: "primary" }),
    ).toMatchObject({
      checkpoint: null,
      run: {
        runId: "run-1",
        state: "recovering",
        recoveryReason: "gateway_restart_reconcile",
        highestAcceptedSeq: 2,
      },
      target: {
        targetKey: "run-1:primary",
        runId: "run-1",
        to: "telegram:thread-1",
      },
    });
    const replayEvents = await restarted.listRunEvents("run-1");
    expect(replayEvents.map((event) => event.seq)).toEqual([1, 2]);
  });

  it("keeps terminal-persisted unprojected runs discoverable after reload", async () => {
    const { root, store } = await createStore();
    const now = 1_700_000_100_000;

    await store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-1",
      now,
    });
    await store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-terminal",
      requestId: "req-terminal",
      now,
    });
    await store.recordRunDeliveryTarget({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-terminal",
      targetId: "primary",
      channel: "telegram",
      to: "telegram:thread-terminal",
      routeMode: "originating",
      inboundAudio: true,
      sessionTtsAuto: "always",
      ttsChannel: "telegram",
      now: now + 1,
    });
    await store.appendWorkerEvent({
      nodeId: "node-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-terminal",
      leaseId: "lease-1",
      leaseEpoch: 1,
      seq: 1,
      event: {
        type: "text_delta",
        stream: "output",
        text: "final output",
      },
      now: now + 2,
    });
    await store.resolveTerminal({
      nodeId: "node-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-terminal",
      leaseId: "lease-1",
      leaseEpoch: 1,
      terminalEventId: "term-1",
      finalSeq: 1,
      terminal: {
        kind: "completed",
        stopReason: "end_turn",
      },
      now: now + 3,
    });

    const restarted = new AcpGatewayStore({
      storePath: path.join(root, "acp", "gateway-node-runtime-store.json"),
    });

    expect(await restarted.listRecoverableSessions()).toEqual([]);
    expect(await restarted.listDeliveryTargets()).toMatchObject([
      {
        targetKey: "run-terminal:primary",
        runId: "run-terminal",
        to: "telegram:thread-terminal",
      },
    ]);
    expect(
      await restarted.getProjectionState({
        runId: "run-terminal",
        targetId: "primary",
      }),
    ).toMatchObject({
      checkpoint: null,
      run: {
        runId: "run-terminal",
        state: "completed",
        terminal: {
          terminalEventId: "term-1",
          kind: "completed",
          finalSeq: 1,
        },
      },
      target: {
        targetKey: "run-terminal:primary",
        runId: "run-terminal",
        inboundAudio: true,
        sessionTtsAuto: "always",
        ttsChannel: "telegram",
      },
    });
  });

  it("keeps pending synthetic-final recovery state durable across reload", async () => {
    const { root, store } = await createStore();
    const now = 1_700_000_150_000;

    await store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-1",
      now,
    });
    await store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-pending-final",
      requestId: "req-pending-final",
      now,
    });
    await store.recordRunDeliveryTarget({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-pending-final",
      targetId: "primary",
      channel: "telegram",
      to: "telegram:thread-pending",
      routeMode: "originating",
      sessionTtsAuto: "always",
      ttsChannel: "telegram",
      now: now + 1,
    });
    await store.appendWorkerEvent({
      nodeId: "node-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-pending-final",
      leaseId: "lease-1",
      leaseEpoch: 1,
      seq: 1,
      event: {
        type: "text_delta",
        stream: "output",
        text: "pending final replay",
      },
      now: now + 2,
    });
    await store.resolveTerminal({
      nodeId: "node-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-pending-final",
      leaseId: "lease-1",
      leaseEpoch: 1,
      terminalEventId: "term-pending",
      finalSeq: 1,
      terminal: {
        kind: "completed",
        stopReason: "end_turn",
      },
      now: now + 3,
    });
    await store.recordProjectorCheckpoint({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-pending-final",
      targetId: "primary",
      cursorSeq: 1,
      deliveredEffectCount: 1,
      now: now + 4,
    });
    await store.recordProjectorPendingSyntheticFinal({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-pending-final",
      targetId: "primary",
      cursorSeq: 1,
      deliveredEffectCount: 2,
      now: now + 5,
    });

    const restarted = new AcpGatewayStore({
      storePath: path.join(root, "acp", "gateway-node-runtime-store.json"),
    });

    expect(await restarted.getCheckpoint("projector:run-pending-final:primary")).toMatchObject({
      runId: "run-pending-final",
      cursorSeq: 1,
      deliveredEffectCount: 1,
      pendingSyntheticFinalEffectCount: 2,
      pendingSyntheticFinalCursorSeq: 1,
    });
    expect(
      await restarted.getProjectionState({
        runId: "run-pending-final",
        targetId: "primary",
      }),
    ).toMatchObject({
      checkpoint: {
        deliveredEffectCount: 1,
        pendingSyntheticFinalEffectCount: 2,
      },
      target: {
        sessionTtsAuto: "always",
        ttsChannel: "telegram",
      },
    });
  });

  it("keeps prepared synthetic-final recovery state durable across reload", async () => {
    const { root, store } = await createStore();
    const now = 1_700_000_175_000;

    await store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-1",
      now,
    });
    await store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-prepared-final",
      requestId: "req-prepared-final",
      now,
    });
    await store.recordRunDeliveryTarget({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-prepared-final",
      targetId: "primary",
      channel: "telegram",
      to: "telegram:thread-prepared",
      routeMode: "originating",
      sessionTtsAuto: "always",
      ttsChannel: "telegram",
      now: now + 1,
    });
    await store.appendWorkerEvent({
      nodeId: "node-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-prepared-final",
      leaseId: "lease-1",
      leaseEpoch: 1,
      seq: 1,
      event: {
        type: "text_delta",
        stream: "output",
        text: "prepared final replay",
      },
      now: now + 2,
    });
    await store.resolveTerminal({
      nodeId: "node-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-prepared-final",
      leaseId: "lease-1",
      leaseEpoch: 1,
      terminalEventId: "term-prepared",
      finalSeq: 1,
      terminal: {
        kind: "completed",
        stopReason: "end_turn",
      },
      now: now + 3,
    });
    await store.recordProjectorCheckpoint({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-prepared-final",
      targetId: "primary",
      cursorSeq: 1,
      deliveredEffectCount: 1,
      now: now + 4,
    });
    await store.recordProjectorPreparedSyntheticFinal({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-prepared-final",
      targetId: "primary",
      cursorSeq: 1,
      deliveredEffectCount: 2,
      payload: {
        mediaUrl: "https://example.com/prepared-final.mp3",
        audioAsVoice: true,
      },
      now: now + 5,
    });

    const restarted = new AcpGatewayStore({
      storePath: path.join(root, "acp", "gateway-node-runtime-store.json"),
    });

    expect(await restarted.getCheckpoint("projector:run-prepared-final:primary")).toMatchObject({
      runId: "run-prepared-final",
      cursorSeq: 1,
      deliveredEffectCount: 1,
      preparedSyntheticFinalEffectCount: 2,
      preparedSyntheticFinalCursorSeq: 1,
      preparedSyntheticFinalMediaUrl: "https://example.com/prepared-final.mp3",
      preparedSyntheticFinalAudioAsVoice: true,
    });
  });

  it("keeps run-owned delivery targets isolated across reload even when a later run replaces the session", async () => {
    const { root, store } = await createStore();
    const now = 1_700_000_200_000;

    await store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-1",
      now,
    });
    await store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-a",
      requestId: "req-a",
      now,
    });
    await store.recordRunDeliveryTarget({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-a",
      targetId: "primary",
      channel: "telegram",
      to: "telegram:route-a",
      routeMode: "originating",
      now: now + 1,
    });
    await store.resolveTerminal({
      nodeId: "node-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-a",
      leaseId: "lease-1",
      leaseEpoch: 1,
      terminalEventId: "term-a",
      finalSeq: 0,
      terminal: {
        kind: "completed",
        stopReason: "end_turn",
      },
      now: now + 2,
    });

    await store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-2",
      now: now + 3,
    });
    await store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-b",
      requestId: "req-b",
      now: now + 4,
    });
    await store.recordRunDeliveryTarget({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-b",
      targetId: "primary",
      channel: "discord",
      to: "discord:route-b",
      routeMode: "session",
      now: now + 5,
    });

    const restarted = new AcpGatewayStore({
      storePath: path.join(root, "acp", "gateway-node-runtime-store.json"),
    });

    expect(await restarted.getRunDeliveryTarget("run-a", "primary")).toMatchObject({
      targetKey: "run-a:primary",
      runId: "run-a",
      to: "telegram:route-a",
    });
    expect(await restarted.getRunDeliveryTarget("run-b", "primary")).toMatchObject({
      targetKey: "run-b:primary",
      runId: "run-b",
      to: "discord:route-b",
    });
    expect(
      (await restarted.listDeliveryTargets()).map((target) => target.targetKey).toSorted(),
    ).toEqual(["run-a:primary", "run-b:primary"]);
  });
});
