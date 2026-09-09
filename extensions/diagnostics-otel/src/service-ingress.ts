import type { Attributes } from "@opentelemetry/api";
import {
  CHANNEL_INGRESS_BLOCKERS,
  CHANNEL_INGRESS_OPERATION_KINDS,
  CHANNEL_INGRESS_PREPARATION_STAGES,
  isInternalDiagnosticEventMetadata,
  type ChannelIngressObservabilitySnapshot,
  type DiagnosticEventMetadata,
  type DiagnosticEventPayload,
} from "../api.js";
import type { DiagnosticsRecorderRuntime } from "./service-recorder-runtime.js";

const STALE_INGRESS_SNAPSHOT_MS = 45_000;

type IngressSnapshotState = {
  latest?: ChannelIngressObservabilitySnapshot;
  receivedAt?: number;
};

function nonNegativeFiniteValue(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonNegativeFiniteCount(value: number | undefined): number {
  return nonNegativeFiniteValue(value) ?? 0;
}

function ageAtCollection(
  snapshot: ChannelIngressObservabilitySnapshot,
  sampledAgeMs: number | undefined,
  now: number,
): number | undefined {
  const ageMs = nonNegativeFiniteValue(sampledAgeMs);
  if (ageMs === undefined) {
    return undefined;
  }
  return ageMs + Math.max(0, now - snapshot.sampledAt);
}

function shouldRecordDiagnosticEvent(metadata: DiagnosticEventMetadata): boolean {
  return isInternalDiagnosticEventMetadata(metadata);
}

export function createIngressSnapshotRecorder(runtime: DiagnosticsRecorderRuntime) {
  const state: IngressSnapshotState = {};

  const latestFreshSnapshot = (now = Date.now()) => {
    if (!state.latest || state.receivedAt === undefined) {
      return undefined;
    }
    if (now - state.receivedAt > STALE_INGRESS_SNAPSHOT_MS) {
      return undefined;
    }
    if (now - state.latest.sampledAt > STALE_INGRESS_SNAPSHOT_MS) {
      return undefined;
    }
    return state.latest;
  };
  const latestFreshKnownSnapshot = (now = Date.now()) => {
    const snapshot = latestFreshSnapshot(now);
    return snapshot?.status === "known" ? snapshot : undefined;
  };

  const cleanupCallbacks = [
    runtime.registerObservableGaugeCallback(runtime.ingressOutstandingCountGauge, (observable) => {
      const snapshot = latestFreshKnownSnapshot();
      if (!snapshot) {
        return;
      }
      for (const stageName of CHANNEL_INGRESS_PREPARATION_STAGES) {
        const stage = snapshot.stages?.[stageName];
        for (const blockerName of CHANNEL_INGRESS_BLOCKERS) {
          const blocker = stage?.blockers?.[blockerName];
          observable.observe(nonNegativeFiniteCount(blocker?.total), {
            "openclaw.ingress.stage": stageName,
            "openclaw.ingress.blocker": blockerName,
          } satisfies Attributes);
        }
      }
      for (const blockerName of CHANNEL_INGRESS_BLOCKERS) {
        const blocker = snapshot.unknown?.blockers?.[blockerName];
        observable.observe(nonNegativeFiniteCount(blocker?.total), {
          "openclaw.ingress.stage": "unknown",
          "openclaw.ingress.blocker": blockerName,
        } satisfies Attributes);
      }
    }),
    runtime.registerObservableGaugeCallback(runtime.ingressOldestReceiptAgeGauge, (observable) => {
      const now = Date.now();
      const snapshot = latestFreshKnownSnapshot(now);
      if (!snapshot) {
        return;
      }
      for (const stageName of CHANNEL_INGRESS_PREPARATION_STAGES) {
        const stage = snapshot.stages?.[stageName];
        for (const blockerName of CHANNEL_INGRESS_BLOCKERS) {
          const blocker = stage?.blockers?.[blockerName];
          const ageMs = ageAtCollection(snapshot, blocker?.oldestReceiptAgeMs, now);
          if (ageMs !== undefined) {
            observable.observe(ageMs, {
              "openclaw.ingress.stage": stageName,
              "openclaw.ingress.blocker": blockerName,
            } satisfies Attributes);
          }
        }
      }
      for (const blockerName of CHANNEL_INGRESS_BLOCKERS) {
        const blocker = snapshot.unknown?.blockers?.[blockerName];
        const ageMs = ageAtCollection(snapshot, blocker?.oldestReceiptAgeMs, now);
        if (ageMs !== undefined) {
          observable.observe(ageMs, {
            "openclaw.ingress.stage": "unknown",
            "openclaw.ingress.blocker": blockerName,
          } satisfies Attributes);
        }
      }
    }),
    runtime.registerObservableGaugeCallback(runtime.ingressMaxNoProgressAgeGauge, (observable) => {
      const now = Date.now();
      const snapshot = latestFreshKnownSnapshot(now);
      if (!snapshot) {
        return;
      }
      for (const stageName of CHANNEL_INGRESS_PREPARATION_STAGES) {
        const stage = snapshot.stages?.[stageName];
        const ageMs = ageAtCollection(snapshot, stage?.maxEligibleNoProgressAgeMs, now);
        if (ageMs !== undefined) {
          observable.observe(ageMs, {
            "openclaw.ingress.stage": stageName,
          } satisfies Attributes);
        }
      }
      const unknownAgeMs = ageAtCollection(
        snapshot,
        snapshot.unknown?.maxEligibleNoProgressAgeMs,
        now,
      );
      if (unknownAgeMs !== undefined) {
        observable.observe(unknownAgeMs, {
          "openclaw.ingress.stage": "unknown",
        } satisfies Attributes);
      }
    }),
    runtime.registerObservableGaugeCallback(
      runtime.ingressUnknownProgressCountGauge,
      (observable) => {
        const snapshot = latestFreshKnownSnapshot();
        if (!snapshot) {
          return;
        }
        for (const stageName of CHANNEL_INGRESS_PREPARATION_STAGES) {
          const stage = snapshot.stages?.[stageName];
          observable.observe(nonNegativeFiniteCount(stage?.unknownProgress), {
            "openclaw.ingress.stage": stageName,
          } satisfies Attributes);
        }
        observable.observe(nonNegativeFiniteCount(snapshot.unknown?.unknownProgress), {
          "openclaw.ingress.stage": "unknown",
        } satisfies Attributes);
      },
    ),
    runtime.registerObservableGaugeCallback(
      runtime.ingressFailedRecordsCountGauge,
      (observable) => {
        const snapshot = latestFreshKnownSnapshot();
        if (!snapshot) {
          return;
        }
        observable.observe(nonNegativeFiniteCount(snapshot.failedCount), {} satisfies Attributes);
      },
    ),
    runtime.registerObservableGaugeCallback(
      runtime.ingressOperationActiveCountGauge,
      (observable) => {
        const snapshot = latestFreshKnownSnapshot();
        if (!snapshot) {
          return;
        }
        for (const kind of CHANNEL_INGRESS_OPERATION_KINDS) {
          const operation = snapshot.operations?.[kind];
          if (!operation?.known) {
            continue;
          }
          observable.observe(nonNegativeFiniteCount(operation?.total), {
            "openclaw.ingress.operation.kind": kind,
          } satisfies Attributes);
        }
      },
    ),
    runtime.registerObservableGaugeCallback(runtime.ingressOperationMaxAgeGauge, (observable) => {
      const now = Date.now();
      const snapshot = latestFreshKnownSnapshot(now);
      if (!snapshot) {
        return;
      }
      for (const kind of CHANNEL_INGRESS_OPERATION_KINDS) {
        const operation = snapshot.operations?.[kind];
        if (!operation?.known) {
          continue;
        }
        const ageMs = ageAtCollection(snapshot, operation?.oldestAgeMs, now);
        if (ageMs !== undefined) {
          observable.observe(ageMs, {
            "openclaw.ingress.operation.kind": kind,
          } satisfies Attributes);
        }
      }
    }),
    runtime.registerObservableGaugeCallback(runtime.ingressSnapshotKnownGauge, (observable) => {
      const snapshot = latestFreshSnapshot();
      observable.observe(snapshot?.status === "known" ? 1 : 0, {} satisfies Attributes);
    }),
    runtime.registerObservableGaugeCallback(runtime.ingressSnapshotSampledAtGauge, (observable) => {
      const snapshot = latestFreshSnapshot();
      if (!snapshot) {
        return;
      }
      observable.observe(Math.floor(snapshot.sampledAt / 1000), {} satisfies Attributes);
    }),
    runtime.registerObservableGaugeCallback(runtime.ingressSnapshotFreshnessGauge, (observable) => {
      const now = Date.now();
      const snapshot = latestFreshSnapshot(now);
      if (!snapshot) {
        return;
      }
      observable.observe(Math.max(0, now - snapshot.sampledAt), {} satisfies Attributes);
    }),
  ];

  return {
    recordIngressSnapshot: (
      evt: Extract<DiagnosticEventPayload, { type: "ingress.snapshot" }>,
      metadata: DiagnosticEventMetadata,
    ) => {
      if (!shouldRecordDiagnosticEvent(metadata)) {
        return;
      }
      const now = Date.now();
      if (!Number.isFinite(evt.sampledAt) || evt.sampledAt > now) {
        return;
      }
      if (state.latest && evt.sampledAt < state.latest.sampledAt) {
        return;
      }
      const { seq: _seq, ts: _ts, trace: _trace, ...snapshot } = evt;
      state.latest = snapshot;
      state.receivedAt = now;
    },
    stopIngressSnapshotRecorder: () => {
      for (const cleanup of cleanupCallbacks) {
        cleanup();
      }
    },
  };
}
