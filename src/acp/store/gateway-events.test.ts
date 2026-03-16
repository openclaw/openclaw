import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpNodeRuntime } from "../runtime/acp-node.js";
import type { AcpRuntimeEvent } from "../runtime/types.js";
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

async function collectEvents(stream: AsyncIterable<AcpRuntimeEvent>): Promise<AcpRuntimeEvent[]> {
  const events: AcpRuntimeEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
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

  it("reconciles suspect leases before ensureSession reuses them", async () => {
    const { runtime } = await createRuntime();
    const sessionKey = "agent:main:acp:test-session";
    const commands: string[] = [];
    const now = Date.now();

    const lease = await runtime.store.acquireLease({
      sessionKey,
      nodeId: "node-1",
      leaseId: "lease-1",
      now,
    });
    await runtime.store.markNodeDisconnected({
      nodeId: "node-1",
      reason: "node_disconnected",
      now: now + 1,
    });

    const backend = new AcpNodeRuntime({
      gatewayRuntime: runtime,
      listNodes: () =>
        [
          {
            nodeId: "node-1",
            caps: ["acp:v1"],
            commands: [
              "acp.session.ensure",
              "acp.session.load",
              "acp.turn.start",
              "acp.turn.cancel",
              "acp.session.close",
              "acp.session.status",
            ],
          },
        ] as never,
      invokeNode: async ({ command, params }) => {
        commands.push(command);
        const payload = params as Record<string, unknown>;
        if (command === "acp.session.status") {
          return {
            ok: true,
            payload: {
              nodeId: "node-1",
              ok: true,
              sessionKey: payload.sessionKey,
              leaseId: payload.leaseId,
              leaseEpoch: payload.leaseEpoch,
              state: "idle",
              nodeRuntimeSessionId: "runtime-1",
            },
          };
        }
        if (command === "acp.session.ensure") {
          return {
            ok: true,
            payload: {
              ok: true,
              sessionKey: payload.sessionKey,
              leaseId: payload.leaseId,
              leaseEpoch: payload.leaseEpoch,
              nodeRuntimeSessionId: "runtime-1",
            },
          };
        }
        throw new Error(`unexpected command ${command}`);
      },
    });

    await backend.ensureSession({
      sessionKey,
      agent: "main",
      mode: "persistent",
    });

    expect(commands).toEqual(["acp.session.status", "acp.session.ensure"]);
    expect(await runtime.store.getActiveLease(sessionKey)).toMatchObject({
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      state: "active",
      nodeRuntimeSessionId: "runtime-1",
    });
  });

  it("fails safely when suspect-lease ensureSession cannot reconcile", async () => {
    const { runtime } = await createRuntime();
    const sessionKey = "agent:main:acp:test-session";
    const commands: string[] = [];
    const now = Date.now();

    await runtime.store.acquireLease({
      sessionKey,
      nodeId: "node-1",
      leaseId: "lease-1",
      now,
    });
    await runtime.store.markNodeDisconnected({
      nodeId: "node-1",
      reason: "node_disconnected",
      now: now + 1,
    });

    const backend = new AcpNodeRuntime({
      gatewayRuntime: runtime,
      listNodes: () =>
        [
          {
            nodeId: "node-1",
            caps: ["acp:v1"],
            commands: [
              "acp.session.ensure",
              "acp.session.load",
              "acp.turn.start",
              "acp.turn.cancel",
              "acp.session.close",
              "acp.session.status",
            ],
          },
        ] as never,
      invokeNode: async ({ command, params }) => {
        commands.push(command);
        if (command === "acp.session.status") {
          const payload = params as Record<string, unknown>;
          return {
            ok: true,
            payload: {
              nodeId: "node-1",
              ok: true,
              sessionKey: payload.sessionKey,
              leaseId: payload.leaseId,
              leaseEpoch: payload.leaseEpoch,
              state: "missing",
            },
          };
        }
        throw new Error(`unexpected command ${command}`);
      },
    });

    await expect(
      backend.ensureSession({
        sessionKey,
        agent: "main",
        mode: "persistent",
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
    });

    expect(commands).toEqual(["acp.session.status"]);
    expect(await runtime.store.getActiveLease(sessionKey)).toMatchObject({
      state: "lost",
    });
  });

  it("settles rejected turn starts into a durable failed terminal instead of wedging later turns", async () => {
    const { runtime } = await createRuntime();
    const sessionKey = "agent:main:acp:test-session";
    const commands: string[] = [];
    let startAttempts = 0;
    const backend = new AcpNodeRuntime({
      gatewayRuntime: runtime,
      listNodes: () =>
        [
          {
            nodeId: "node-1",
            caps: ["acp:v1"],
            commands: [
              "acp.session.ensure",
              "acp.session.load",
              "acp.turn.start",
              "acp.turn.cancel",
              "acp.session.close",
              "acp.session.status",
            ],
          },
        ] as never,
      invokeNode: async ({ command, params }) => {
        commands.push(command);
        if (command === "acp.session.ensure") {
          const payload = params as Record<string, unknown>;
          return {
            ok: true,
            payload: {
              ok: true,
              sessionKey: payload.sessionKey,
              leaseId: payload.leaseId,
              leaseEpoch: payload.leaseEpoch,
              nodeRuntimeSessionId: "runtime-1",
            },
          };
        }
        if (command === "acp.turn.start") {
          const payload = params as Record<string, unknown>;
          startAttempts += 1;
          if (startAttempts === 1) {
            return {
              ok: true,
              payload: {
                ok: true,
                accepted: false,
                message: "start rejected",
              },
            };
          }
          const currentSessionKey = String(payload.sessionKey);
          const runId = String(payload.runId);
          const leaseId = String(payload.leaseId);
          const leaseEpoch = Number(payload.leaseEpoch);
          queueMicrotask(() => {
            void runtime.ingestNodeEvent("node-1", {
              event: "acp.worker.event",
              payloadJSON: JSON.stringify({
                nodeId: "node-1",
                sessionKey: currentSessionKey,
                runId,
                leaseId,
                leaseEpoch,
                seq: 1,
                event: {
                  type: "text_delta",
                  stream: "output",
                  text: "hello",
                },
              }),
            });
            void runtime.ingestNodeEvent("node-1", {
              event: "acp.worker.terminal",
              payloadJSON: JSON.stringify({
                nodeId: "node-1",
                sessionKey: currentSessionKey,
                runId,
                leaseId,
                leaseEpoch,
                terminalEventId: "term-1",
                finalSeq: 1,
                terminal: {
                  kind: "completed",
                  stopReason: "done",
                },
              }),
            });
          });
          return {
            ok: true,
            payload: {
              ok: true,
              accepted: true,
              nodeWorkerRunId: "worker-1",
            },
          };
        }
        throw new Error(`unexpected command ${command}`);
      },
    });
    const handle = await backend.ensureSession({
      sessionKey,
      agent: "main",
      mode: "persistent",
    });

    await expect(
      collectEvents(
        backend.runTurn({
          handle,
          text: "reject me",
          mode: "prompt",
          requestId: "run-1",
        }),
      ),
    ).rejects.toThrow("start rejected");

    expect(await runtime.store.getRun("run-1")).toMatchObject({
      state: "failed",
      terminal: {
        terminalEventId: "gateway-start-rejected:run-1",
        finalSeq: 0,
        kind: "failed",
        errorMessage: "start rejected",
      },
    });
    const session = await runtime.store.getSession(sessionKey);
    expect(session).toMatchObject({
      state: "idle",
      lastRunId: "run-1",
    });
    expect(session?.activeRunId).toBeUndefined();

    const recoveryEvents = await collectEvents(
      backend.runTurn({
        handle,
        text: "second try",
        mode: "prompt",
        requestId: "run-2",
      }),
    );
    expect(recoveryEvents).toEqual([
      {
        type: "text_delta",
        stream: "output",
        text: "hello",
      },
      {
        type: "done",
        stopReason: "done",
      },
    ]);
    expect(commands.filter((command) => command === "acp.turn.start")).toHaveLength(2);
  });

  it("keeps unknown start transport failures recoverable so late worker output can still win", async () => {
    const { runtime } = await createRuntime();
    const sessionKey = "agent:main:acp:test-session";
    const commands: string[] = [];
    const lateWorkerOutput: { emit?: () => void } = {};

    const backend = new AcpNodeRuntime({
      gatewayRuntime: runtime,
      listNodes: () =>
        [
          {
            nodeId: "node-1",
            caps: ["acp:v1"],
            commands: [
              "acp.session.ensure",
              "acp.session.load",
              "acp.turn.start",
              "acp.turn.cancel",
              "acp.session.close",
              "acp.session.status",
            ],
          },
        ] as never,
      invokeNode: async ({ command, params }) => {
        commands.push(command);
        if (command === "acp.session.ensure") {
          const payload = params as Record<string, unknown>;
          return {
            ok: true,
            payload: {
              ok: true,
              sessionKey: payload.sessionKey,
              leaseId: payload.leaseId,
              leaseEpoch: payload.leaseEpoch,
              nodeRuntimeSessionId: "runtime-1",
            },
          };
        }
        if (command === "acp.turn.start") {
          const payload = params as Record<string, unknown>;
          const runId = String(payload.runId);
          const leaseId = String(payload.leaseId);
          const leaseEpoch = Number(payload.leaseEpoch);
          lateWorkerOutput.emit = () => {
            void runtime.ingestNodeEvent("node-1", {
              event: "acp.worker.event",
              payloadJSON: JSON.stringify({
                nodeId: "node-1",
                sessionKey,
                runId,
                leaseId,
                leaseEpoch,
                seq: 1,
                event: {
                  type: "text_delta",
                  stream: "output",
                  text: "late hello",
                },
              }),
            });
            void runtime.ingestNodeEvent("node-1", {
              event: "acp.worker.terminal",
              payloadJSON: JSON.stringify({
                nodeId: "node-1",
                sessionKey,
                runId,
                leaseId,
                leaseEpoch,
                terminalEventId: "term-late",
                finalSeq: 1,
                terminal: {
                  kind: "completed",
                  stopReason: "done",
                },
              }),
            });
          };
          return {
            ok: false,
            error: {
              code: "TIMEOUT",
              message: "invoke timeout with unknown worker state",
            },
          };
        }
        throw new Error(`unexpected command ${command}`);
      },
    });

    const handle = await backend.ensureSession({
      sessionKey,
      agent: "main",
      mode: "persistent",
    });

    const turnPromise = collectEvents(
      backend.runTurn({
        handle,
        text: "maybe started",
        mode: "prompt",
        requestId: "run-timeout",
      }),
    );

    await vi.waitFor(async () => {
      const run = await runtime.store.getRun("run-timeout");
      expect(run).toMatchObject({
        state: "recovering",
        recoveryReason: "start_unknown_transport",
      });
    });

    await vi.waitFor(async () => {
      const session = await runtime.store.getSession(sessionKey);
      expect(session).toMatchObject({
        state: "recovering",
        activeRunId: "run-timeout",
        lastRecoveryReason: "start_unknown_transport",
      });
    });

    lateWorkerOutput.emit?.();

    const events = await turnPromise;

    expect(events).toEqual([
      {
        type: "text_delta",
        stream: "output",
        text: "late hello",
      },
      {
        type: "done",
        stopReason: "done",
      },
    ]);
    const run = await runtime.store.getRun("run-timeout");
    expect(run).toMatchObject({
      state: "completed",
      terminal: {
        kind: "completed",
        stopReason: "done",
      },
    });
    expect(commands.filter((command) => command === "acp.turn.start")).toHaveLength(1);
  });

  it("keeps code-less unknown start failures recoverable", async () => {
    const { runtime } = await createRuntime();
    const sessionKey = "agent:main:acp:test-session";
    const lateWorkerOutput: { emit?: () => void } = {};

    const backend = new AcpNodeRuntime({
      gatewayRuntime: runtime,
      listNodes: () =>
        [
          {
            nodeId: "node-1",
            caps: ["acp:v1"],
            commands: [
              "acp.session.ensure",
              "acp.session.load",
              "acp.turn.start",
              "acp.turn.cancel",
              "acp.session.close",
              "acp.session.status",
            ],
          },
        ] as never,
      invokeNode: async ({ command, params }) => {
        if (command === "acp.session.ensure") {
          const payload = params as Record<string, unknown>;
          return {
            ok: true,
            payload: {
              ok: true,
              sessionKey: payload.sessionKey,
              leaseId: payload.leaseId,
              leaseEpoch: payload.leaseEpoch,
              nodeRuntimeSessionId: "runtime-1",
            },
          };
        }
        if (command === "acp.turn.start") {
          const payload = params as Record<string, unknown>;
          const runId = String(payload.runId);
          const leaseId = String(payload.leaseId);
          const leaseEpoch = Number(payload.leaseEpoch);
          lateWorkerOutput.emit = () => {
            void runtime.ingestNodeEvent("node-1", {
              event: "acp.worker.event",
              payloadJSON: JSON.stringify({
                nodeId: "node-1",
                sessionKey,
                runId,
                leaseId,
                leaseEpoch,
                seq: 1,
                event: {
                  type: "status",
                  text: "late status",
                },
              }),
            });
            void runtime.ingestNodeEvent("node-1", {
              event: "acp.worker.terminal",
              payloadJSON: JSON.stringify({
                nodeId: "node-1",
                sessionKey,
                runId,
                leaseId,
                leaseEpoch,
                terminalEventId: "term-late-no-code",
                finalSeq: 1,
                terminal: {
                  kind: "completed",
                  stopReason: "done",
                },
              }),
            });
          };
          return {
            ok: false,
            error: {
              message: "unknown start result",
            },
          };
        }
        throw new Error(`unexpected command ${command}`);
      },
    });

    const handle = await backend.ensureSession({
      sessionKey,
      agent: "main",
      mode: "persistent",
    });

    const turnPromise = collectEvents(
      backend.runTurn({
        handle,
        text: "maybe started",
        mode: "prompt",
        requestId: "run-no-code",
      }),
    );

    await vi.waitFor(async () => {
      expect(await runtime.store.getRun("run-no-code")).toMatchObject({
        state: "recovering",
        recoveryReason: "start_unknown_transport",
      });
    });

    lateWorkerOutput.emit?.();

    await expect(turnPromise).resolves.toEqual([
      {
        type: "status",
        text: "late status",
      },
      {
        type: "done",
        stopReason: "done",
      },
    ]);
  });

  it("does not drop a late same-lease event accepted between delivery polls and terminal completion", async () => {
    const { runtime } = await createRuntime();
    const sessionKey = "agent:main:acp:test-session";

    const backend = new AcpNodeRuntime({
      gatewayRuntime: runtime,
      listNodes: () =>
        [
          {
            nodeId: "node-1",
            caps: ["acp:v1"],
            commands: [
              "acp.session.ensure",
              "acp.session.load",
              "acp.turn.start",
              "acp.turn.cancel",
              "acp.session.close",
              "acp.session.status",
            ],
          },
        ] as never,
      invokeNode: async ({ command, params }) => {
        if (command === "acp.session.ensure") {
          const payload = params as Record<string, unknown>;
          return {
            ok: true,
            payload: {
              ok: true,
              sessionKey: payload.sessionKey,
              leaseId: payload.leaseId,
              leaseEpoch: payload.leaseEpoch,
              nodeRuntimeSessionId: "runtime-1",
            },
          };
        }
        if (command === "acp.turn.start") {
          return {
            ok: false,
            error: {
              code: "TIMEOUT",
              message: "invoke timeout with unknown worker state",
            },
          };
        }
        throw new Error(`unexpected command ${command}`);
      },
    });

    const handle = await backend.ensureSession({
      sessionKey,
      agent: "main",
      mode: "persistent",
    });

    const acceptedRun = await runtime.store.getRun("run-race");
    const lease = await runtime.store.getActiveLease(sessionKey);
    let deliveryPolls = 0;
    runtime.store.getRunDeliveryState = async () => {
      deliveryPolls += 1;
      if (deliveryPolls === 1) {
        return {
          events: [],
          run: {
            ...acceptedRun!,
            state: "recovering" as const,
          },
        };
      }
      return {
        events: [
          {
            eventId: "run-race:1",
            runId: "run-race",
            sessionKey,
            seq: 1,
            nodeId: "node-1",
            leaseId: lease?.leaseId ?? "",
            leaseEpoch: lease?.leaseEpoch ?? 0,
            acceptedAt: Date.now(),
            event: {
              type: "text_delta",
              stream: "output",
              text: "late hello",
            },
          },
        ],
        run: {
          ...acceptedRun!,
          state: "completed" as const,
          highestAcceptedSeq: 1,
          eventCount: 1,
          terminal: {
            terminalEventId: "term-race",
            finalSeq: 1,
            kind: "completed",
            stopReason: "done",
            acceptedAt: Date.now(),
            nodeId: "node-1",
            leaseId: lease?.leaseId ?? "",
            leaseEpoch: lease?.leaseEpoch ?? 0,
          },
        },
      };
    };

    await expect(
      collectEvents(
        backend.runTurn({
          handle,
          text: "maybe started",
          mode: "prompt",
          requestId: "run-race",
        }),
      ),
    ).resolves.toEqual([
      {
        type: "text_delta",
        stream: "output",
        text: "late hello",
      },
      {
        type: "done",
        stopReason: "done",
      },
    ]);
  });

  it("converges on a terminal that lands after a stale snapshot but before abort-triggered cancel", async () => {
    const { runtime } = await createRuntime();
    const sessionKey = "agent:main:acp:test-session";
    const commands: string[] = [];

    const backend = new AcpNodeRuntime({
      gatewayRuntime: runtime,
      listNodes: () =>
        [
          {
            nodeId: "node-1",
            caps: ["acp:v1"],
            commands: [
              "acp.session.ensure",
              "acp.session.load",
              "acp.turn.start",
              "acp.turn.cancel",
              "acp.session.close",
              "acp.session.status",
            ],
          },
        ] as never,
      invokeNode: async ({ command, params }) => {
        commands.push(command);
        if (command === "acp.session.ensure") {
          const payload = params as Record<string, unknown>;
          return {
            ok: true,
            payload: {
              ok: true,
              sessionKey: payload.sessionKey,
              leaseId: payload.leaseId,
              leaseEpoch: payload.leaseEpoch,
              nodeRuntimeSessionId: "runtime-1",
            },
          };
        }
        if (command === "acp.turn.start") {
          return {
            ok: true,
            payload: {
              ok: true,
              accepted: true,
              nodeWorkerRunId: "worker-1",
            },
          };
        }
        if (command === "acp.turn.cancel") {
          return {
            ok: false,
            error: {
              message: "already completed",
            },
          };
        }
        throw new Error(`unexpected command ${command}`);
      },
    });

    const handle = await backend.ensureSession({
      sessionKey,
      agent: "main",
      mode: "persistent",
    });

    const abortController = new AbortController();
    let deliveryPolls = 0;
    runtime.store.getRunDeliveryState = async ({ runId, afterSeq }) => {
      deliveryPolls += 1;
      const currentRun = await runtime.store.getRun(runId);
      const lease = await runtime.store.getActiveLease(sessionKey);
      if (deliveryPolls === 1) {
        abortController.abort();
        return {
          events: [],
          run: currentRun,
        };
      }
      if (deliveryPolls === 2) {
        return {
          events: [],
          run: {
            ...currentRun!,
            terminal: {
              terminalEventId: "term-after-snapshot",
              finalSeq: afterSeq ?? 0,
              kind: "completed",
              stopReason: "done",
              acceptedAt: Date.now(),
              nodeId: "node-1",
              leaseId: lease?.leaseId ?? "",
              leaseEpoch: lease?.leaseEpoch ?? 0,
            },
            state: "completed" as const,
          },
        };
      }
      return {
        events: [],
        run: currentRun,
      };
    };

    await expect(
      collectEvents(
        backend.runTurn({
          handle,
          text: "finish first",
          mode: "prompt",
          requestId: "run-abort-race",
          signal: abortController.signal,
        }),
      ),
    ).resolves.toEqual([
      {
        type: "done",
        stopReason: "done",
      },
    ]);
    expect(commands).toEqual(["acp.session.ensure", "acp.turn.start"]);
  });

  it("waits for the cancelled terminal on active-turn cancel instead of surfacing an abort error", async () => {
    const { runtime } = await createRuntime();
    const sessionKey = "agent:main:acp:test-session";
    const commands: string[] = [];

    const backend = new AcpNodeRuntime({
      gatewayRuntime: runtime,
      listNodes: () =>
        [
          {
            nodeId: "node-1",
            caps: ["acp:v1"],
            commands: [
              "acp.session.ensure",
              "acp.session.load",
              "acp.turn.start",
              "acp.turn.cancel",
              "acp.session.close",
              "acp.session.status",
            ],
          },
        ] as never,
      invokeNode: async ({ command, params }) => {
        commands.push(command);
        if (command === "acp.session.ensure") {
          const payload = params as Record<string, unknown>;
          return {
            ok: true,
            payload: {
              ok: true,
              sessionKey: payload.sessionKey,
              leaseId: payload.leaseId,
              leaseEpoch: payload.leaseEpoch,
              nodeRuntimeSessionId: "runtime-1",
            },
          };
        }
        if (command === "acp.turn.start") {
          return {
            ok: true,
            payload: {
              ok: true,
              accepted: true,
              nodeWorkerRunId: "worker-1",
            },
          };
        }
        if (command === "acp.turn.cancel") {
          return {
            ok: true,
            payload: {
              ok: true,
              accepted: true,
            },
          };
        }
        throw new Error(`unexpected command ${command}`);
      },
    });

    const handle = await backend.ensureSession({
      sessionKey,
      agent: "main",
      mode: "persistent",
    });

    const abortController = new AbortController();
    const turnPromise = collectEvents(
      backend.runTurn({
        handle,
        text: "cancel me",
        mode: "prompt",
        requestId: "run-cancel",
        signal: abortController.signal,
      }),
    );

    await vi.waitFor(async () => {
      expect(await runtime.store.getRun("run-cancel")).toMatchObject({
        state: "accepted",
      });
    });

    abortController.abort();
    await backend.cancel({
      handle,
      reason: "manual-cancel",
    });

    await vi.waitFor(async () => {
      expect(await runtime.store.getRun("run-cancel")).toMatchObject({
        state: "cancelling",
        cancelRequestedAt: expect.any(Number),
      });
    });

    const lease = await runtime.store.getActiveLease(sessionKey);
    await runtime.ingestNodeEvent("node-1", {
      event: "acp.worker.terminal",
      payloadJSON: JSON.stringify({
        nodeId: "node-1",
        sessionKey,
        runId: "run-cancel",
        leaseId: lease?.leaseId ?? "",
        leaseEpoch: lease?.leaseEpoch ?? 0,
        terminalEventId: "term-cancel",
        finalSeq: 0,
        terminal: {
          kind: "cancelled",
          stopReason: "manual-cancel",
        },
      }),
    });

    await expect(turnPromise).resolves.toEqual([
      {
        type: "done",
        stopReason: "manual-cancel",
      },
    ]);
    expect(await runtime.store.getRun("run-cancel")).toMatchObject({
      state: "cancelled",
      terminal: {
        kind: "cancelled",
        stopReason: "manual-cancel",
      },
    });
    expect(commands).toContain("acp.turn.cancel");
  });
});
