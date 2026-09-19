/** Generation-bound persistence and process-lease metadata for ACPX resets. */
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import type { AcpxRuntime as BaseAcpxRuntime, AcpRuntimeOptions } from "acpx/runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { AcpRuntime } from "../runtime-api.js";
import { renderAgentCommand, splitCommandParts, type AcpxAgentCommand } from "./command-line.js";
import {
  readAcpxProcessLeaseIdentity,
  type AcpxProcessLease,
  type AcpxProcessLeaseIdentity,
  type AcpxProcessLeaseStore,
} from "./process-lease.js";
import { isOpenClawLeaseAwareAcpxProcessCommand } from "./process-reaper.js";
type OpenClawRuntimeHandle = Awaited<ReturnType<AcpRuntime["ensureSession"]>>;
export type AcpSessionStore = AcpRuntimeOptions["sessionStore"];
export type AcpSessionRecord = Parameters<AcpSessionStore["save"]>[0];
export type AcpLoadedSessionRecord = Awaited<ReturnType<AcpSessionStore["load"]>>;
export type ResetAwareSessionStore = AcpSessionStore & {
  markFresh: (sessionKey: string) => void;
  isFresh: (sessionKey: string) => boolean;
  loadForClose: (sessionKey: string) => Promise<AcpLoadedSessionRecord>;
};

type OpenClawLeaseSessionMetadata = {
  openclawLeaseId: string;
  openclawGatewayInstanceId: string;
};

function withOpenClawLeaseSessionMetadata<T extends object>(
  record: T,
  lease: AcpxProcessLeaseIdentity,
): T & OpenClawLeaseSessionMetadata {
  return {
    ...record,
    openclawLeaseId: lease.leaseId,
    openclawGatewayInstanceId: lease.gatewayInstanceId,
  };
}

export type AcpxLaunchLeaseContext = {
  leaseId: string;
  gatewayInstanceId: string;
  sessionKey: string;
  wrapperRoot: string;
  resolvedCommand: AcpxAgentCommand;
  leasedCommand: AcpxAgentCommand;
};

export type AcpxGeneration = {
  id: number;
  owner: symbol;
  resource: string;
  ensureQueue: KeyedAsyncQueue;
  retired: boolean;
  activeOperations: number;
  pendingAdmissions: number;
  admissionState: "unadmitted" | "failed" | "admitted";
  activeRecordOperations: Map<string, number>;
  closedRecordIds: Set<string>;
  afterReset: boolean;
  awaitPriorWrites: boolean;
  records: Map<string, NonNullable<AcpLoadedSessionRecord>>;
  closeCompleted: boolean;
  delegate?: BaseAcpxRuntime;
};
export function captureGenerationRecord(
  generation: AcpxGeneration,
  record: NonNullable<AcpLoadedSessionRecord>,
): void {
  // Closed history remains in the upstream store, not this live-owner cache.
  // A close can settle before a turn's final checkpoint, so retain its fence
  // until that physical record's admitted operations have finished.
  if (record.closed || generation.closedRecordIds.has(record.acpxRecordId)) {
    generation.records.delete(record.acpxRecordId);
  } else {
    generation.records.set(record.acpxRecordId, record);
  }
}

export const acpxGenerationKey = Symbol("openclaw.acpxGeneration");
export type GenerationHandle = OpenClawRuntimeHandle & { [acpxGenerationKey]?: AcpxGeneration };
export const acpxOperationScope = new AsyncLocalStorage<{
  generation: AcpxGeneration;
  closeRecord?: AcpLoadedSessionRecord;
  recordId?: string;
}>();

export function readSessionRecordName(record: unknown): string {
  if (typeof record !== "object" || record === null) {
    return "";
  }
  // SAFETY: record is a non-null object; the property stays unknown until checked below.
  const { name } = record as { name?: unknown };
  return typeof name === "string" ? name.trim() : "";
}

export function readRecordAgentCommand(
  record: AcpLoadedSessionRecord,
): AcpxAgentCommand | undefined {
  return record?.agentArgv ?? record?.agentCommand;
}

export function readRecordCwd(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) {
    return undefined;
  }
  // SAFETY: record is a non-null object; cwd is validated before use.
  const { cwd } = record as { cwd?: unknown };
  return typeof cwd === "string" ? cwd.trim() || undefined : undefined;
}

export function readRecordResetOnNextEnsure(record: unknown): boolean {
  if (typeof record !== "object" || record === null) {
    return false;
  }
  // SAFETY: record is a non-null object; nested ACPX state is validated below.
  const { acpx } = record as { acpx?: unknown };
  if (typeof acpx !== "object" || acpx === null) {
    return false;
  }
  // SAFETY: acpx is a non-null object; only a strict boolean true is accepted.
  return (acpx as { reset_on_next_ensure?: unknown }).reset_on_next_ensure === true;
}

