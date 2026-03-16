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
  it("persists sessions, runs, events, checkpoints, leases, and idempotency across reload", async () => {
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

    await store.reconcileSuspectLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: secondLease.leaseId,
      leaseEpoch: secondLease.leaseEpoch,
      now: 14,
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
        now: 15,
      }),
    ).rejects.toMatchObject({
      code: "ACP_NODE_STALE_EPOCH",
    });

    expect(firstLease.leaseEpoch).toBe(1);
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

  it("reloads non-terminal state as recovering with gateway_restart_reconcile", async () => {
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

    expect(await reloaded.getSession("agent:main:acp:test-session")).toMatchObject({
      state: "recovering",
      lastRecoveryReason: "gateway_restart_reconcile",
    });
    expect(await reloaded.getRun("run-1")).toMatchObject({
      state: "recovering",
      recoveryReason: "gateway_restart_reconcile",
    });
    expect(await reloaded.getActiveLease("agent:main:acp:test-session")).toMatchObject({
      state: "suspect",
    });
    expect(await reloaded.listRecoverableSessions()).toMatchObject([
      {
        sessionKey: "agent:main:acp:test-session",
        state: "recovering",
      },
    ]);
  });
});
