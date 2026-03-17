import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpGatewayStore } from "./store.js";

const tempRoots: string[] = [];

async function createStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-store-"));
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

describe("AcpGatewayStore", () => {
  it("persists sessions, runs, events, checkpoints, delivery targets, leases, and idempotency across reload", async () => {
    const { root, store } = await createStore();
    const now = 1_700_000_000_000;

    await store.ensureSession({
      sessionKey: "agent:main:acp:test-session",
      now,
    });
    const lease = await store.acquireLease({
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
    await store.recordIdempotency({
      key: "req-1",
      scope: "turn.start",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      status: "accepted",
      now,
    });
    await store.appendWorkerEvent({
      nodeId: "node-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      seq: 1,
      event: {
        type: "text_delta",
        stream: "output",
        text: "hello",
      },
      now: now + 1,
    });
    await store.recordCheckpoint({
      checkpointKey: "projector:run-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      cursorSeq: 1,
      now: now + 2,
    });
    await store.recordRunDeliveryTarget({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      targetId: "primary",
      channel: "telegram",
      to: "telegram:thread-1",
      accountId: "acct-1",
      threadId: "thread-1",
      routeMode: "originating",
      now: now + 2,
    });
    await store.recordProjectorCheckpoint({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      targetId: "primary",
      cursorSeq: 1,
      deliveredEffectCount: 2,
      now: now + 2,
    });
    await store.resolveTerminal({
      nodeId: "node-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      terminalEventId: "term-1",
      finalSeq: 1,
      terminal: {
        kind: "completed",
        stopReason: "end_turn",
      },
      now: now + 3,
    });

    const reloaded = new AcpGatewayStore({
      storePath: path.join(root, "acp", "gateway-node-runtime-store.json"),
    });
    const snapshot = await reloaded.loadSnapshot();

    expect(snapshot.sessions["agent:main:acp:test-session"]).toMatchObject({
      sessionKey: "agent:main:acp:test-session",
      state: "idle",
      activeLeaseId: "lease-1",
      lastRunId: "run-1",
    });
    expect(snapshot.runs["run-1"]).toMatchObject({
      runId: "run-1",
      requestId: "req-1",
      startedByNodeId: "node-1",
      startedByLeaseId: "lease-1",
      startedByLeaseEpoch: 1,
      state: "completed",
      highestAcceptedSeq: 1,
      eventCount: 1,
      terminal: {
        terminalEventId: "term-1",
        finalSeq: 1,
        kind: "completed",
      },
    });
    expect(snapshot.events["run-1"]).toHaveLength(1);
    expect(snapshot.checkpoints["projector:run-1"]).toMatchObject({
      cursorSeq: 1,
    });
    expect(snapshot.checkpoints["projector:run-1:primary"]).toMatchObject({
      cursorSeq: 1,
      targetId: "primary",
      deliveredEffectCount: 2,
    });
    expect(snapshot.deliveryTargets["run-1:primary"]).toMatchObject({
      targetId: "primary",
      runId: "run-1",
      channel: "telegram",
      to: "telegram:thread-1",
      routeMode: "originating",
      toolReplayPolicy: "append_only_after_restart",
    });
    expect(snapshot.leases["agent:main:acp:test-session"]).toMatchObject({
      leaseId: "lease-1",
      leaseEpoch: 1,
      nodeId: "node-1",
    });
    expect(snapshot.idempotency["req-1"]).toMatchObject({
      key: "req-1",
      scope: "turn.start",
      status: "accepted",
    });
  });

  it("keeps runtime and projector checkpoints separate per run and per target", async () => {
    const { store } = await createStore();
    await store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-1",
      now: 10,
    });
    await store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      requestId: "req-1",
      now: 10,
    });

    await store.recordRunDeliveryTarget({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      targetId: "route-a",
      channel: "telegram",
      to: "telegram:a",
      routeMode: "originating",
      now: 11,
    });
    await store.recordRunDeliveryTarget({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      targetId: "route-b",
      channel: "discord",
      to: "discord:b",
      routeMode: "session",
      now: 12,
    });
    await store.recordCheckpoint({
      checkpointKey: "runtime:run-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      cursorSeq: 7,
      now: 13,
    });
    await store.recordProjectorCheckpoint({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      targetId: "route-a",
      cursorSeq: 3,
      deliveredEffectCount: 4,
      now: 14,
    });
    await store.recordProjectorCheckpoint({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      targetId: "route-b",
      cursorSeq: 5,
      deliveredEffectCount: 6,
      now: 15,
    });

    expect(await store.getCheckpoint("runtime:run-1")).toMatchObject({
      cursorSeq: 7,
    });
    expect(await store.getCheckpoint("projector:run-1:route-a")).toMatchObject({
      cursorSeq: 3,
      targetId: "route-a",
      deliveredEffectCount: 4,
    });
    expect(await store.getCheckpoint("projector:run-1:route-b")).toMatchObject({
      cursorSeq: 5,
      targetId: "route-b",
      deliveredEffectCount: 6,
    });
  });

  it("keeps run-scoped delivery targets isolated across multiple runs on one session", async () => {
    const { store } = await createStore();
    await store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-1",
      now: 10,
    });
    await store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-a",
      requestId: "req-a",
      now: 10,
    });
    await store.recordRunDeliveryTarget({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-a",
      targetId: "primary",
      channel: "telegram",
      to: "telegram:a",
      routeMode: "originating",
      now: 11,
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
      },
      now: 12,
    });
    await store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-b",
      requestId: "req-b",
      now: 13,
    });
    await store.recordRunDeliveryTarget({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-b",
      targetId: "primary",
      channel: "discord",
      to: "discord:b",
      routeMode: "session",
      now: 14,
    });

    expect(await store.getRunDeliveryTarget("run-a", "primary")).toMatchObject({
      runId: "run-a",
      channel: "telegram",
      to: "telegram:a",
    });
    expect(await store.getRunDeliveryTarget("run-b", "primary")).toMatchObject({
      runId: "run-b",
      channel: "discord",
      to: "discord:b",
    });
    expect(await store.listRunDeliveryTargets("run-a")).toMatchObject([
      {
        runId: "run-a",
        channel: "telegram",
      },
    ]);
    expect(await store.listRunDeliveryTargets("run-b")).toMatchObject([
      {
        runId: "run-b",
        channel: "discord",
      },
    ]);
  });

  it("idempotently absorbs byte-equivalent duplicate events and rejects mismatched duplicates", async () => {
    const { store } = await createStore();
    await store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-1",
      now: 10,
    });
    await store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      requestId: "req-1",
      now: 10,
    });

    const accepted = await store.appendWorkerEvent({
      nodeId: "node-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      seq: 1,
      event: {
        type: "status",
        text: "thinking",
      },
      now: 11,
    });
    const duplicate = await store.appendWorkerEvent({
      nodeId: "node-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      seq: 1,
      event: {
        type: "status",
        text: "thinking",
      },
      now: 12,
    });

    expect(accepted.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    await expect(
      store.appendWorkerEvent({
        nodeId: "node-1",
        sessionKey: "agent:main:acp:test-session",
        runId: "run-1",
        leaseId: "lease-1",
        leaseEpoch: 1,
        seq: 1,
        event: {
          type: "status",
          text: "different",
        },
        now: 13,
      }),
    ).rejects.toMatchObject({
      code: "ACP_NODE_DUPLICATE_EVENT_MISMATCH",
    });
  });

  it("marks an active lease and run as recoverable after node disconnect", async () => {
    const { store } = await createStore();
    await store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-1",
      now: 10,
    });
    await store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      requestId: "req-1",
      now: 10,
    });

    const marked = await store.markNodeDisconnected({
      nodeId: "node-1",
      reason: "start_accepted_no_events",
      now: 20,
    });

    expect(marked.sessions).toHaveLength(1);
    expect(marked.runs).toHaveLength(1);
    expect(await store.getSession("agent:main:acp:test-session")).toMatchObject({
      state: "recovering",
      lastRecoveryReason: "start_accepted_no_events",
    });
    expect(await store.getRun("run-1")).toMatchObject({
      state: "recovering",
      recoveryReason: "start_accepted_no_events",
    });
    expect(await store.getActiveLease("agent:main:acp:test-session")).toMatchObject({
      state: "suspect",
    });
  });

  it("binds a run to the lease epoch that started it and rejects replacement-epoch continuation", async () => {
    const { store } = await createStore();
    const firstLease = await store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-1",
      now: 10,
    });
    await store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      requestId: "req-1",
      now: 11,
    });
    const secondLease = await store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-2",
      now: 12,
    });

    await expect(
      store.appendWorkerEvent({
        nodeId: "node-1",
        sessionKey: "agent:main:acp:test-session",
        runId: "run-1",
        leaseId: secondLease.leaseId,
        leaseEpoch: secondLease.leaseEpoch,
        seq: 1,
        event: {
          type: "status",
          text: "wrong epoch",
        },
        now: 13,
      }),
    ).rejects.toMatchObject({
      code: "ACP_NODE_STALE_EPOCH",
    });

    await expect(
      store.resolveTerminal({
        nodeId: "node-1",
        sessionKey: "agent:main:acp:test-session",
        runId: "run-1",
        leaseId: secondLease.leaseId,
        leaseEpoch: secondLease.leaseEpoch,
        terminalEventId: "term-2",
        finalSeq: 0,
        terminal: {
          kind: "completed",
        },
        now: 14,
      }),
    ).rejects.toMatchObject({
      code: "ACP_NODE_STALE_EPOCH",
    });

    expect(firstLease.leaseEpoch).toBe(1);
  });

  it("rejects stale heartbeats from a completed run without refreshing the active lease", async () => {
    const { store } = await createStore();
    const lease = await store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-1",
      now: 10,
    });
    await store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      requestId: "req-1",
      now: 10,
    });
    await store.appendWorkerEvent({
      nodeId: "node-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      seq: 1,
      event: {
        type: "status",
        text: "running",
      },
      now: 11,
    });
    await store.resolveTerminal({
      nodeId: "node-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      terminalEventId: "term-1",
      finalSeq: 1,
      terminal: {
        kind: "completed",
      },
      now: 12,
    });
    await store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-2",
      requestId: "req-2",
      now: 13,
    });

    const leaseBefore = await store.getActiveLease("agent:main:acp:test-session");

    await expect(
      store.recordHeartbeat({
        nodeId: "node-1",
        sessionKey: "agent:main:acp:test-session",
        runId: "run-1",
        leaseId: lease.leaseId,
        leaseEpoch: lease.leaseEpoch,
        state: "running",
        nodeRuntimeSessionId: "runtime-stale",
        nodeWorkerRunId: "worker-stale",
        workerProtocolVersion: 1,
        ts: 20,
      }),
    ).rejects.toMatchObject({
      code: "ACP_NODE_INVALID_EVENT",
    });

    expect(await store.getSession("agent:main:acp:test-session")).toMatchObject({
      activeRunId: "run-2",
      state: "running",
    });
    expect(await store.getActiveLease("agent:main:acp:test-session")).toEqual(leaseBefore);
  });

  it("rejects suspect-lease terminals until same-node reconcile reactivates the lease", async () => {
    const { store } = await createStore();
    const lease = await store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-1",
      now: 10,
    });
    await store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      requestId: "req-1",
      now: 11,
    });
    await store.appendWorkerEvent({
      nodeId: "node-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      seq: 1,
      event: {
        type: "text_delta",
        stream: "output",
        text: "hello",
      },
      now: 12,
    });
    await store.markNodeDisconnected({
      nodeId: "node-1",
      reason: "node_disconnected",
      now: 13,
    });

    await expect(
      store.resolveTerminal({
        nodeId: "node-1",
        sessionKey: "agent:main:acp:test-session",
        runId: "run-1",
        leaseId: lease.leaseId,
        leaseEpoch: lease.leaseEpoch,
        terminalEventId: "term-1",
        finalSeq: 1,
        terminal: {
          kind: "completed",
        },
        now: 14,
      }),
    ).rejects.toMatchObject({
      code: "ACP_NODE_ACTIVE_LEASE_MISSING",
    });

    const reconciled = await store.reconcileSuspectLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      now: 15,
      nodeRuntimeSessionId: "runtime-1",
      workerProtocolVersion: 1,
    });

    expect(reconciled.lease.state).toBe("active");
    expect(reconciled.run).toMatchObject({
      state: "running",
    });

    await expect(
      store.resolveTerminal({
        nodeId: "node-1",
        sessionKey: "agent:main:acp:test-session",
        runId: "run-1",
        leaseId: lease.leaseId,
        leaseEpoch: lease.leaseEpoch,
        terminalEventId: "term-1",
        finalSeq: 1,
        terminal: {
          kind: "completed",
        },
        now: 16,
      }),
    ).resolves.toMatchObject({
      duplicate: false,
      run: {
        state: "completed",
      },
    });
  });

  it("reloads non-terminal state with a fresh restart grace window and allows same-node reconcile", async () => {
    const { root, store } = await createStore();
    const lease = await store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-1",
      now: 10,
    });
    await store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      requestId: "req-1",
      now: 11,
    });
    await store.appendWorkerEvent({
      nodeId: "node-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      seq: 1,
      event: {
        type: "status",
        text: "running",
      },
      now: 12,
    });

    const reloaded = new AcpGatewayStore({
      storePath: path.join(root, "acp", "gateway-node-runtime-store.json"),
    });
    const reloadedLease = await reloaded.getActiveLease("agent:main:acp:test-session");

    expect(await reloaded.getSession("agent:main:acp:test-session")).toMatchObject({
      state: "recovering",
      lastRecoveryReason: "gateway_restart_reconcile",
    });
    expect(await reloaded.getRun("run-1")).toMatchObject({
      state: "recovering",
      recoveryReason: "gateway_restart_reconcile",
    });
    expect(reloadedLease).toMatchObject({
      state: "suspect",
    });
    expect((reloadedLease?.expiresAt ?? 0) - (reloadedLease?.updatedAt ?? 0)).toBe(30_000);
    expect(await reloaded.listRecoverableSessions()).toMatchObject([
      {
        sessionKey: "agent:main:acp:test-session",
        state: "recovering",
      },
    ]);

    await expect(
      reloaded.reconcileSuspectLease({
        sessionKey: "agent:main:acp:test-session",
        nodeId: "node-1",
        leaseId: reloadedLease?.leaseId ?? "",
        leaseEpoch: reloadedLease?.leaseEpoch ?? 0,
        now: (reloadedLease?.updatedAt ?? 0) + 1,
        nodeRuntimeSessionId: "runtime-restart",
        nodeWorkerRunId: "worker-restart",
        workerProtocolVersion: 1,
      }),
    ).resolves.toMatchObject({
      lease: {
        state: "active",
        nodeRuntimeSessionId: "runtime-restart",
        nodeWorkerRunId: "worker-restart",
        workerProtocolVersion: 1,
      },
      run: {
        state: "running",
      },
      session: {
        state: "running",
      },
    });
  });

  it("persists lost state when a restart-expired heartbeat is rejected on ingress", async () => {
    const { root, store } = await createStore();
    const lease = await store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-1",
      now: 10,
    });
    await store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      requestId: "req-1",
      now: 11,
    });
    await store.appendWorkerEvent({
      nodeId: "node-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      seq: 1,
      event: {
        type: "status",
        text: "running",
      },
      now: 12,
    });

    const reloaded = new AcpGatewayStore({
      storePath: path.join(root, "acp", "gateway-node-runtime-store.json"),
    });
    const reloadedLease = await reloaded.getActiveLease("agent:main:acp:test-session");
    const expiredTs = (reloadedLease?.expiresAt ?? 0) + 1;

    await expect(
      reloaded.recordHeartbeat({
        nodeId: "node-1",
        sessionKey: "agent:main:acp:test-session",
        runId: "run-1",
        leaseId: reloadedLease?.leaseId ?? "",
        leaseEpoch: reloadedLease?.leaseEpoch ?? 0,
        state: "running",
        nodeRuntimeSessionId: "runtime-expired",
        nodeWorkerRunId: "worker-expired",
        workerProtocolVersion: 1,
        ts: expiredTs,
      }),
    ).rejects.toMatchObject({
      code: "ACP_NODE_ACTIVE_LEASE_MISSING",
    });

    expect(await reloaded.getActiveLease("agent:main:acp:test-session")).toMatchObject({
      state: "lost",
    });
    expect(await reloaded.getSession("agent:main:acp:test-session")).toMatchObject({
      state: "recovering",
      lastRecoveryReason: "lease_expired",
      activeRunId: "run-1",
    });
    expect(await reloaded.getRun("run-1")).toMatchObject({
      state: "recovering",
      recoveryReason: "lease_expired",
    });
  });

  it("marks suspect leases as lost after grace expiry without auto-failover", async () => {
    const { store } = await createStore();
    const lease = await store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-1",
      now: 10,
    });
    await store.startRun({
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      requestId: "req-1",
      now: 11,
    });
    await store.appendWorkerEvent({
      nodeId: "node-1",
      sessionKey: "agent:main:acp:test-session",
      runId: "run-1",
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      seq: 1,
      event: {
        type: "status",
        text: "running",
      },
      now: 12,
    });
    await store.markNodeDisconnected({
      nodeId: "node-1",
      reason: "node_disconnected",
      now: 20,
    });

    const expired = await store.expireSuspectLeases({
      now: 20 + 30_000,
    });

    expect(expired.leases).toMatchObject([
      {
        leaseId: "lease-1",
        state: "lost",
      },
    ]);
    expect(await store.getActiveLease("agent:main:acp:test-session")).toMatchObject({
      state: "lost",
    });
    expect(await store.getSession("agent:main:acp:test-session")).toMatchObject({
      state: "recovering",
      lastRecoveryReason: "lease_expired",
      activeRunId: "run-1",
    });
    expect(await store.getRun("run-1")).toMatchObject({
      state: "recovering",
      recoveryReason: "lease_expired",
    });
    await expect(
      store.reconcileSuspectLease({
        sessionKey: "agent:main:acp:test-session",
        nodeId: "node-1",
        leaseId: lease.leaseId,
        leaseEpoch: lease.leaseEpoch,
        now: 20 + 30_000,
      }),
    ).rejects.toMatchObject({
      code: "ACP_NODE_ACTIVE_LEASE_MISSING",
    });
  });
});