export function readRecordAgentPid(record: unknown): number | undefined {
  if (typeof record !== "object" || record === null) {
    return undefined;
  }
  // SAFETY: record is a non-null object; both possible PID values remain unknown.
  const { pid, processId } = record as { pid?: unknown; processId?: unknown };
  const rawPid = pid ?? processId;
  const numericPid =
    typeof rawPid === "number"
      ? rawPid
      : typeof rawPid === "string"
        ? parseStrictPositiveInteger(rawPid)
        : undefined;
  return numericPid && Number.isInteger(numericPid) && numericPid > 0 ? numericPid : undefined;
}

export function readOpenClawLeaseIdFromRecord(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) {
    return undefined;
  }
  // SAFETY: record is a non-null object; the lease ID is validated as a string.
  const { openclawLeaseId } = record as { openclawLeaseId?: unknown };
  return typeof openclawLeaseId === "string" ? openclawLeaseId.trim() || undefined : undefined;
}

export function readOpenClawGatewayInstanceIdFromRecord(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) {
    return undefined;
  }
  // SAFETY: record is a non-null object; the instance ID is validated as a string.
  const { openclawGatewayInstanceId } = record as { openclawGatewayInstanceId?: unknown };
  return typeof openclawGatewayInstanceId === "string"
    ? openclawGatewayInstanceId.trim() || undefined
    : undefined;
}

export function extractGeneratedWrapperPath(command: AcpxAgentCommand | undefined): string {
  const parts = splitCommandParts(command ?? "");
  return (
    parts.find(
      (part) =>
        (part.split(/[\\/]/).pop() ?? "") === "codex-acp-wrapper.mjs" ||
        (part.split(/[\\/]/).pop() ?? "") === "claude-agent-acp-wrapper.mjs",
    ) ?? ""
  );
}

export function selectCurrentSessionLease(params: {
  leases: AcpxProcessLease[];
  sessionKeys: string[];
  rootPid?: number;
}): AcpxProcessLease | undefined {
  const sessionKeys = new Set(normalizeStringEntries(params.sessionKeys));
  const candidates = params.leases.filter((lease) => sessionKeys.has(lease.sessionKey));
  if (params.rootPid) {
    return candidates.find((lease) => lease.rootPid === params.rootPid);
  }
  let selected: AcpxProcessLease | undefined;
  for (const lease of candidates) {
    if (!selected || lease.startedAt > selected.startedAt) {
      selected = lease;
    }
  }
  return selected;
}

