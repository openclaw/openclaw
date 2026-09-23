import { channel } from "node:diagnostics_channel";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";

const CHANNELS = [
  "openclaw.redaction",
  "openclaw.session.write",
  "openclaw.session.list",
  "openclaw.worker.task",
] as const;
const METRICS = [
  "elapsedMs",
  "threadCpuMs",
  "inputChars",
  "patternCount",
  "queueWaitMs",
  "writerExecutionMs",
  "completionDelayMs",
  "handlerElapsedMs",
  "storeLoadThreadCpuMs",
  "prepareThreadCpuMs",
  "rowThreadCpuMs",
  "cacheSelectionThreadCpuMs",
  "cachePublicationThreadCpuMs",
  "responseThreadCpuMs",
  "prepareSyncMs",
  "rowSyncMs",
  "yieldWaitMs",
  "yieldCount",
  "projectionPasses",
  "rowRepairCount",
  "fullReloadCount",
  "selectedRowCount",
  "queueMs",
  "preparationMs",
  "runMs",
  "transferMs",
  "pendingTasks",
  "pendingBytes",
] as const;
const PHASES = [
  "setup",
  "modelCatalog",
  "cacheSelectionOrWait",
  "storeLoad",
  "filterSetup",
  "rows",
  "sharing",
  "decoration",
  "visibilityRepair",
  "response",
  "handlerExit",
] as const;

type Metric = { count: number; total: number; max: number };
type Group = {
  channel: string;
  operation: string;
  outcome: string;
  cacheRole?: string;
  writer?: string;
  count: number;
  metrics: Record<string, Metric>;
};

function add(metrics: Record<string, Metric>, key: string, value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return;
  }
  const metric = (metrics[key] ??= { count: 0, total: 0, max: 0 });
  metric.count += 1;
  metric.total += value;
  metric.max = Math.max(metric.max, value);
}

/** Bounded numeric aggregates for the benchmark's main isolate; profiles cover workers. */
export function startGatewayBenchDiagnostics() {
  const startedAt = performance.now();
  const groups = new Map<string, Group>();
  let droppedEvents = 0;
  let collectionErrors = 0;
  const subscriptions = CHANNELS.map((name) => {
    const source = channel(name);
    const listener = (message: unknown) => {
      // Node forwards subscriber throws to uncaughtException. Keep capture failures local.
      try {
        if (!isRecord(message)) {
          return;
        }
        const operation = name === "openclaw.worker.task" ? message.worker : message.operation;
        if (typeof operation !== "string" || !/^[a-zA-Z0-9_.-]{1,160}$/.test(operation)) {
          return;
        }
        const outcome =
          message.outcome === "ok" || message.outcome === "error" || message.outcome === "failed"
            ? message.outcome
            : message.responseOutcome === "ok"
              ? "ok"
              : "error";
        const cacheRole = [
          "unreached",
          "completed-hit",
          "in-flight-follower",
          "projection-owner",
        ].includes(String(message.cacheRole))
          ? String(message.cacheRole)
          : undefined;
        const writer =
          message.writer === "foreground" || message.writer === "worker"
            ? message.writer
            : undefined;
        const key = JSON.stringify([name, operation, outcome, cacheRole, writer]);
        let group = groups.get(key);
        if (!group) {
          if (groups.size >= 256) {
            droppedEvents += 1;
            return;
          }
          group = { channel: name, operation, outcome, cacheRole, writer, count: 0, metrics: {} };
          groups.set(key, group);
        }
        group.count += 1;
        for (const metric of METRICS) {
          add(group.metrics, metric, message[metric]);
        }
        if (isRecord(message.phaseDurationsMs)) {
          for (const phase of PHASES) {
            add(group.metrics, `phase.${phase}Ms`, message.phaseDurationsMs[phase]);
          }
        }
      } catch {
        collectionErrors += 1;
      }
    };
    source.subscribe(listener);
    return () => source.unsubscribe(listener);
  });
  const gc: Record<string, Metric> = {};
  const collectGc = (entries: readonly { startTime: number; duration: number }[]) => {
    for (const entry of entries) {
      if (entry.startTime >= startedAt) {
        add(gc, "durationMs", entry.duration);
      }
    }
  };
  const observer = new PerformanceObserver((list) => collectGc(list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  return () => {
    const endedAt = performance.now();
    for (const unsubscribe of subscriptions) {
      unsubscribe();
    }
    collectGc(observer.takeRecords());
    observer.disconnect();
    return {
      scope: "main-isolate",
      durationMs: endedAt - startedAt,
      droppedEvents,
      collectionErrors,
      gc,
      groups: [...groups.values()],
    };
  };
}
