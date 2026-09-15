import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isMainThread, threadId } from "node:worker_threads";
import {
  areDiagnosticsEnabledForProcess,
  createSubsystemLogger,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type {
  CodexControlRequestFailure,
  CodexControlRequestFailureCategory,
  CodexControlRequestObservation,
  CodexControlRequestPhase,
} from "./app-server/request-observation.js";

const log = createSubsystemLogger("gateway/session-catalog");
const listScope = new AsyncLocalStorage<CodexCatalogListDiagnostics | undefined>();
let epoch: string | undefined;
let sequence = 0;
let active = 0;
let windowStart = 0;
let emitted = 0;
let omitted = 0;

type Observation<T> = {
  operationId: string;
  fields: T;
  closed: boolean;
  finish(outcome: "resolved" | "rejected"): void;
};

type ListFields = {
  localHostCount?: number;
  controlPageCalls: number;
  coldStarts: number;
  pendingJoins: number;
  freshHits: number;
  staleHits: number;
  refreshStarts: number;
  managedSnapshotMs?: number;
  controlWaitSumMs?: number;
  exclusionMarkCalls: number;
  exclusionMarkSumMs?: number;
  adoptionCalls: number;
  adoptionSumMs?: number;
  mappingMs?: number;
  nodeRegistryCalls?: number;
  nodeRegistryMs?: number;
  pairedNodeCalls?: number;
  pairedNodeSettled?: number;
  nodeWaitSumMs?: number;
};

type PageFields = {
  origin: "cold" | "refresh" | "uncached";
  listOperationId?: string;
  controlRequestCalls: number;
  controlFailurePhase?: CodexControlRequestPhase;
  controlFailureCategory?: CodexControlRequestFailureCategory;
  inclusiveControlRequestWaitMs?: number;
  inclusiveControlRequestWaitMaxMs?: number;
  controlLoadMs?: number;
  controlPrepareMs?: number;
  controlAcquireClientMs?: number;
  controlClientRequestMs?: number;
  controlReleaseClientMs?: number;
  postResponseMs?: number;
  provenanceChecks: number;
  provenanceCacheHits: number;
  provenanceReadCalls: number;
  provenanceMs?: number;
  stopReason?: "exhausted" | "limit" | "page-bound";
};

export type CodexCatalogListDiagnostics = Observation<ListFields>;
export type CodexCatalogPageDiagnostics = Observation<PageFields>;

const CONTROL_PHASE_FIELDS = {
  "load-control": "controlLoadMs",
  prepare: "controlPrepareMs",
  "acquire-client": "controlAcquireClientMs",
  "client-request": "controlClientRequestMs",
  "release-client": "controlReleaseClientMs",
} as const satisfies Record<CodexControlRequestPhase, keyof PageFields>;

function enabled(): boolean {
  return areDiagnosticsEnabledForProcess() && log.isEnabled("warn");
}

function start<
  T extends
    | ListFields
    | PageFields
    | {
        listOperationId?: string;
        producerOperationId?: string;
        producerObserved: boolean;
      },
>(kind: "list phases" | "page producer" | "cache wait", fields: T): Observation<T> | undefined {
  if (!enabled()) {
    return undefined;
  }
  if (active >= 64) {
    omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + 1);
    return undefined;
  }
  active++;
  epoch ??= randomUUID();
  const started = performance.now();
  const observation: Observation<T> = {
    operationId: String(++sequence),
    fields,
    closed: false,
    finish(outcome) {
      if (observation.closed) {
        return;
      }
      observation.closed = true;
      active--;
      const elapsedMs = performance.now() - started;
      try {
        if (elapsedMs < 1_000 || !enabled()) {
          return;
        }
        if (performance.now() - windowStart >= 60_000) {
          windowStart = performance.now();
          emitted = 0;
        }
        if (emitted >= 60) {
          omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + 1);
          return;
        }
        const metadata = {
          diagnosticEpoch: epoch,
          operationId: observation.operationId,
          pid: process.pid,
          threadId,
          isMainThread,
          elapsedMs: Math.round(elapsedMs),
          outcome,
          omittedObservations: omitted,
          ...Object.fromEntries(
            Object.entries(fields)
              .filter(([, value]) => value !== undefined)
              .map(([key, value]) => [key, typeof value === "number" ? Math.round(value) : value]),
          ),
        };
        if (
          Object.keys(metadata).length > 28 ||
          Buffer.byteLength(JSON.stringify(metadata)) > 2_048
        ) {
          omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + 1);
          return;
        }
        emitted++;
        log.warn(`slow Codex catalog ${kind}`, metadata);
        omitted = 0;
      } catch {
        // A diagnostic sink must not replace the catalog result or error.
      }
    },
  };
  return observation;
}

