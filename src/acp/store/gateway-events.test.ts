import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAcpNodeWorker } from "../test-harness/fake-acp-node-worker.js";
import { AcpGatewayNodeRuntime, __testing } from "./gateway-events.js";

const tempRoots: string[] = [];
let envStateDir: string | undefined;

async function createRuntime() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-gateway-events-"));
  tempRoots.push(root);
  process.env.OPENCLAW_STATE_DIR = root;
  const runtime = new AcpGatewayNodeRuntime();
  __testing.setAcpGatewayNodeRuntimeForTests(runtime);
  return { root, runtime };
}

beforeEach(() => {
  envStateDir = process.env.OPENCLAW_STATE_DIR;
});

afterEach(async () => {
  if (envStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = envStateDir;
  }
  __testing.resetAcpGatewayNodeRuntimeForTests();
  await Promise.all(
    tempRoots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })),
  );
});

describe("AcpGatewayNodeRuntime", () => {
  it("rejects replacement-epoch worker events for a run started by the old epoch", async () => {
    const { runtime } = await createRuntime();
    const store = runtime.store;

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
      now: 10,
    });
    const secondLease = await store.acquireLease({
      sessionKey: "agent:main:acp:test-session",
      nodeId: "node-1",
      leaseId: "lease-2",
      now: 20,
    });

    const worker = new FakeAcpNodeWorker("node-1");
    await expect(
      worker.play([
        {
          kind: "event",
          event: "acp.worker.event",
          payload: {
            nodeId: "node-1",
            sessionKey: "agent:main:acp:test-session",
            runId: "run-1",
            leaseId: firstLease.leaseId,
            leaseEpoch: firstLease.leaseEpoch,
            seq: 1,
            event: {
              type: "status",
              text: "stale",
            },
          },
        },
      ]),
    ).rejects.toMatchObject({
      code: "ACP_NODE_STALE_EPOCH",
    });

    await expect(
      worker.play([
        {
          kind: "event",
          event: "acp.worker.event",
          payload: {
            nodeId: "node-1",
            sessionKey: "agent:main:acp:test-session",
            runId: "run-1",
            leaseId: secondLease.leaseId,
            leaseEpoch: secondLease.leaseEpoch,
            seq: 1,
            event: {
              type: "text_delta",
              stream: "output",
              text: "fresh",
            },
          },
        },
      ]),
    ).rejects.toMatchObject({
      code: "ACP_NODE_STALE_EPOCH",
    });

    expect(await store.listRunEvents("run-1")).toHaveLength(0);
  });

  it("keeps a single canonical terminal authority via acp.worker.terminal", async () => {
    const { runtime } = await createRuntime();
    const store = runtime.store;

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
    const worker = new FakeAcpNodeWorker("node-1");

    await worker.play([
      {
        kind: "event",
        event: "acp.worker.event",
        payload: {
          nodeId: "node-1",
          sessionKey: "agent:main:acp:test-session",
          runId: "run-1",
          leaseId: lease.leaseId,
          leaseEpoch: lease.leaseEpoch,
          seq: 1,
          event: {
            type: "text_delta",
            stream: "output",
            text: "hi",
          },
        },
      },
      {
        kind: "event",
        event: "acp.worker.terminal",
        payload: {
          nodeId: "node-1",
          sessionKey: "agent:main:acp:test-session",
          runId: "run-1",
          leaseId: lease.leaseId,
          leaseEpoch: lease.leaseEpoch,
          terminalEventId: "term-1",
          finalSeq: 1,
          terminal: {
            kind: "completed",
            stopReason: "done",
          },
        },
      },
      {
        kind: "event",
        event: "acp.worker.terminal",
        payload: {
          nodeId: "node-1",
          sessionKey: "agent:main:acp:test-session",
          runId: "run-1",
          leaseId: lease.leaseId,
          leaseEpoch: lease.leaseEpoch,
          terminalEventId: "term-1",
          finalSeq: 1,
          terminal: {
            kind: "completed",
            stopReason: "done",
          },
        },
      },
    ]);

    await expect(
      worker.play([
        {
          kind: "event",
          event: "acp.worker.terminal",
          payload: {
            nodeId: "node-1",
            sessionKey: "agent:main:acp:test-session",
            runId: "run-1",
            leaseId: lease.leaseId,
            leaseEpoch: lease.leaseEpoch,
            terminalEventId: "term-2",
            finalSeq: 1,
            terminal: {
              kind: "failed",
              errorMessage: "late conflict",
            },
          },
        },
      ]),
    ).rejects.toMatchObject({
      code: "ACP_NODE_TERMINAL_CONFLICT",
    });

    expect(await store.getRun("run-1")).toMatchObject({
      state: "completed",
      terminal: {
        terminalEventId: "term-1",
        finalSeq: 1,
        kind: "completed",
      },
    });
  });

  it("records a recoverable state after disconnect before first event", async () => {
    const { runtime } = await createRuntime();
    const store = runtime.store;

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
    const worker = new FakeAcpNodeWorker("node-1");

    await worker.play([
      {
        kind: "disconnect",
        reason: "start_accepted_no_events",
        now: 20,
      },
    ]);

    expect(await store.listRecoverableSessions()).toMatchObject([
      {
        sessionKey: "agent:main:acp:test-session",
        state: "recovering",
      },
    ]);
    expect(await store.getRun("run-1")).toMatchObject({
      state: "recovering",
      recoveryReason: "start_accepted_no_events",
    });
  });

  it("accepts same-node heartbeat resume after restart within the refreshed grace window", async () => {
    const { runtime } = await createRuntime();
    const store = runtime.store;

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

    const restarted = new AcpGatewayNodeRuntime();
    const restartedLease = await restarted.store.getActiveLease("agent:main:acp:test-session");

    expect(restartedLease).toMatchObject({
      state: "suspect",
    });
    expect((restartedLease?.expiresAt ?? 0) - (restartedLease?.updatedAt ?? 0)).toBe(30_000);

    await expect(
      restarted.ingestNodeEvent("node-1", {
        event: "acp.worker.heartbeat",
        payloadJSON: JSON.stringify({
          nodeId: "node-1",
          sessionKey: "agent:main:acp:test-session",
          runId: "run-1",
          leaseId: restartedLease?.leaseId ?? "",
          leaseEpoch: restartedLease?.leaseEpoch ?? 0,
          state: "running",
          nodeRuntimeSessionId: "runtime-restart",
          nodeWorkerRunId: "worker-restart",
          workerProtocolVersion: 1,
          ts: (restartedLease?.updatedAt ?? 0) + 1,
        }),
      }),
    ).resolves.toBe(true);

    expect(await restarted.store.getActiveLease("agent:main:acp:test-session")).toMatchObject({
      state: "active",
      nodeRuntimeSessionId: "runtime-restart",
      nodeWorkerRunId: "worker-restart",
      workerProtocolVersion: 1,
    });
    expect(await restarted.store.getRun("run-1")).toMatchObject({
      state: "running",
    });
  });

  it("rejects suspect-lease terminals until explicit reconcile succeeds", async () => {
    const { runtime } = await createRuntime();
    const store = runtime.store;
    const now = Date.now();

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
    const worker = new FakeAcpNodeWorker("node-1");

    await worker.play([
      {
        kind: "event",
        event: "acp.worker.event",
        payload: {
          nodeId: "node-1",
          sessionKey: "agent:main:acp:test-session",
          runId: "run-1",
          leaseId: lease.leaseId,
          leaseEpoch: lease.leaseEpoch,
          seq: 1,
          event: {
            type: "status",
            text: "working",
          },
        },
      },
      {
        kind: "disconnect",
        reason: "node_disconnected",
        now: now + 10,
      },
    ]);

    await expect(
      worker.play([
        {
          kind: "event",
          event: "acp.worker.terminal",
          payload: {
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
          },
        },
      ]),
    ).rejects.toMatchObject({
      code: "ACP_NODE_ACTIVE_LEASE_MISSING",
    });

    await worker.play([
      {
        kind: "reconcile",
        sessionKey: "agent:main:acp:test-session",
        leaseId: lease.leaseId,
        leaseEpoch: lease.leaseEpoch,
        now: now + 11,
        workerProtocolVersion: 1,
      },
      {
        kind: "event",
        event: "acp.worker.terminal",
        payload: {
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
        },
      },
    ]);

    expect(await store.getRun("run-1")).toMatchObject({
      state: "completed",
    });
  });
});
