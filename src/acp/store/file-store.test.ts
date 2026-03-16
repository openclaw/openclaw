import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpGatewayStore } from "./file-store.js";

const tempRoots: string[] = [];

async function createStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acp-gateway-store-"));
  tempRoots.push(root);
  return {
    root,
    filePath: path.join(root, "gateway-store.json"),
    store: new AcpGatewayStore(path.join(root, "gateway-store.json")),
  };
}

async function seedRun(
  store: AcpGatewayStore,
  params?: Partial<{ leaseEpoch: number; leaseId: string }>,
) {
  const started = await store.startRun({
    sessionKey: "agent:main:acp:test",
    runId: "run-1",
    requestId: "req-1",
    nodeId: "node-1",
    leaseId: params?.leaseId ?? "lease-1",
    leaseEpoch: params?.leaseEpoch ?? 1,
  });
  expect(started.ok).toBe(true);
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

describe("AcpGatewayStore", () => {
  it("persists sessions runs events checkpoints and idempotency across reload", async () => {
    const { filePath, store } = await createStore();

    await seedRun(store);
    const appendResult = await store.appendWorkerEvent({
      sessionKey: "agent:main:acp:test",
      runId: "run-1",
      nodeId: "node-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      seq: 1,
      eventId: "evt-1",
      event: {
        type: "text_delta",
        text: "hello",
      },
    });
    expect(appendResult.ok).toBe(true);

    const checkpoint = await store.writeCheckpoint({
      runId: "run-1",
      consumer: "projector",
      lastProjectedSeq: 1,
    });
    expect(checkpoint.lastProjectedSeq).toBe(1);

    const reloaded = new AcpGatewayStore(filePath);
    const snapshot = await reloaded.readSnapshot();
    expect(snapshot.sessions["agent:main:acp:test"]?.lease?.leaseEpoch).toBe(1);
    expect(snapshot.runs["run-1"]?.state).toBe("running");
    expect(snapshot.events["evt-1"]?.seq).toBe(1);
    expect(snapshot.checkpoints["projector:run-1"]?.lastProjectedSeq).toBe(1);
    expect(snapshot.idempotency["evt-1"]?.scope).toBe("worker-event");
    expect(snapshot.idempotency["run-start:agent:main:acp:test:req-1"]?.scope).toBe("run-start");
  });

  it("rejects stale lease epochs after lease replacement", async () => {
    const { store } = await createStore();

    await seedRun(store);
    const replaced = await store.startRun({
      sessionKey: "agent:main:acp:test",
      runId: "run-2",
      requestId: "req-2",
      nodeId: "node-2",
      leaseId: "lease-2",
      leaseEpoch: 2,
    });
    expect(replaced.ok).toBe(true);

    const stale = await store.appendWorkerEvent({
      sessionKey: "agent:main:acp:test",
      runId: "run-1",
      nodeId: "node-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      seq: 1,
      eventId: "evt-stale",
      event: {
        type: "text_delta",
        text: "late",
      },
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) {
      return;
    }
    expect(stale.code).toBe("ACP_LEASE_EPOCH_STALE");
  });

  it("treats acp.worker.terminal as the single terminal authority", async () => {
    const { store } = await createStore();

    await seedRun(store);
    const badEvent = await store.appendWorkerEvent({
      sessionKey: "agent:main:acp:test",
      runId: "run-1",
      nodeId: "node-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      seq: 1,
      eventId: "evt-done",
      event: {
        type: "done",
      },
    });
    expect(badEvent.ok).toBe(false);
    if (badEvent.ok) {
      return;
    }
    expect(badEvent.code).toBe("ACP_EVENT_DONE_NOT_ALLOWED");

    const accepted = await store.appendTerminal({
      sessionKey: "agent:main:acp:test",
      runId: "run-1",
      nodeId: "node-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      finalSeq: 1,
      terminalEventId: "terminal-1",
      result: {
        status: "completed",
        stopReason: "stop",
      },
    });
    expect(accepted.ok).toBe(true);

    const duplicate = await store.appendTerminal({
      sessionKey: "agent:main:acp:test",
      runId: "run-1",
      nodeId: "node-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      finalSeq: 1,
      terminalEventId: "terminal-1",
      result: {
        status: "completed",
        stopReason: "stop",
      },
    });
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) {
      return;
    }
    expect(duplicate.duplicate).toBe(true);

    const conflicting = await store.appendTerminal({
      sessionKey: "agent:main:acp:test",
      runId: "run-1",
      nodeId: "node-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      finalSeq: 1,
      terminalEventId: "terminal-2",
      result: {
        status: "canceled",
      },
    });
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) {
      return;
    }
    expect(conflicting.code).toBe("ACP_TERMINAL_CONFLICT");
  });

  it("reloads recoverable state after a suspect lease transition", async () => {
    const { filePath, store } = await createStore();

    await seedRun(store);
    const suspect = await store.markLeaseSuspect({
      sessionKey: "agent:main:acp:test",
      leaseId: "lease-1",
      leaseEpoch: 1,
      reason: "node-disconnected",
    });
    expect(suspect.ok).toBe(true);

    const reloaded = new AcpGatewayStore(filePath);
    const snapshot = await reloaded.readSnapshot();
    expect(snapshot.sessions["agent:main:acp:test"]?.state).toBe("recovering");
    expect(snapshot.sessions["agent:main:acp:test"]?.lease?.state).toBe("suspect");
    expect(snapshot.runs["run-1"]?.state).toBe("recovering");
    expect(snapshot.runs["run-1"]?.recoverableReason).toBe("node-disconnected");
  });
});