export function currentCodexCatalogListDiagnostics(): CodexCatalogListDiagnostics | undefined {
  const observation = listScope.getStore();
  return observation?.closed ? undefined : observation;
}

/** One logical list scope survives admission pauses; finishing drops its captured context. */
export function createCodexCatalogListScope() {
  const observation = start<ListFields>("list phases", {
    controlPageCalls: 0,
    coldStarts: 0,
    pendingJoins: 0,
    freshHits: 0,
    staleHits: 0,
    refreshStarts: 0,
    exclusionMarkCalls: 0,
    adoptionCalls: 0,
  });
  let captured: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined = listScope.run(
    observation,
    () => AsyncLocalStorage.snapshot(),
  );
  return {
    run<T>(run: () => T): T {
      if (!captured) {
        throw new Error("Codex catalog diagnostic scope is closed");
      }
      return captured(run);
    },
    finish(outcome: "resolved" | "rejected"): void {
      const finishInScope = captured;
      captured = undefined;
      finishInScope?.(() => observation?.finish(outcome));
    },
  };
}

export function startCodexCatalogPageDiagnostics(origin: PageFields["origin"]) {
  return start<PageFields>("page producer", {
    origin,
    listOperationId: currentCodexCatalogListDiagnostics()?.operationId,
    controlRequestCalls: 0,
    provenanceChecks: 0,
    provenanceCacheHits: 0,
    provenanceReadCalls: 0,
  } satisfies PageFields);
}

export function waitForCodexCatalogPage<T>(
  page: Promise<T>,
  producerOperationId?: string,
): Promise<T> {
  const observation = start("cache wait", {
    listOperationId: currentCodexCatalogListDiagnostics()?.operationId,
    producerOperationId,
    producerObserved: producerOperationId !== undefined,
  });
  if (!observation) {
    return page;
  }
  return (async () => {
    let outcome: "resolved" | "rejected" = "rejected";
    try {
      const result = await page;
      outcome = "resolved";
      return result;
    } finally {
      observation.finish(outcome);
    }
  })();
}

export function startCodexCatalogControlRequestDiagnostics(
  page: CodexCatalogPageDiagnostics | null | undefined,
) {
  if (!page) {
    return undefined;
  }
  let state: "active" | "failed" | "closed" = "active";
  let phase: CodexControlRequestPhase = "load-control";
  let phaseStarted = performance.now();
  const finishPhase = () => {
    const now = performance.now();
    const field = CONTROL_PHASE_FIELDS[phase];
    page.fields[field] = (page.fields[field] ?? 0) + (now - phaseStarted);
    phaseStarted = now;
  };
  const observation = {
    phase(next: CodexControlRequestPhase) {
      if (state === "active" && !page.closed) {
        finishPhase();
        phase = next;
      }
    },
    failed(failure: CodexControlRequestFailure) {
      if (state === "active" && !page.closed) {
        finishPhase();
        state = "failed";
        page.fields.controlFailurePhase = failure.phase;
        page.fields.controlFailureCategory = failure.category;
      }
    },
    rejected() {
      observation.failed({ phase, category: "other" });
    },
    close() {
      if (state === "active" && !page.closed) {
        finishPhase();
      }
      state = "closed";
    },
  } satisfies CodexControlRequestObservation & { rejected(): void; close(): void };
  return observation;
}
