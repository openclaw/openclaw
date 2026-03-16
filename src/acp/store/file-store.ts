import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "../../infra/json-files.js";
import {
  resolveCanonicalTerminal,
  type AcpGatewayCanonicalTerminal,
  type AcpGatewayTerminalResult,
} from "./terminal-resolution.js";

export type AcpGatewayLeaseState =
  | "acquiring"
  | "active"
  | "suspect"
  | "lost"
  | "releasing"
  | "released";

export type AcpGatewayRunState = "recovering" | "running" | "completed" | "failed" | "canceled";

export type AcpGatewayCheckpointRecord = {
  checkpointId: string;
  runId: string;
  sessionKey: string;
  consumer: string;
  lastProjectedSeq: number;
  updatedAt: number;
  terminalEventId?: string;
};

export type AcpGatewayIdempotencyRecord = {
  key: string;
  scope: "run-start" | "worker-event" | "worker-terminal";
  sessionKey: string;
  runId: string;
  firstSeenAt: number;
  eventId?: string;
};

export type AcpGatewayLeaseRecord = {
  leaseId: string;
  leaseEpoch: number;
  nodeId: string;
  state: AcpGatewayLeaseState;
  acquiredAt: number;
  updatedAt: number;
  lastHeartbeatAt?: number;
  expiresAt?: number;
  currentRunId?: string;
};

export type AcpGatewaySessionRecord = {
  sessionKey: string;
  backend: "acp-node";
  createdAt: number;
  updatedAt: number;
  state: "idle" | "running" | "recovering";
  activeRunId?: string;
  lease?: AcpGatewayLeaseRecord;
};

export type AcpGatewayWorkerEventRecord = {
  eventId: string;
  kind: "event" | "terminal";
  sessionKey: string;
  runId: string;
  nodeId: string;
  leaseId: string;
  leaseEpoch: number;
  seq: number;
  recordedAt: number;
  payload:
    | {
        event: Record<string, unknown>;
      }
    | {
        terminal: AcpGatewayTerminalResult;
      };
};

export type AcpGatewayRunRecord = {
  runId: string;
  sessionKey: string;
  requestId: string;
  createdAt: number;
  updatedAt: number;
  nodeId: string;
  leaseId: string;
  leaseEpoch: number;
  state: AcpGatewayRunState;
  recoverableReason?: string;
  lastAcceptedSeq: number;
  terminal?: AcpGatewayCanonicalTerminal;
};

export type AcpGatewayStoreSnapshot = {
  version: 1;
  sessions: Record<string, AcpGatewaySessionRecord>;
  runs: Record<string, AcpGatewayRunRecord>;
  events: Record<string, AcpGatewayWorkerEventRecord>;
  checkpoints: Record<string, AcpGatewayCheckpointRecord>;
  idempotency: Record<string, AcpGatewayIdempotencyRecord>;
};

export type AcpGatewayStoreResult<T> =
  | {
      ok: true;
      value: T;
      duplicate?: boolean;
    }
  | {
      ok: false;
      code:
        | "ACP_SESSION_NOT_FOUND"
        | "ACP_RUN_NOT_FOUND"
        | "ACP_LEASE_EPOCH_STALE"
        | "ACP_LEASE_ID_MISMATCH"
        | "ACP_NODE_MISMATCH"
        | "ACP_EVENT_DUPLICATE_SEQ"
        | "ACP_EVENT_DONE_NOT_ALLOWED"
        | "ACP_TERMINAL_MISSING_FINAL_SEQ"
        | "ACP_TERMINAL_CONFLICT";
      message: string;
    };

export type AcpGatewayRunSummary = {
  session: AcpGatewaySessionRecord;
  run: AcpGatewayRunRecord;
};

export type StartAcpGatewayRunInput = {
  sessionKey: string;
  runId: string;
  requestId: string;
  nodeId: string;
  leaseId: string;
  leaseEpoch: number;
  acquiredAt?: number;
  expiresAt?: number;
};

