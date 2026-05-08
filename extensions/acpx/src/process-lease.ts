import { randomUUID, createHash } from "node:crypto";
import { createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export const OPENCLAW_ACPX_LEASE_ID_ENV = "OPENCLAW_ACPX_LEASE_ID";
export const OPENCLAW_GATEWAY_INSTANCE_ID_ENV = "OPENCLAW_GATEWAY_INSTANCE_ID";
export const OPENCLAW_ACPX_LEASE_ID_ARG = "--openclaw-acpx-lease-id";
export const OPENCLAW_GATEWAY_INSTANCE_ID_ARG = "--openclaw-gateway-instance-id";

export type AcpxProcessLeaseState = "open" | "closing" | "closed" | "lost";

export type AcpxProcessLease = {
  leaseId: string;
  gatewayInstanceId: string;
  sessionKey: string;
  wrapperRoot: string;
  wrapperPath: string;
  rootPid: number;
  processGroupId?: number;
  commandHash: string;
  startedAt: number;
  state: AcpxProcessLeaseState;
};

export type AcpxProcessLeaseStore = {
  load(leaseId: string): Promise<AcpxProcessLease | undefined>;
  listOpen(gatewayInstanceId?: string): Promise<AcpxProcessLease[]>;
  save(lease: AcpxProcessLease): Promise<void>;
  markState(leaseId: string, state: AcpxProcessLeaseState): Promise<void>;
};

type LeaseStoreEntry = {
  version: 1;
  lease: AcpxProcessLease;
};

const ACPX_PLUGIN_ID = "acpx";
const PROCESS_LEASES_NAMESPACE = "process-leases";

const leaseStore = createPluginStateKeyedStore<LeaseStoreEntry>(ACPX_PLUGIN_ID, {
  namespace: PROCESS_LEASES_NAMESPACE,
  maxEntries: 10_000,
});

function normalizeLease(value: unknown): AcpxProcessLease | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.leaseId !== "string" ||
    typeof record.gatewayInstanceId !== "string" ||
    typeof record.sessionKey !== "string" ||
    typeof record.wrapperRoot !== "string" ||
    typeof record.wrapperPath !== "string" ||
    typeof record.rootPid !== "number" ||
    typeof record.commandHash !== "string" ||
    typeof record.startedAt !== "number" ||
    !["open", "closing", "closed", "lost"].includes(String(record.state))
  ) {
    return undefined;
  }
  return {
    leaseId: record.leaseId,
    gatewayInstanceId: record.gatewayInstanceId,
    sessionKey: record.sessionKey,
    wrapperRoot: record.wrapperRoot,
    wrapperPath: record.wrapperPath,
    rootPid: record.rootPid,
    ...(typeof record.processGroupId === "number" ? { processGroupId: record.processGroupId } : {}),
    commandHash: record.commandHash,
    startedAt: record.startedAt,
    state: record.state as AcpxProcessLeaseState,
  };
}

export function createAcpxProcessLeaseStore(_params: { stateDir: string }): AcpxProcessLeaseStore {
  let updateQueue: Promise<void> = Promise.resolve();

  async function readStoredLeases(): Promise<AcpxProcessLease[]> {
    const entries = await leaseStore.entries();
    return entries
      .map((entry) => normalizeLease(entry.value.lease))
      .filter((lease): lease is AcpxProcessLease => !!lease);
  }

  async function update(
    mutator: (leases: AcpxProcessLease[]) => AcpxProcessLease[],
  ): Promise<void> {
    const run = updateQueue.then(async () => {
      const current = await readStoredLeases();
      const next = mutator(current);
      const nextIds = new Set(next.map((lease) => lease.leaseId));
      await Promise.all([
        ...current
          .filter((lease) => !nextIds.has(lease.leaseId))
          .map((lease) => leaseStore.delete(lease.leaseId)),
        ...next.map((lease) =>
          leaseStore.register(lease.leaseId, {
            version: 1,
            lease,
          }),
        ),
      ]);
    });
    updateQueue = run.catch(() => {});
    await run;
  }

  async function readCurrent(): Promise<AcpxProcessLease[]> {
    await updateQueue;
    return await readStoredLeases();
  }

  return {
    async load(leaseId) {
      const current = await readCurrent();
      return current.find((lease) => lease.leaseId === leaseId);
    },
    async listOpen(gatewayInstanceId) {
      const current = await readCurrent();
      return current.filter(
        (lease) =>
          (lease.state === "open" || lease.state === "closing") &&
          (!gatewayInstanceId || lease.gatewayInstanceId === gatewayInstanceId),
      );
    },
    async save(lease) {
      await update((leases) => [
        ...leases.filter((entry) => entry.leaseId !== lease.leaseId),
        lease,
      ]);
    },
    async markState(leaseId, state) {
      await update((leases) =>
        leases.map((lease) => (lease.leaseId === leaseId ? { ...lease, state } : lease)),
      );
    },
  };
}

export function createAcpxProcessLeaseId(): string {
  return randomUUID();
}

export function hashAcpxProcessCommand(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

function quoteEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

export function withAcpxLeaseEnvironment(params: {
  command: string;
  leaseId: string;
  gatewayInstanceId: string;
  platform?: NodeJS.Platform;
}): string {
  if ((params.platform ?? process.platform) === "win32") {
    return params.command;
  }
  return [
    "env",
    `${OPENCLAW_ACPX_LEASE_ID_ENV}=${quoteEnvValue(params.leaseId)}`,
    `${OPENCLAW_GATEWAY_INSTANCE_ID_ENV}=${quoteEnvValue(params.gatewayInstanceId)}`,
    params.command,
    OPENCLAW_ACPX_LEASE_ID_ARG,
    quoteEnvValue(params.leaseId),
    OPENCLAW_GATEWAY_INSTANCE_ID_ARG,
    quoteEnvValue(params.gatewayInstanceId),
  ].join(" ");
}