export function createResetAwareSessionStore(
  baseStore: AcpSessionStore,
  params?: {
    gatewayInstanceId?: string;
    leaseStore?: AcpxProcessLeaseStore;
    launchScope?: AsyncLocalStorage<AcpxLaunchLeaseContext | undefined>;
    wrapperRoot?: string;
  },
): ResetAwareSessionStore {
  const freshSessionKeys = new Set<string>();
  const stateQueue = new KeyedAsyncQueue();
  const pendingWrites = new Map<string, Set<Promise<void>>>();

  return {
    async load(sessionId: string): Promise<AcpLoadedSessionRecord> {
      const scope = acpxOperationScope.getStore();
      if (
        scope?.closeRecord &&
        (sessionId === scope.generation.resource || sessionId === scope.closeRecord.acpxRecordId)
      ) {
        return scope.closeRecord;
      }
      const resource = scope?.generation.resource ?? sessionId.trim();
      const pending = pendingWrites.get(sessionId.trim());
      if (pending && (scope?.generation.awaitPriorWrites || freshSessionKeys.has(resource))) {
        await Promise.allSettled(pending);
      }
      const load = async () => {
        if (scope?.generation.retired) {
          return undefined;
        }
        const normalized = sessionId.trim();
        if (normalized && freshSessionKeys.has(normalized)) {
          return undefined;
        }
        const record = await baseStore.load(sessionId);
        if (
          scope?.generation.retired ||
          freshSessionKeys.has(scope?.generation.resource ?? normalized)
        ) {
          return undefined;
        }
        if (scope && record) {
          captureGenerationRecord(scope.generation, record);
        }
        if (!record || !params?.leaseStore || !params.gatewayInstanceId) {
          return record;
        }
        const sessionName = readSessionRecordName(record) || normalized;
        const lease = selectCurrentSessionLease({
          leases: await params.leaseStore.listOpen(params.gatewayInstanceId),
          sessionKeys: [sessionName, normalized],
          rootPid: readRecordAgentPid(record),
        });
        if (!lease) {
          return record;
        }
        if (scope?.generation.retired) {
          return undefined;
        }
        const leasedRecord = withOpenClawLeaseSessionMetadata(record, lease);
        if (scope) {
          captureGenerationRecord(scope.generation, leasedRecord);
        }
        return leasedRecord;
      };
      return await load();
    },
    async save(record: AcpSessionRecord): Promise<void> {
      const scope = acpxOperationScope.getStore();
      // Keep the exact old record available for cleanup even when publication is fenced.
      if (scope) {
        captureGenerationRecord(scope.generation, record);
      }
      // Different oneshot records can share a logical session key. Only writes
      // to the same physical record conflict, including terminal reset markers.
      const resource = record.acpxRecordId;
      const retiredCloseRecord =
        scope?.generation.retired && record.closed && record.acpx?.reset_on_next_ensure === true
          ? scope.closeRecord
          : undefined;
      const writeRecord = async () => {
        if (scope?.generation.retired) {
          if (!retiredCloseRecord) {
            return;
          }
          // A completed discard must survive restart, but only while the captured
          // physical record still owns storage. Successor writes share this fence.
          const persisted = await baseStore.load(record.acpxRecordId);
          if (
            !persisted ||
            persisted.acpxRecordId !== retiredCloseRecord.acpxRecordId ||
            persisted.acpSessionId !== retiredCloseRecord.acpSessionId ||
            persisted.createdAt !== retiredCloseRecord.createdAt
          ) {
            return;
          }
          await baseStore.save(record);
          return;
        }
        let recordToSave = record;
        const launch = params?.launchScope?.getStore();
        const sessionName = readSessionRecordName(record);
        const agentCommand = readRecordAgentCommand(record);
        const leasedCommand = launch?.leasedCommand ?? agentCommand;
        const leaseIdentity = launch ?? readAcpxProcessLeaseIdentity(leasedCommand);
        if (
          params?.leaseStore &&
          params.gatewayInstanceId &&
          params.wrapperRoot &&
          (!launch || sessionName === launch.sessionKey) &&
          leasedCommand &&
          leaseIdentity?.gatewayInstanceId === params.gatewayInstanceId &&
          isOpenClawLeaseAwareAcpxProcessCommand({
            command: leasedCommand,
            wrapperRoot: params.wrapperRoot,
          })
        ) {
          const existing = await params.leaseStore.load(leaseIdentity.leaseId);
          if (scope?.generation.retired) {
            return;
          }
          const ownsExisting =
            !existing ||
            (existing.gatewayInstanceId === leaseIdentity.gatewayInstanceId &&
              existing.sessionKey === sessionName &&
              existing.wrapperRoot === params.wrapperRoot);
          if (ownsExisting) {
            const adoptingLease = Boolean(
              launch &&
              !isDeepStrictEqual(
                splitCommandParts(launch.resolvedCommand),
                splitCommandParts(launch.leasedCommand),
              ),
            );
            const persistedCommand =
              launch && !adoptingLease ? launch.resolvedCommand : leasedCommand;
            const lifecycleRecord = adoptingLease
              ? {
                  ...record,
                  // A reused legacy record can carry the previous wrapper PID. Clear
                  // it before persisting the new lease so reconnect cannot claim it.
                  pid: undefined,
                  processId: undefined,
                  agentStartedAt: undefined,
                }
              : record;
            recordToSave = withOpenClawLeaseSessionMetadata(
              {
                ...lifecycleRecord,
                // ACPX reconnects from the persisted command, so lease identity must
                // remain in that reuse key until the session lifecycle is terminal.
                agentCommand: renderAgentCommand(persistedCommand),
                agentArgv: Array.isArray(persistedCommand) ? persistedCommand : undefined,
              },
              leaseIdentity,
            );
          }
        }
        if (scope?.generation.retired) {
          return;
        }
        await baseStore.save(recordToSave);
        if (scope && !scope.generation.retired) {
          scope.generation.awaitPriorWrites = false;
        }
        if (sessionName && !scope?.generation.retired) {
          freshSessionKeys.delete(sessionName);
        }
      };
      // Reset successors and terminal old-record writes serialize only conflicting
      // persistence. Ordinary close overlap retains ACPX's non-blocking semantics.
      const writes = pendingWrites.get(resource) ?? new Set<Promise<void>>();
      const previous = [...writes];
      const write =
        scope?.generation.awaitPriorWrites || retiredCloseRecord
          ? Promise.allSettled(previous).then(() => stateQueue.enqueue(resource, writeRecord))
          : writeRecord();
      writes.add(write);
      pendingWrites.set(resource, writes);
      try {
        await write;
      } finally {
        writes.delete(write);
        if (writes.size === 0 && pendingWrites.get(resource) === writes) {
          pendingWrites.delete(resource);
        }
      }
    },
    // Snapshot cleanup without joining a blocked writer or consulting fresh-name markers.
    loadForClose: (sessionKey) => baseStore.load(sessionKey),
    isFresh: (sessionKey) => freshSessionKeys.has(sessionKey),
    markFresh(sessionKey: string): void {
      const normalized = sessionKey.trim();
      if (normalized) {
        freshSessionKeys.add(normalized);
      }
    },
  };
}
