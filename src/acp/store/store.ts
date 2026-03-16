import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { createAsyncLock, writeJsonAtomic } from "../../infra/json-files.js";
import type {
  AcpGatewayCheckpointRecord,
  AcpGatewayIdempotencyRecord,
  AcpGatewayLeaseRecord,
  AcpGatewayLeaseReconcileRecord,
  AcpGatewayRecoveryReason,
  AcpGatewayRunEventRecord,
  AcpGatewayRunRecord,
  AcpGatewaySessionRecord,
  AcpGatewayStoreData,
  AcpWorkerEventEnvelope,
  AcpWorkerHeartbeatEnvelope,
  AcpWorkerTerminalEnvelope,
} from "./types.js";

const ACP_GATEWAY_STORE_VERSION = 1 as const;
const DEFAULT_LEASE_TTL_MS = 30_000;

function createEmptyStore(): AcpGatewayStoreData {
  return {
    version: ACP_GATEWAY_STORE_VERSION,
    sessions: {},
    runs: {},
    events: {},
    leases: {},
    checkpoints: {},
    idempotency: {},
  };
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function sameTerminal(
  left: NonNullable<AcpGatewayRunRecord["terminal"]>,
  right: NonNullable<AcpGatewayRunRecord["terminal"]>,
): boolean {
  return (
    left.terminalEventId === right.terminalEventId &&
    left.finalSeq === right.finalSeq &&
    left.kind === right.kind &&
    left.stopReason === right.stopReason &&
    left.errorCode === right.errorCode &&
    left.errorMessage === right.errorMessage &&
    left.nodeId === right.nodeId &&
    left.leaseId === right.leaseId &&
    left.leaseEpoch === right.leaseEpoch
  );
}

export class AcpGatewayStoreError extends Error {
  constructor(
    readonly code:
      | "ACP_NODE_STORE_READ_FAILED"
      | "ACP_NODE_STORE_WRITE_FAILED"
      | "ACP_NODE_SESSION_NOT_FOUND"
      | "ACP_NODE_RUN_NOT_FOUND"
      | "ACP_NODE_ACTIVE_LEASE_MISSING"
      | "ACP_NODE_NODE_MISMATCH"
      | "ACP_NODE_STALE_EPOCH"
      | "ACP_NODE_STALE_LEASE"
      | "ACP_NODE_INVALID_SEQ"
      | "ACP_NODE_DUPLICATE_EVENT_MISMATCH"
      | "ACP_NODE_INVALID_EVENT"
      | "ACP_NODE_RUN_TERMINATED"
      | "ACP_NODE_INVALID_TERMINAL"
      | "ACP_NODE_TERMINAL_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "AcpGatewayStoreError";
  }
}

function mapTerminalKindToRunState(
  kind: AcpWorkerTerminalEnvelope["terminal"]["kind"],
): AcpGatewayRunRecord["state"] {
  switch (kind) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function mapWorkerHeartbeatStateToRunState(
  state: AcpWorkerHeartbeatEnvelope["state"],
  hasAcceptedEvents: boolean,
): AcpGatewayRunRecord["state"] {
  if (state === "cancelling") {
    return "cancelling";
  }
  return hasAcceptedEvents ? "running" : "accepted";
}

function resolveStorePath(stateDir = resolveStateDir(process.env)): string {
  return path.join(stateDir, "acp", "gateway-node-runtime-store.json");
}

export class AcpGatewayStore {
  private readonly withLock = createAsyncLock();
  private didApplyRestartRecoveryLoad = false;

  readonly storePath: string;

  constructor(params?: { storePath?: string; stateDir?: string }) {
    this.storePath = params?.storePath ?? resolveStorePath(params?.stateDir);
  }

  async loadSnapshot(): Promise<AcpGatewayStoreData> {
    return await this.withLock(async () => cloneValue(await this.readStore()));
  }

  async getSession(sessionKey: string): Promise<AcpGatewaySessionRecord | null> {
    return await this.withLock(async () =>
      cloneValue((await this.readStore()).sessions[sessionKey] ?? null),
    );
  }

  async getRun(runId: string): Promise<AcpGatewayRunRecord | null> {
    return await this.withLock(async () =>
      cloneValue((await this.readStore()).runs[runId] ?? null),
    );
  }

  async getActiveLease(sessionKey: string): Promise<AcpGatewayLeaseRecord | null> {
    return await this.withLock(async () =>
      cloneValue((await this.readStore()).leases[sessionKey] ?? null),
    );
  }

  async listRunEvents(runId: string): Promise<AcpGatewayRunEventRecord[]> {
    return await this.withLock(async () =>
      cloneValue((await this.readStore()).events[runId] ?? []),
    );
  }

  async getCheckpoint(checkpointKey: string): Promise<AcpGatewayCheckpointRecord | null> {
    return await this.withLock(async () =>
      cloneValue((await this.readStore()).checkpoints[checkpointKey] ?? null),
    );
  }

  async getIdempotency(key: string): Promise<AcpGatewayIdempotencyRecord | null> {
    return await this.withLock(async () =>
      cloneValue((await this.readStore()).idempotency[key] ?? null),
    );
  }

  async listRecoverableSessions(): Promise<AcpGatewaySessionRecord[]> {
    return await this.withLock(async () =>
      cloneValue(
        Object.values((await this.readStore()).sessions).filter(
          (session) => session.state === "recovering",
        ),
      ),
    );
  }

  async ensureSession(params: {
    sessionKey: string;
    now?: number;
    state?: AcpGatewaySessionRecord["state"];
  }): Promise<AcpGatewaySessionRecord> {
    const now = params.now ?? Date.now();
    return await this.mutateStore(async (store) => {
      const existing = store.sessions[params.sessionKey];
      const next: AcpGatewaySessionRecord = existing
        ? {
            ...existing,
            state: params.state ?? existing.state,
            updatedAt: now,
          }
        : {
            sessionKey: params.sessionKey,
            backend: "acp-node",
            state: params.state ?? "idle",
            createdAt: now,
            updatedAt: now,
          };
      store.sessions[params.sessionKey] = next;
      return next;
    });
  }

  async recordIdempotency(params: {
    key: string;
    scope: string;
    now?: number;
    sessionKey?: string;
    runId?: string;
    status?: string;
  }): Promise<AcpGatewayIdempotencyRecord> {
    const now = params.now ?? Date.now();
    return await this.mutateStore(async (store) => {
      const next: AcpGatewayIdempotencyRecord = {
        key: params.key,
        scope: params.scope,
        createdAt: store.idempotency[params.key]?.createdAt ?? now,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(params.runId ? { runId: params.runId } : {}),
        ...(params.status ? { status: params.status } : {}),
      };
      store.idempotency[params.key] = next;
      return next;
    });
  }

  async recordCheckpoint(params: {
    checkpointKey: string;
    sessionKey: string;
    runId: string;
    cursorSeq: number;
    now?: number;
  }): Promise<AcpGatewayCheckpointRecord> {
    const now = params.now ?? Date.now();
    return await this.mutateStore(async (store) => {
      const next: AcpGatewayCheckpointRecord = {
        checkpointKey: params.checkpointKey,
        sessionKey: params.sessionKey,
        runId: params.runId,
        cursorSeq: params.cursorSeq,
        updatedAt: now,
      };
      store.checkpoints[params.checkpointKey] = next;
      return next;
    });
  }

  async acquireLease(params: {
    sessionKey: string;
    nodeId: string;
    leaseId?: string;
    ttlMs?: number;
    now?: number;
  }): Promise<AcpGatewayLeaseRecord> {
    const now = params.now ?? Date.now();
    const ttlMs = params.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    return await this.mutateStore(async (store) => {
      const session = this.ensureSessionMutable(store, params.sessionKey, now);
      const current = store.leases[params.sessionKey];
      const next: AcpGatewayLeaseRecord = {
        sessionKey: params.sessionKey,
        leaseId: params.leaseId ?? randomUUID(),
        leaseEpoch: (current?.leaseEpoch ?? 0) + 1,
        nodeId: params.nodeId,
        state: "active",
        acquiredAt: now,
        updatedAt: now,
        lastHeartbeatAt: now,
        expiresAt: now + ttlMs,
      };
      store.leases[params.sessionKey] = next;
      session.activeLeaseId = next.leaseId;
      session.updatedAt = now;
      return next;
    });
  }

  async startRun(params: {
    sessionKey: string;
    runId: string;
    requestId: string;
    now?: number;
  }): Promise<AcpGatewayRunRecord> {
    const now = params.now ?? Date.now();
    return await this.mutateStore(async (store) => {
      const session = this.ensureSessionMutable(store, params.sessionKey, now);
      const existing = store.runs[params.runId];
      if (existing) {
        return existing;
      }
      const lease = store.leases[params.sessionKey];
      if (!lease || lease.state !== "active") {
        throw new AcpGatewayStoreError(
          "ACP_NODE_ACTIVE_LEASE_MISSING",
          `ACP session ${params.sessionKey} does not have an active lease for starting run ${params.runId}.`,
        );
      }
      if (session.activeRunId) {
        const activeRun = store.runs[session.activeRunId];
        if (activeRun && !activeRun.terminal) {
          throw new AcpGatewayStoreError(
            "ACP_NODE_INVALID_EVENT",
            `ACP session ${params.sessionKey} already has active run ${activeRun.runId}.`,
          );
        }
      }
      const next: AcpGatewayRunRecord = {
        runId: params.runId,
        sessionKey: params.sessionKey,
        requestId: params.requestId,
        startedByNodeId: lease.nodeId,
        startedByLeaseId: lease.leaseId,
        startedByLeaseEpoch: lease.leaseEpoch,
        state: "accepted",
        createdAt: now,
        updatedAt: now,
        highestAcceptedSeq: 0,
        eventCount: 0,
      };
      store.runs[params.runId] = next;
      store.events[params.runId] = [];
      session.activeRunId = params.runId;
      session.lastRunId = params.runId;
      session.state = "running";
      session.updatedAt = now;
      return next;
    });
  }

  async appendWorkerEvent(
    params: AcpWorkerEventEnvelope & { now?: number; leaseTtlMs?: number },
  ): Promise<{ record: AcpGatewayRunEventRecord; duplicate: boolean }> {
    const now = params.now ?? Date.now();
    return await this.mutateStore(
      async (store) => {
        const { run, session, lease } = this.validateActiveLeaseBinding(store, params, now);
        if (run.terminal) {
          throw new AcpGatewayStoreError(
            "ACP_NODE_RUN_TERMINATED",
            `Run ${params.runId} already has a canonical terminal outcome.`,
          );
        }
        const events = store.events[params.runId] ?? [];
        const existing = events.find((entry) => entry.seq === params.seq);
        if (existing) {
          if (
            existing.leaseId === params.leaseId &&
            existing.leaseEpoch === params.leaseEpoch &&
            existing.nodeId === params.nodeId &&
            stableJson(existing.event) === stableJson(params.event)
          ) {
            return { record: existing, duplicate: true };
          }
          throw new AcpGatewayStoreError(
            "ACP_NODE_DUPLICATE_EVENT_MISMATCH",
            `Run ${params.runId} already recorded seq ${params.seq} with a different payload.`,
          );
        }
        const expectedSeq = run.highestAcceptedSeq + 1;
        if (params.seq !== expectedSeq) {
          throw new AcpGatewayStoreError(
            "ACP_NODE_INVALID_SEQ",
            `Run ${params.runId} expected seq ${expectedSeq} but received ${params.seq}.`,
          );
        }
        const record: AcpGatewayRunEventRecord = {
          eventId: `${params.runId}:${params.seq}`,
          runId: params.runId,
          sessionKey: params.sessionKey,
          seq: params.seq,
          nodeId: params.nodeId,
          leaseId: params.leaseId,
          leaseEpoch: params.leaseEpoch,
          acceptedAt: now,
          event: params.event,
        };
        events.push(record);
        store.events[params.runId] = events;
        run.highestAcceptedSeq = params.seq;
        run.eventCount = events.length;
        run.updatedAt = now;
        if (run.state === "accepted" || run.state === "recovering") {
          run.state = "running";
        }
        session.state = "running";
        session.updatedAt = now;
        lease.lastHeartbeatAt = now;
        lease.updatedAt = now;
        lease.expiresAt = now + (params.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
        return { record, duplicate: false };
      },
      { persistOnErrorCodes: ["ACP_NODE_ACTIVE_LEASE_MISSING"] },
    );
  }

  async resolveTerminal(
    params: AcpWorkerTerminalEnvelope & { now?: number },
  ): Promise<{ run: AcpGatewayRunRecord; duplicate: boolean }> {
    const now = params.now ?? Date.now();
    return await this.mutateStore(
      async (store) => {
        const { run, session } = this.validateActiveLeaseBinding(store, params, now);
        if (params.finalSeq !== run.highestAcceptedSeq) {
          throw new AcpGatewayStoreError(
            "ACP_NODE_INVALID_TERMINAL",
            `Run ${params.runId} terminal finalSeq ${params.finalSeq} does not match highest accepted seq ${run.highestAcceptedSeq}.`,
          );
        }
        const nextTerminal = {
          terminalEventId: params.terminalEventId,
          finalSeq: params.finalSeq,
          kind: params.terminal.kind,
          ...(params.terminal.stopReason ? { stopReason: params.terminal.stopReason } : {}),
          ...(params.terminal.errorCode ? { errorCode: params.terminal.errorCode } : {}),
          ...(params.terminal.errorMessage ? { errorMessage: params.terminal.errorMessage } : {}),
          acceptedAt: now,
          nodeId: params.nodeId,
          leaseId: params.leaseId,
          leaseEpoch: params.leaseEpoch,
        } as const;
        if (run.terminal) {
          if (sameTerminal(run.terminal, nextTerminal)) {
            return { run, duplicate: true };
          }
          throw new AcpGatewayStoreError(
            "ACP_NODE_TERMINAL_CONFLICT",
            `Run ${params.runId} already has a different canonical terminal outcome.`,
          );
        }
        run.terminal = nextTerminal;
        run.state = mapTerminalKindToRunState(params.terminal.kind);
        run.updatedAt = now;
        session.state = "idle";
        session.updatedAt = now;
        session.lastRunId = run.runId;
        if (session.activeRunId === run.runId) {
          delete session.activeRunId;
        }
        return { run, duplicate: false };
      },
      { persistOnErrorCodes: ["ACP_NODE_ACTIVE_LEASE_MISSING"] },
    );
  }

  async reconcileSuspectLease(params: {
    sessionKey: string;
    nodeId: string;
    leaseId: string;
    leaseEpoch: number;
    now?: number;
    nodeRuntimeSessionId?: string;
    nodeWorkerRunId?: string;
    workerProtocolVersion?: number;
  }): Promise<AcpGatewayLeaseReconcileRecord> {
    const now = params.now ?? Date.now();
    return await this.mutateStore(
      async (store) => {
        const session = store.sessions[params.sessionKey];
        if (!session) {
          throw new AcpGatewayStoreError(
            "ACP_NODE_SESSION_NOT_FOUND",
            `ACP session ${params.sessionKey} does not exist.`,
          );
        }
        const lease = store.leases[params.sessionKey];
        if (!lease) {
          throw new AcpGatewayStoreError(
            "ACP_NODE_ACTIVE_LEASE_MISSING",
            `ACP session ${params.sessionKey} does not have an active lease.`,
          );
        }
        if (lease.nodeId !== params.nodeId) {
          throw new AcpGatewayStoreError(
            "ACP_NODE_NODE_MISMATCH",
            `Worker node ${params.nodeId} does not own session ${params.sessionKey}.`,
          );
        }
        if (lease.leaseEpoch !== params.leaseEpoch) {
          throw new AcpGatewayStoreError(
            "ACP_NODE_STALE_EPOCH",
            `Worker epoch ${params.leaseEpoch} is stale for session ${params.sessionKey}; active epoch is ${lease.leaseEpoch}.`,
          );
        }
        if (lease.leaseId !== params.leaseId) {
          throw new AcpGatewayStoreError(
            "ACP_NODE_STALE_LEASE",
            `Worker lease ${params.leaseId} is stale for session ${params.sessionKey}; active lease is ${lease.leaseId}.`,
          );
        }
        this.expireSuspectLeaseIfNeeded(store, lease, now);
        if (lease.state !== "suspect") {
          throw new AcpGatewayStoreError(
            "ACP_NODE_ACTIVE_LEASE_MISSING",
            `ACP session ${params.sessionKey} lease is not recoverable for reconcile; current state is ${lease.state}.`,
          );
        }
        const runId = session.activeRunId;
        const run = runId ? store.runs[runId] : undefined;
        if (run && !run.terminal) {
          this.reactivateLeaseFromWorkerState({
            session,
            run,
            lease,
            now,
            state: run.highestAcceptedSeq > 0 ? "running" : "idle",
            nodeRuntimeSessionId: params.nodeRuntimeSessionId,
            nodeWorkerRunId: params.nodeWorkerRunId,
            workerProtocolVersion: params.workerProtocolVersion,
          });
        } else {
          lease.state = "active";
          lease.updatedAt = now;
          lease.lastHeartbeatAt = now;
          lease.expiresAt = now + DEFAULT_LEASE_TTL_MS;
          if (params.nodeRuntimeSessionId) {
            lease.nodeRuntimeSessionId = params.nodeRuntimeSessionId;
          }
          if (params.nodeWorkerRunId) {
            lease.nodeWorkerRunId = params.nodeWorkerRunId;
          }
          if (typeof params.workerProtocolVersion === "number") {
            lease.workerProtocolVersion = params.workerProtocolVersion;
          }
          session.state = "idle";
          delete session.lastRecoveryReason;
          session.updatedAt = now;
        }
        return {
          session,
          ...(run ? { run } : {}),
          lease,
        };
      },
      { persistOnErrorCodes: ["ACP_NODE_ACTIVE_LEASE_MISSING"] },
    );
  }

  async recordHeartbeat(params: AcpWorkerHeartbeatEnvelope): Promise<AcpGatewayLeaseRecord> {
    return await this.mutateStore(
      async (store) => {
        const { session, run, lease } = this.validateActiveLeaseBinding(store, params, params.ts, {
          allowSuspect: true,
          requireCurrentRun: true,
          requireNonTerminalRun: true,
        });
        if (lease.state === "suspect") {
          this.reactivateLeaseFromWorkerState({
            session,
            run,
            lease,
            now: params.ts,
            state: params.state,
            nodeRuntimeSessionId: params.nodeRuntimeSessionId,
            nodeWorkerRunId: params.nodeWorkerRunId,
            workerProtocolVersion: params.workerProtocolVersion,
          });
          return lease;
        }
        lease.lastHeartbeatAt = params.ts;
        lease.updatedAt = params.ts;
        lease.expiresAt = params.ts + DEFAULT_LEASE_TTL_MS;
        if (params.nodeRuntimeSessionId) {
          lease.nodeRuntimeSessionId = params.nodeRuntimeSessionId;
        }
        if (params.nodeWorkerRunId) {
          lease.nodeWorkerRunId = params.nodeWorkerRunId;
        }
        if (typeof params.workerProtocolVersion === "number") {
          lease.workerProtocolVersion = params.workerProtocolVersion;
        }
        return lease;
      },
      { persistOnErrorCodes: ["ACP_NODE_ACTIVE_LEASE_MISSING"] },
    );
  }

  async markNodeDisconnected(params: {
    nodeId: string;
    reason: AcpGatewayRecoveryReason;
    now?: number;
  }): Promise<{ sessions: AcpGatewaySessionRecord[]; runs: AcpGatewayRunRecord[] }> {
    const now = params.now ?? Date.now();
    return await this.mutateStore(async (store) => {
      const sessions: AcpGatewaySessionRecord[] = [];
      const runs: AcpGatewayRunRecord[] = [];
      for (const lease of Object.values(store.leases)) {
        if (lease.nodeId !== params.nodeId || lease.state !== "active") {
          continue;
        }
        lease.state = "suspect";
        lease.updatedAt = now;
        lease.expiresAt = now + DEFAULT_LEASE_TTL_MS;
        const session = store.sessions[lease.sessionKey];
        if (session) {
          session.state = "recovering";
          session.updatedAt = now;
          session.lastRecoveryReason = params.reason;
          sessions.push(cloneValue(session));
          const runId = session.activeRunId;
          if (runId) {
            const run = store.runs[runId];
            if (run && !run.terminal) {
              run.state = "recovering";
              run.updatedAt = now;
              run.recoveryReason = params.reason;
              runs.push(cloneValue(run));
            }
          }
        }
      }
      return { sessions, runs };
    });
  }

  async markStatusMismatch(params: {
    sessionKey: string;
    now?: number;
  }): Promise<AcpGatewayLeaseReconcileRecord> {
    const now = params.now ?? Date.now();
    return await this.mutateStore(async (store) => {
      const session = store.sessions[params.sessionKey];
      if (!session) {
        throw new AcpGatewayStoreError(
          "ACP_NODE_SESSION_NOT_FOUND",
          `ACP session ${params.sessionKey} does not exist.`,
        );
      }
      const lease = store.leases[params.sessionKey];
      if (!lease) {
        throw new AcpGatewayStoreError(
          "ACP_NODE_ACTIVE_LEASE_MISSING",
          `ACP session ${params.sessionKey} does not have an active lease.`,
        );
      }
      lease.state = "lost";
      lease.updatedAt = now;
      if (lease.expiresAt < now) {
        lease.expiresAt = now;
      }
      session.state = "recovering";
      session.updatedAt = now;
      session.lastRecoveryReason = "status_mismatch";
      const runId = session.activeRunId;
      const run = runId ? store.runs[runId] : undefined;
      if (run && !run.terminal) {
        run.state = "recovering";
        run.updatedAt = now;
        run.recoveryReason = "status_mismatch";
      }
      return {
        session,
        ...(run ? { run } : {}),
        lease,
      };
    });
  }

  async expireSuspectLeases(params?: { now?: number }): Promise<{
    sessions: AcpGatewaySessionRecord[];
    runs: AcpGatewayRunRecord[];
    leases: AcpGatewayLeaseRecord[];
  }> {
    const now = params?.now ?? Date.now();
    return await this.mutateStore(async (store) => {
      const sessions: AcpGatewaySessionRecord[] = [];
      const runs: AcpGatewayRunRecord[] = [];
      const leases: AcpGatewayLeaseRecord[] = [];
      for (const lease of Object.values(store.leases)) {
        if (!this.expireSuspectLeaseIfNeeded(store, lease, now)) {
          continue;
        }
        leases.push(cloneValue(lease));
        const session = store.sessions[lease.sessionKey];
        if (session) {
          sessions.push(cloneValue(session));
          const runId = session.activeRunId;
          if (runId) {
            const run = store.runs[runId];
            if (run && !run.terminal) {
              runs.push(cloneValue(run));
            }
          }
        }
      }
      return { sessions, runs, leases };
    });
  }

  private async mutateStore<T>(
    mutate: (store: AcpGatewayStoreData) => Promise<T> | T,
    options?: { persistOnErrorCodes?: AcpGatewayStoreError["code"][] },
  ): Promise<T> {
    return await this.withLock(async () => {
      const store = await this.readStore();
      try {
        const result = await mutate(store);
        await this.writeStore(store);
        return cloneValue(result);
      } catch (error) {
        if (
          error instanceof AcpGatewayStoreError &&
          options?.persistOnErrorCodes?.includes(error.code)
        ) {
          await this.writeStore(store);
        }
        throw error;
      }
    });
  }

  private async readStore(): Promise<AcpGatewayStoreData> {
    let raw: string;
    try {
      raw = await fs.readFile(this.storePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.didApplyRestartRecoveryLoad = true;
        return createEmptyStore();
      }
      throw new AcpGatewayStoreError(
        "ACP_NODE_STORE_READ_FAILED",
        `Could not read ACP gateway store ${this.storePath}: ${String(error)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new AcpGatewayStoreError(
        "ACP_NODE_STORE_READ_FAILED",
        `Could not parse ACP gateway store ${this.storePath}: ${String(error)}`,
      );
    }
    if (!parsed || typeof parsed !== "object") {
      throw new AcpGatewayStoreError(
        "ACP_NODE_STORE_READ_FAILED",
        `ACP gateway store ${this.storePath} does not contain an object payload.`,
      );
    }
    const candidate = parsed as Partial<AcpGatewayStoreData>;
    if (candidate.version !== ACP_GATEWAY_STORE_VERSION) {
      throw new AcpGatewayStoreError(
        "ACP_NODE_STORE_READ_FAILED",
        `ACP gateway store ${this.storePath} has unsupported version ${String(candidate.version)}.`,
      );
    }
    const hydrated: AcpGatewayStoreData = {
      version: ACP_GATEWAY_STORE_VERSION,
      sessions: candidate.sessions ?? {},
      runs: candidate.runs ?? {},
      events: candidate.events ?? {},
      leases: candidate.leases ?? {},
      checkpoints: candidate.checkpoints ?? {},
      idempotency: candidate.idempotency ?? {},
    };
    if (!this.didApplyRestartRecoveryLoad) {
      this.didApplyRestartRecoveryLoad = true;
      const changed = this.applyRestartRecoveryLoad(hydrated);
      if (changed) {
        await this.writeStore(hydrated);
      }
    }
    return hydrated;
  }

  private async writeStore(store: AcpGatewayStoreData): Promise<void> {
    try {
      await writeJsonAtomic(this.storePath, store, {
        mode: 0o600,
        ensureDirMode: 0o700,
        trailingNewline: true,
      });
    } catch (error) {
      throw new AcpGatewayStoreError(
        "ACP_NODE_STORE_WRITE_FAILED",
        `Could not write ACP gateway store ${this.storePath}: ${String(error)}`,
      );
    }
  }

  private ensureSessionMutable(
    store: AcpGatewayStoreData,
    sessionKey: string,
    now: number,
  ): AcpGatewaySessionRecord {
    const existing = store.sessions[sessionKey];
    if (existing) {
      existing.updatedAt = now;
      return existing;
    }
    const created: AcpGatewaySessionRecord = {
      sessionKey,
      backend: "acp-node",
      state: "idle",
      createdAt: now,
      updatedAt: now,
    };
    store.sessions[sessionKey] = created;
    return created;
  }

  private validateActiveLeaseBinding(
    store: AcpGatewayStoreData,
    params:
      | AcpWorkerEventEnvelope
      | AcpWorkerHeartbeatEnvelope
      | AcpWorkerTerminalEnvelope
      | (AcpWorkerEventEnvelope & { now?: number }),
    now: number,
    options?: {
      allowSuspect?: boolean;
      requireCurrentRun?: boolean;
      requireNonTerminalRun?: boolean;
    },
  ): {
    session: AcpGatewaySessionRecord;
    run: AcpGatewayRunRecord;
    lease: AcpGatewayLeaseRecord;
  } {
    const session = store.sessions[params.sessionKey];
    if (!session) {
      throw new AcpGatewayStoreError(
        "ACP_NODE_SESSION_NOT_FOUND",
        `ACP session ${params.sessionKey} does not exist.`,
      );
    }
    const run = store.runs[params.runId];
    if (!run || run.sessionKey !== params.sessionKey) {
      throw new AcpGatewayStoreError(
        "ACP_NODE_RUN_NOT_FOUND",
        `ACP run ${params.runId} is not known for session ${params.sessionKey}.`,
      );
    }
    if (run.startedByNodeId !== params.nodeId) {
      throw new AcpGatewayStoreError(
        "ACP_NODE_NODE_MISMATCH",
        `Run ${params.runId} is bound to node ${run.startedByNodeId}, not ${params.nodeId}.`,
      );
    }
    if (run.startedByLeaseEpoch !== params.leaseEpoch) {
      throw new AcpGatewayStoreError(
        "ACP_NODE_STALE_EPOCH",
        `Run ${params.runId} is bound to lease epoch ${run.startedByLeaseEpoch}, not ${params.leaseEpoch}.`,
      );
    }
    if (run.startedByLeaseId !== params.leaseId) {
      throw new AcpGatewayStoreError(
        "ACP_NODE_STALE_LEASE",
        `Run ${params.runId} is bound to lease ${run.startedByLeaseId}, not ${params.leaseId}.`,
      );
    }
    if (options?.requireCurrentRun && session.activeRunId !== params.runId) {
      throw new AcpGatewayStoreError(
        "ACP_NODE_INVALID_EVENT",
        `Run ${params.runId} is not the current active or recoverable run for session ${params.sessionKey}.`,
      );
    }
    if (options?.requireNonTerminalRun && run.terminal) {
      throw new AcpGatewayStoreError(
        "ACP_NODE_RUN_TERMINATED",
        `Run ${params.runId} already has a canonical terminal outcome.`,
      );
    }
    const lease = store.leases[params.sessionKey];
    if (!lease) {
      throw new AcpGatewayStoreError(
        "ACP_NODE_ACTIVE_LEASE_MISSING",
        `ACP session ${params.sessionKey} does not have an active lease.`,
      );
    }
    if (lease.nodeId !== params.nodeId) {
      throw new AcpGatewayStoreError(
        "ACP_NODE_NODE_MISMATCH",
        `Worker node ${params.nodeId} does not own session ${params.sessionKey}.`,
      );
    }
    if (lease.leaseEpoch !== params.leaseEpoch) {
      throw new AcpGatewayStoreError(
        "ACP_NODE_STALE_EPOCH",
        `Worker epoch ${params.leaseEpoch} is stale for session ${params.sessionKey}; active epoch is ${lease.leaseEpoch}.`,
      );
    }
    if (lease.leaseId !== params.leaseId) {
      throw new AcpGatewayStoreError(
        "ACP_NODE_STALE_LEASE",
        `Worker lease ${params.leaseId} is stale for session ${params.sessionKey}; active lease is ${lease.leaseId}.`,
      );
    }
    this.expireSuspectLeaseIfNeeded(store, lease, now);
    if (lease.state !== "active" && (!options?.allowSuspect || lease.state !== "suspect")) {
      throw new AcpGatewayStoreError(
        "ACP_NODE_ACTIVE_LEASE_MISSING",
        `ACP session ${params.sessionKey} lease is not active for worker progress; current state is ${lease.state}.`,
      );
    }
    return { session, run, lease };
  }

  private reactivateLeaseFromWorkerState(params: {
    session: AcpGatewaySessionRecord;
    run: AcpGatewayRunRecord;
    lease: AcpGatewayLeaseRecord;
    now: number;
    state: AcpWorkerHeartbeatEnvelope["state"];
    nodeRuntimeSessionId?: string;
    nodeWorkerRunId?: string;
    workerProtocolVersion?: number;
  }): void {
    const { session, run, lease, now } = params;
    lease.state = "active";
    lease.lastHeartbeatAt = now;
    lease.updatedAt = now;
    lease.expiresAt = now + DEFAULT_LEASE_TTL_MS;
    if (params.nodeRuntimeSessionId) {
      lease.nodeRuntimeSessionId = params.nodeRuntimeSessionId;
    }
    if (params.nodeWorkerRunId) {
      lease.nodeWorkerRunId = params.nodeWorkerRunId;
    }
    if (typeof params.workerProtocolVersion === "number") {
      lease.workerProtocolVersion = params.workerProtocolVersion;
    }
    run.state = mapWorkerHeartbeatStateToRunState(params.state, run.highestAcceptedSeq > 0);
    delete run.recoveryReason;
    run.updatedAt = now;
    session.state = "running";
    session.updatedAt = now;
    delete session.lastRecoveryReason;
  }

  private expireSuspectLeaseIfNeeded(
    store: AcpGatewayStoreData,
    lease: AcpGatewayLeaseRecord,
    now: number,
  ): boolean {
    if (lease.state !== "suspect" || lease.expiresAt > now) {
      return false;
    }
    lease.state = "lost";
    lease.updatedAt = now;
    const session = store.sessions[lease.sessionKey];
    if (!session) {
      return true;
    }
    session.state = "recovering";
    session.updatedAt = now;
    session.lastRecoveryReason = "lease_expired";
    const runId = session.activeRunId;
    if (!runId) {
      return true;
    }
    const run = store.runs[runId];
    if (!run || run.terminal) {
      return true;
    }
    run.state = "recovering";
    run.updatedAt = now;
    run.recoveryReason = "lease_expired";
    return true;
  }

  private applyRestartRecoveryLoad(store: AcpGatewayStoreData): boolean {
    const now = Date.now();
    let changed = false;
    for (const lease of Object.values(store.leases)) {
      if (lease.state === "active" || lease.state === "suspect") {
        lease.state = "suspect";
        lease.updatedAt = now;
        lease.expiresAt = now + DEFAULT_LEASE_TTL_MS;
        changed = true;
      }
    }

    for (const run of Object.values(store.runs)) {
      if (run.terminal) {
        continue;
      }
      if (run.state !== "recovering" || run.recoveryReason !== "gateway_restart_reconcile") {
        run.state = "recovering";
        run.recoveryReason = "gateway_restart_reconcile";
        run.updatedAt = now;
        changed = true;
      }
      const session = store.sessions[run.sessionKey];
      if (!session) {
        continue;
      }
      if (
        session.state !== "recovering" ||
        session.lastRecoveryReason !== "gateway_restart_reconcile" ||
        session.activeRunId !== run.runId ||
        session.lastRunId !== run.runId
      ) {
        session.state = "recovering";
        session.lastRecoveryReason = "gateway_restart_reconcile";
        session.updatedAt = now;
        session.activeRunId = run.runId;
        session.lastRunId = run.runId;
        changed = true;
      }
    }
    return changed;
  }
}