export type AppendAcpGatewayWorkerEventInput = {
  sessionKey: string;
  runId: string;
  nodeId: string;
  leaseId: string;
  leaseEpoch: number;
  seq: number;
  eventId: string;
  event: Record<string, unknown>;
};

export type AppendAcpGatewayTerminalInput = {
  sessionKey: string;
  runId: string;
  nodeId: string;
  leaseId: string;
  leaseEpoch: number;
  finalSeq: number;
  terminalEventId: string;
  result: AcpGatewayTerminalResult;
};

function createEmptySnapshot(): AcpGatewayStoreSnapshot {
  return {
    version: 1,
    sessions: {},
    runs: {},
    events: {},
    checkpoints: {},
    idempotency: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSnapshot(raw: unknown): AcpGatewayStoreSnapshot {
  if (!isRecord(raw)) {
    return createEmptySnapshot();
  }
  return {
    version: 1,
    sessions: isRecord(raw.sessions) ? (raw.sessions as AcpGatewayStoreSnapshot["sessions"]) : {},
    runs: isRecord(raw.runs) ? (raw.runs as AcpGatewayStoreSnapshot["runs"]) : {},
    events: isRecord(raw.events) ? (raw.events as AcpGatewayStoreSnapshot["events"]) : {},
    checkpoints: isRecord(raw.checkpoints)
      ? (raw.checkpoints as AcpGatewayStoreSnapshot["checkpoints"])
      : {},
    idempotency: isRecord(raw.idempotency)
      ? (raw.idempotency as AcpGatewayStoreSnapshot["idempotency"])
      : {},
  };
}

function runStartIdempotencyKey(sessionKey: string, requestId: string): string {
  return `run-start:${sessionKey}:${requestId}`;
}

function checkpointId(runId: string, consumer: string): string {
  return `${consumer}:${runId}`;
}

function resolveWorkerEventType(event: Record<string, unknown>): string {
  const type = event.type;
  return typeof type === "string" ? type.trim().toLowerCase() : "";
}

type AssertLeaseMatchParams = {
  session: AcpGatewaySessionRecord | undefined;
  run: AcpGatewayRunRecord | undefined;
  nodeId: string;
  leaseId: string;
  leaseEpoch: number;
};

function assertActiveLeaseMatch(params: AssertLeaseMatchParams): AcpGatewayStoreResult<{
  session: AcpGatewaySessionRecord;
  run: AcpGatewayRunRecord;
  lease: AcpGatewayLeaseRecord;
}> {
  if (!params.session) {
    return {
      ok: false,
      code: "ACP_SESSION_NOT_FOUND",
      message: `ACP session ${params.run?.sessionKey ?? "unknown"} does not exist.`,
    };
  }
  if (!params.run) {
    return {
      ok: false,
      code: "ACP_RUN_NOT_FOUND",
      message: `ACP run ${params.session.activeRunId ?? "unknown"} does not exist.`,
    };
  }
  const lease = params.session.lease;
  if (!lease) {
    return {
      ok: false,
      code: "ACP_LEASE_ID_MISMATCH",
      message: `ACP session ${params.session.sessionKey} does not have an active lease.`,
    };
  }
  if (params.leaseEpoch !== lease.leaseEpoch || params.leaseEpoch !== params.run.leaseEpoch) {
    return {
      ok: false,
      code: "ACP_LEASE_EPOCH_STALE",
      message:
        `ACP lease epoch ${params.leaseEpoch} is stale for session ${params.session.sessionKey}; ` +
        `active epoch is ${lease.leaseEpoch}.`,
    };
  }
  if (params.leaseId !== lease.leaseId || params.leaseId !== params.run.leaseId) {
    return {
      ok: false,
      code: "ACP_LEASE_ID_MISMATCH",
      message:
        `ACP lease ${params.leaseId} is not active for session ${params.session.sessionKey}; ` +
        `active lease is ${lease.leaseId}.`,
    };
  }
  if (lease.nodeId !== params.nodeId || params.run.nodeId !== params.nodeId) {
    return {
      ok: false,
      code: "ACP_NODE_MISMATCH",
      message: `ACP run ${params.run.runId} belongs to node ${params.run.nodeId}, not ${params.nodeId}.`,
    };
  }
  return {
    ok: true,
    value: {
      session: params.session,
      run: params.run,
      lease,
    },
  };
}

type StoreMutationResult<T> = {
  snapshot: AcpGatewayStoreSnapshot;
  result: T;
};

export class AcpGatewayStore {
  private readonly withLock = createAsyncLock();

  constructor(
    readonly filePath: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async readSnapshot(): Promise<AcpGatewayStoreSnapshot> {
    return await this.withLock(async () => await this.loadSnapshot());
  }

  async startRun(
    input: StartAcpGatewayRunInput,
  ): Promise<AcpGatewayStoreResult<AcpGatewayRunSummary>> {
    return await this.mutate(async (snapshot) => {
      const now = this.now();
      const existingIdempotency =
        snapshot.idempotency[runStartIdempotencyKey(input.sessionKey, input.requestId)];
      if (existingIdempotency) {
        const existingRun = snapshot.runs[existingIdempotency.runId];
        const existingSession = snapshot.sessions[input.sessionKey];
        if (existingRun && existingSession) {
          return {
            snapshot,
            result: {
              ok: true,
              duplicate: true,
              value: {
                session: existingSession,
                run: existingRun,
              },
            },
          };
        }
      }

      const existingSession = snapshot.sessions[input.sessionKey];
      const existingLease = existingSession?.lease;
      if (existingLease && input.leaseEpoch <= existingLease.leaseEpoch) {
        return {
          snapshot,
          result: {
            ok: false,
            code: "ACP_LEASE_EPOCH_STALE",
            message:
              `ACP lease epoch ${input.leaseEpoch} must be greater than active epoch ${existingLease.leaseEpoch} ` +
              `for session ${input.sessionKey}.`,
          },
        };
      }

      const session: AcpGatewaySessionRecord = existingSession
        ? {
            ...existingSession,
            updatedAt: now,
            state: "recovering",
            activeRunId: input.runId,
            lease: {
              leaseId: input.leaseId,
              leaseEpoch: input.leaseEpoch,
              nodeId: input.nodeId,
              state: "active",
              acquiredAt: input.acquiredAt ?? now,
              updatedAt: now,
              currentRunId: input.runId,
              ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
            },
          }
        : {
            sessionKey: input.sessionKey,
            backend: "acp-node",
            createdAt: now,
            updatedAt: now,
            state: "recovering",
            activeRunId: input.runId,
            lease: {
              leaseId: input.leaseId,
              leaseEpoch: input.leaseEpoch,
              nodeId: input.nodeId,
              state: "active",
              acquiredAt: input.acquiredAt ?? now,
              updatedAt: now,
              currentRunId: input.runId,
              ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
            },
          };
      const run: AcpGatewayRunRecord = {
        runId: input.runId,
        sessionKey: input.sessionKey,
        requestId: input.requestId,
        createdAt: now,
        updatedAt: now,
        nodeId: input.nodeId,
        leaseId: input.leaseId,
        leaseEpoch: input.leaseEpoch,
        state: "recovering",
        recoverableReason: "awaiting-worker-events",
        lastAcceptedSeq: 0,
      };
      snapshot.sessions[input.sessionKey] = session;
      snapshot.runs[input.runId] = run;
      snapshot.idempotency[runStartIdempotencyKey(input.sessionKey, input.requestId)] = {
        key: runStartIdempotencyKey(input.sessionKey, input.requestId),
        scope: "run-start",
        sessionKey: input.sessionKey,
        runId: input.runId,
        firstSeenAt: now,
      };
      return {
        snapshot,
        result: {
          ok: true,
          value: {
            session,
            run,
          },
        },
      };
    });
  }

  async appendWorkerEvent(
    input: AppendAcpGatewayWorkerEventInput,
  ): Promise<AcpGatewayStoreResult<AcpGatewayWorkerEventRecord>> {
    return await this.mutate(async (snapshot) => {
      const session = snapshot.sessions[input.sessionKey];
      const run = snapshot.runs[input.runId];
      const leaseMatch = assertActiveLeaseMatch({
        session,
        run,
        nodeId: input.nodeId,
        leaseId: input.leaseId,
        leaseEpoch: input.leaseEpoch,
      });
      if (!leaseMatch.ok) {
        return {
          snapshot,
          result: leaseMatch,
        };
      }
      if (resolveWorkerEventType(input.event) === "done") {
        return {
          snapshot,
          result: {
            ok: false,
            code: "ACP_EVENT_DONE_NOT_ALLOWED",
            message:
              "acp.worker.event must not carry terminal done events; use acp.worker.terminal.",
          },
        };
      }
      if (run.terminal) {
        return {
          snapshot,
          result: {
            ok: false,
            code: "ACP_TERMINAL_CONFLICT",
            message: `ACP run ${run.runId} already has canonical terminal ${run.terminal.terminalEventId}.`,
          },
        };
      }
      const duplicateIdempotency = snapshot.idempotency[input.eventId];
      if (duplicateIdempotency) {
        const duplicate = snapshot.events[input.eventId];
        if (duplicate) {
          return {
            snapshot,
            result: {
              ok: true,
              duplicate: true,
              value: duplicate,
            },
          };
        }
      }
      const conflictingSeq = Object.values(snapshot.events).find(
        (event) => event.runId === input.runId && event.seq === input.seq,
      );
      if (conflictingSeq) {
        return {
          snapshot,
          result: {
            ok: false,
            code: "ACP_EVENT_DUPLICATE_SEQ",
            message: `ACP run ${input.runId} already recorded seq ${input.seq} as ${conflictingSeq.eventId}.`,
          },
        };
      }
      const now = this.now();
      const event: AcpGatewayWorkerEventRecord = {
        eventId: input.eventId,
        kind: "event",
        sessionKey: input.sessionKey,
        runId: input.runId,
        nodeId: input.nodeId,
        leaseId: input.leaseId,
        leaseEpoch: input.leaseEpoch,
        seq: input.seq,
        recordedAt: now,
        payload: {
          event: input.event,
        },
      };
      snapshot.events[input.eventId] = event;
      snapshot.idempotency[input.eventId] = {
        key: input.eventId,
        scope: "worker-event",
        sessionKey: input.sessionKey,
        runId: input.runId,
        firstSeenAt: now,
        eventId: input.eventId,
      };
      const nextRun: AcpGatewayRunRecord = {
        ...run,
        updatedAt: now,
        state: "running",
        recoverableReason: undefined,
        lastAcceptedSeq: input.seq,
      };
      const nextSession: AcpGatewaySessionRecord = {
        ...session,
        updatedAt: now,
        state: "running",
        activeRunId: input.runId,
        lease: {
          ...leaseMatch.value.lease,
          updatedAt: now,
          currentRunId: input.runId,
        },
      };
      snapshot.runs[input.runId] = nextRun;
      snapshot.sessions[input.sessionKey] = nextSession;
      return {
        snapshot,
        result: {
          ok: true,
          value: event,
        },
      };
    });
  }

  async appendTerminal(
    input: AppendAcpGatewayTerminalInput,
  ): Promise<AcpGatewayStoreResult<AcpGatewayRunRecord>> {
    return await this.mutate(async (snapshot) => {
      const session = snapshot.sessions[input.sessionKey];
      const run = snapshot.runs[input.runId];
      const leaseMatch = assertActiveLeaseMatch({
        session,
        run,
        nodeId: input.nodeId,
        leaseId: input.leaseId,
        leaseEpoch: input.leaseEpoch,
      });
      if (!leaseMatch.ok) {
        return {
          snapshot,
          result: leaseMatch,
        };
      }
      if (!Number.isFinite(input.finalSeq) || input.finalSeq <= 0) {
        return {
          snapshot,
          result: {
            ok: false,
            code: "ACP_TERMINAL_MISSING_FINAL_SEQ",
            message: "acp.worker.terminal requires a positive finalSeq.",
          },
        };
      }
      const resolution = resolveCanonicalTerminal({
        current: run.terminal,
        incoming: {
          terminalEventId: input.terminalEventId,
          finalSeq: input.finalSeq,
          recordedAt: this.now(),
          result: input.result,
        },
      });
      if (resolution.kind === "rejected") {
        return {
          snapshot,
          result: {
            ok: false,
            code: resolution.code,
            message: resolution.message,
          },
        };
      }
      if (resolution.kind === "idempotent") {
        return {
          snapshot,
          result: {
            ok: true,
            duplicate: true,
            value: run,
          },
        };
      }
      const conflictingSeq = Object.values(snapshot.events).find(
        (event) => event.runId === input.runId && event.seq === input.finalSeq,
      );
      if (
        conflictingSeq &&
        conflictingSeq.eventId !== input.terminalEventId &&
        conflictingSeq.kind !== "event"
      ) {
        return {
          snapshot,
          result: {
            ok: false,
            code: "ACP_EVENT_DUPLICATE_SEQ",
            message: `ACP run ${input.runId} already recorded seq ${input.finalSeq} as ${conflictingSeq.eventId}.`,
          },
        };
      }
      const now = this.now();
      snapshot.events[input.terminalEventId] = {
        eventId: input.terminalEventId,
        kind: "terminal",
        sessionKey: input.sessionKey,
        runId: input.runId,
        nodeId: input.nodeId,
        leaseId: input.leaseId,
        leaseEpoch: input.leaseEpoch,
        seq: input.finalSeq,
        recordedAt: now,
        payload: {
          terminal: input.result,
        },
      };
      snapshot.idempotency[input.terminalEventId] = {
        key: input.terminalEventId,
        scope: "worker-terminal",
        sessionKey: input.sessionKey,
        runId: input.runId,
        firstSeenAt: now,
        eventId: input.terminalEventId,
      };
      const terminal = resolution.terminal;
      const nextRun: AcpGatewayRunRecord = {
        ...run,
        updatedAt: now,
        state: terminal.status,
        recoverableReason: undefined,
        lastAcceptedSeq: Math.max(run.lastAcceptedSeq, input.finalSeq),
        terminal,
      };
      const nextSession: AcpGatewaySessionRecord = {
        ...session,
        updatedAt: now,
        state: "idle",
        activeRunId: undefined,
        lease: {
          ...leaseMatch.value.lease,
          updatedAt: now,
          currentRunId: undefined,
        },
      };
      snapshot.runs[input.runId] = nextRun;
      snapshot.sessions[input.sessionKey] = nextSession;
      return {
        snapshot,
        result: {
          ok: true,
          value: nextRun,
        },
      };
    });
  }

  async writeCheckpoint(params: {
    runId: string;
    consumer: string;
    lastProjectedSeq: number;
    terminalEventId?: string;
  }): Promise<AcpGatewayCheckpointRecord> {
    return await this.mutate(async (snapshot) => {
      const run = snapshot.runs[params.runId];
      if (!run) {
        throw new Error(`ACP run ${params.runId} does not exist.`);
      }
      const now = this.now();
      const record: AcpGatewayCheckpointRecord = {
        checkpointId: checkpointId(params.runId, params.consumer),
        runId: params.runId,
        sessionKey: run.sessionKey,
        consumer: params.consumer,
        lastProjectedSeq: params.lastProjectedSeq,
        updatedAt: now,
        ...(params.terminalEventId ? { terminalEventId: params.terminalEventId } : {}),
      };
      snapshot.checkpoints[record.checkpointId] = record;
      return {
        snapshot,
        result: record,
      };
    });
  }

  async markLeaseSuspect(params: {
    sessionKey: string;
    leaseId: string;
    leaseEpoch: number;
    reason: string;
  }): Promise<AcpGatewayStoreResult<AcpGatewayRunSummary>> {
    return await this.mutate(async (snapshot) => {
      const session = snapshot.sessions[params.sessionKey];
      const activeRunId = session?.activeRunId;
      const run = activeRunId ? snapshot.runs[activeRunId] : undefined;
      const leaseMatch = assertActiveLeaseMatch({
        session,
        run,
        nodeId: session?.lease?.nodeId ?? "",
        leaseId: params.leaseId,
        leaseEpoch: params.leaseEpoch,
      });
      if (!leaseMatch.ok) {
        return {
          snapshot,
          result: leaseMatch,
        };
      }
      const now = this.now();
      const nextRun: AcpGatewayRunRecord = {
        ...run,
        updatedAt: now,
        state: run.terminal ? run.state : "recovering",
        recoverableReason: run.terminal ? undefined : params.reason,
      };
      const nextSession: AcpGatewaySessionRecord = {
        ...session,
        updatedAt: now,
        state: run.terminal ? "idle" : "recovering",
        lease: {
          ...leaseMatch.value.lease,
          state: run.terminal ? leaseMatch.value.lease.state : "suspect",
          updatedAt: now,
        },
      };
      snapshot.runs[run.runId] = nextRun;
      snapshot.sessions[params.sessionKey] = nextSession;
      return {
        snapshot,
        result: {
          ok: true,
          value: {
            session: nextSession,
            run: nextRun,
          },
        },
      };
    });
  }

  async recordHeartbeat(params: {
    sessionKey: string;
    runId: string;
    nodeId: string;
    leaseId: string;
    leaseEpoch: number;
  }): Promise<AcpGatewayStoreResult<AcpGatewayLeaseRecord>> {
    return await this.mutate(async (snapshot) => {
      const session = snapshot.sessions[params.sessionKey];
      const run = snapshot.runs[params.runId];
      const leaseMatch = assertActiveLeaseMatch({
        session,
        run,
        nodeId: params.nodeId,
        leaseId: params.leaseId,
        leaseEpoch: params.leaseEpoch,
      });
      if (!leaseMatch.ok) {
        return {
          snapshot,
          result: leaseMatch,
        };
      }
      const now = this.now();
      const nextLease: AcpGatewayLeaseRecord = {
        ...leaseMatch.value.lease,
        state: "active",
        updatedAt: now,
        lastHeartbeatAt: now,
      };
      snapshot.sessions[params.sessionKey] = {
        ...session,
        updatedAt: now,
        lease: nextLease,
      };
      return {
        snapshot,
        result: {
          ok: true,
          value: nextLease,
        },
      };
    });
  }

  private async mutate<T>(
    fn: (
      snapshot: AcpGatewayStoreSnapshot,
    ) => Promise<StoreMutationResult<T>> | StoreMutationResult<T>,
  ): Promise<T> {
    return await this.withLock(async () => {
      const snapshot = await this.loadSnapshot();
      const { snapshot: nextSnapshot, result } = await fn(snapshot);
      await this.persistSnapshot(nextSnapshot);
      return result;
    });
  }

  private async loadSnapshot(): Promise<AcpGatewayStoreSnapshot> {
    const existing = await readJsonFile<unknown>(this.filePath);
    return normalizeSnapshot(existing);
  }

  private async persistSnapshot(snapshot: AcpGatewayStoreSnapshot): Promise<void> {
    await writeJsonAtomic(this.filePath, snapshot, {
      mode: 0o600,
      ensureDirMode: 0o700,
      trailingNewline: true,
    });
  }
}

export function resolveDefaultAcpGatewayStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "acp", "gateway-store.json");
}

export function createAcpGatewayStore(
  filePath: string = resolveDefaultAcpGatewayStorePath(),
): AcpGatewayStore {
  return new AcpGatewayStore(filePath);
}
