import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import type { SessionEntry } from "../../src/config/sessions/types.js";

type Task = {
  calls: number;
  inclusiveMs: number;
  cpuMs: number;
  durations: number[];
  exclusiveMs: number;
  maxSegmentMs: number;
  stalls: number;
  stallMs: number;
};
type Frame = { label: string; at: number; cpu: NodeJS.CpuUsage; segmentAt: number; parent?: Frame };
const tasks = new Map<string, Task>();
const firstSearch = new Map<string, string>();
const objectIds = new WeakMap<object, number>();
const returnedRefs = new Map<number, WeakRef<object>>();
let nextObject = 0;
let nextConsume = 0;
let consume: number | undefined;
let frame: Frame | undefined;
let window = "startup";
let detailed = false;
let search = {
  executions: 0,
  matches: 0,
  initialBuilds: 0,
  repeatBuilds: 0,
  staticFactChanges: 0,
  cpuMs: 0,
  elapsedMs: 0,
  filters: [] as Record<string, unknown>[],
};
let presentation = {
  calls: 0,
  misses: 0,
  ids: new Set<number>(),
  reads: new Map<number, Set<number>>(),
  acrossReads: new Map<number, Set<number>>(),
};
let materialization = {
  first: 0,
  repeated: 0,
  identicalRow: 0,
  identicalSource: 0,
  materializedReplacements: 0,
  factsReplacements: 0,
  changedFields: {} as Record<string, number>,
  sourceChangedFields: {} as Record<string, number>,
  rowChangedFields: {} as Record<string, number>,
};
const bucket = (label: string) => {
  let value = tasks.get(label);
  if (!value) {
    value = {
      calls: 0,
      inclusiveMs: 0,
      cpuMs: 0,
      durations: [],
      exclusiveMs: 0,
      maxSegmentMs: 0,
      stalls: 0,
      stallMs: 0,
    };
    tasks.set(label, value);
  }
  return value;
};
function segment(value: Frame, at: number) {
  const duration = at - value.segmentAt;
  const task = bucket(value.label);
  task.exclusiveMs += duration;
  task.maxSegmentMs = Math.max(task.maxSegmentMs, duration);
  if (duration > 100) {
    task.stalls++;
    task.stallMs += duration;
  }
}
export function r2Task<T>(name: string, run: () => T, phase?: string): T {
  const at = performance.now();
  const parent = frame;
  if (parent) {
    segment(parent, at);
  }
  const current = {
    label: phase ? `${name}:${phase}` : name,
    at,
    cpu: process.threadCpuUsage(),
    segmentAt: at,
    parent,
  };
  frame = current;
  try {
    return run();
  } finally {
    const end = performance.now();
    segment(current, end);
    const cpu = process.threadCpuUsage(current.cpu);
    const task = bucket(current.label);
    task.calls++;
    task.inclusiveMs += end - at;
    task.cpuMs += (cpu.user + cpu.system) / 1000;
    task.durations.push(end - at);
    frame = parent;
    if (parent) {
      parent.segmentAt = performance.now();
    }
  }
}
export function r2Consume<T>(run: () => T): T {
  const before = consume;
  consume = ++nextConsume;
  try {
    return run();
  } finally {
    consume = before;
  }
}
export function r2SearchStart(enabled: unknown) {
  return enabled
    ? {
        cpu: process.threadCpuUsage(),
        at: performance.now(),
        initial: search.initialBuilds,
        repeat: search.repeatBuilds,
        matches: search.matches,
      }
    : undefined;
}
export function r2SearchMatch() {
  search.matches++;
}
export function r2SearchBuild(key: string, entry: SessionEntry) {
  const value = !detailed
    ? "static"
    : JSON.stringify([
        entry.sessionId,
        entry.label,
        entry.subject,
        entry.category,
        entry.displayName,
        entry.autoLabel,
        entry.topicName,
        entry.groupChannel,
        entry.space,
        entry.delivery,
        entry.chatType,
        entry.spawnedBy,
        entry.modelProvider,
        entry.model,
      ]);
  const previous = firstSearch.get(key);
  if (previous === undefined) {
    firstSearch.set(key, value);
    search.initialBuilds++;
  } else {
    search.repeatBuilds++;
    if (previous !== value) {
      search.staticFactChanges++;
      firstSearch.set(key, value);
    }
  }
}
export function r2SearchEnd(start: ReturnType<typeof r2SearchStart>) {
  if (!start) {
    return;
  }
  const cpu = process.threadCpuUsage(start.cpu);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  const elapsedMs = performance.now() - start.at;
  search.executions++;
  search.cpuMs += cpuMs;
  search.elapsedMs += elapsedMs;
  search.filters.push({
    task: frame?.label,
    cpuMs,
    elapsedMs,
    matches: search.matches - start.matches,
    initialBuilds: search.initialBuilds - start.initial,
    repeatBuilds: search.repeatBuilds - start.repeat,
  });
}
export function r2PresentCalled() {
  if (detailed) {
    presentation.calls++;
  }
}
export function r2PresentMiss() {
  if (detailed) {
    presentation.misses++;
  }
}
export function r2Presentation<T extends object>(value: T): T {
  if (!detailed) {
    return value;
  }
  let id = objectIds.get(value);
  if (id === undefined) {
    id = ++nextObject;
    objectIds.set(value, id);
    returnedRefs.set(id, new WeakRef(value));
  }
  presentation.ids.add(id);
  if (consume !== undefined) {
    let ids = presentation.reads.get(consume);
    if (!ids) {
      presentation.reads.set(consume, (ids = new Set()));
    }
    ids.add(id);
    let reads = presentation.acrossReads.get(id);
    if (!reads) {
      presentation.acrossReads.set(id, (reads = new Set()));
    }
    reads.add(consume);
  }
  return value;
}
function differences(before: object, after: object, counts: Record<string, number>) {
  const a = before as Record<string, unknown>,
    b = after as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (Object.hasOwn(a, key) !== Object.hasOwn(b, key) || !isDeepStrictEqual(a[key], b[key])) {
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
}
export function r2Materialized(
  before: { materialized?: { row: object; source: object } },
  after: { materialized?: { row: object; source: object } },
) {
  if (!detailed) {
    return;
  }
  if (!before.materialized) {
    materialization.first++;
    return;
  }
  materialization.repeated++;
  if (before.materialized !== after.materialized) {
    materialization.materializedReplacements++;
  }
  if ((before as Record<string, unknown>).facts !== (after as Record<string, unknown>).facts) {
    materialization.factsReplacements++;
  }
  if (isDeepStrictEqual(before.materialized.row, after.materialized?.row)) {
    materialization.identicalRow++;
  }
  if (isDeepStrictEqual(before.materialized.source, after.materialized?.source)) {
    materialization.identicalSource++;
  }
  for (const key of Object.keys(after)) {
    if (
      !isDeepStrictEqual(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
      )
    ) {
      materialization.changedFields[key] = (materialization.changedFields[key] ?? 0) + 1;
    }
  }
  if (after.materialized) {
    differences(
      before.materialized.source,
      after.materialized.source,
      materialization.sourceChangedFields,
    );
    differences(before.materialized.row, after.materialized.row, materialization.rowChangedFields);
  }
}
function snapshot() {
  return {
    window,
    search: structuredClone(search),
    tasks: Object.fromEntries(
      [...tasks].map(([label, value]) => [label, { ...value, durations: [...value.durations] }]),
    ),
    presentation: {
      calls: presentation.calls,
      misses: presentation.misses,
      distinctObjects: presentation.ids.size,
      consumeReads: presentation.reads.size,
      distinctObjectsInConsume: new Set(
        Array.from(presentation.reads.values()).flatMap((ids) => Array.from(ids)),
      ).size,
      objectsSharedAcrossReads: [...presentation.acrossReads.values()].filter(
        (reads) => reads.size > 1,
      ).length,
      readObjectPairs: [...presentation.reads.values()].reduce((n, ids) => n + ids.size, 0),
    },
    materialization: structuredClone(materialization),
  };
}
Reflect.set(globalThis, "sessionRowChurnProbe", {
  begin(label: string, detail = false) {
    detailed = detail;
    window = label;
    tasks.clear();
    firstSearch.clear();
    search = {
      executions: 0,
      matches: 0,
      initialBuilds: 0,
      repeatBuilds: 0,
      staticFactChanges: 0,
      cpuMs: 0,
      elapsedMs: 0,
      filters: [],
    };
    presentation = {
      calls: 0,
      misses: 0,
      ids: new Set(),
      reads: new Map(),
      acrossReads: new Map(),
    };
    materialization = {
      first: 0,
      repeated: 0,
      identicalRow: 0,
      identicalSource: 0,
      materializedReplacements: 0,
      factsReplacements: 0,
      changedFields: {},
      sourceChangedFields: {},
      rowChangedFields: {},
    };
  },
  snapshot,
  live() {
    let alive = 0;
    for (const [id, ref] of returnedRefs) {
      if (ref.deref()) {
        alive++;
      } else {
        returnedRefs.delete(id);
      }
    }
    return { aliveReturnedObjects: alive, weakReferences: returnedRefs.size };
  },
});
