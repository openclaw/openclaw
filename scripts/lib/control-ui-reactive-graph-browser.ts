// Imported only by the opt-in graph benchmark build, never by the application.
type Cause = { seq: number; nodeId?: number; name: string; causes?: Cause[] };
type Run = {
  nodeId: number;
  nodeName: string;
  nodeKind: "memo" | "effect";
  selfMs: number;
  changed?: boolean;
  phase: string;
  held: boolean;
  causes?: Cause[];
};
type LiveNode = { _loc?: string; _parent?: LiveNode | null };
type RecordMap = {
  create: Run;
  rerun: Run;
  effect: { nodeId: number; nodeName: string; durationMs: number };
};
type Observe = {
  ownerPath(node: LiveNode): string[] | undefined;
  records: {
    subscribe<K extends keyof RecordMap>(
      type: K,
      listener: (event: RecordMap[K], node: LiveNode) => void,
    ): () => void;
  };
};
type Attribution = {
  enable(options: { log: false; values: "none"; stacks: false; checks: false }): () => void;
};

export type ReactiveGraphScope = {
  name: string;
  source: string | null;
  ownerPath: string[];
  kind: "memo" | "effect";
  instances: number;
  executions: number;
  creations: number;
  reruns: number;
  unchanged: number;
  computeMs: number;
  unchangedMs: number;
  effectRuns: number;
  effectMs: number;
};

export type ReactiveGraphSummary = {
  label: string;
  elapsedMs: number;
  executions: number;
  creations: number;
  reruns: number;
  unchanged: number;
  computeMs: number;
  effectRuns: number;
  effectMs: number;
  scopes: ReactiveGraphScope[];
  writes: {
    name: string;
    nodeId: number | null;
    writes: number;
    downstreamRuns: number;
    readers: number;
    maxReadersPerWrite: number;
    computeMs: number;
  }[];
};

export type ReactiveGraphController = {
  start(label: string): void;
  snapshot(): ReactiveGraphSummary;
  stop(): ReactiveGraphSummary;
  dispose(): void;
};

export function installControlUiReactiveGraph(
  observe: Observe | undefined,
  attribution: Attribution,
): ReactiveGraphController {
  if (!observe) {
    throw new Error("Reactive graph counts require the Solid observe build");
  }
  let release = attribution.enable({ log: false, values: "none", stacks: false, checks: false });
  let active = false;
  let label = "";
  let started = 0;
  let elapsed = 0;
  const scopes = new Map<string, ReactiveGraphScope & { ids: Set<number> }>();
  const nodes = new Map<number, ReactiveGraphScope & { ids: Set<number> }>();
  const writes = new Map<
    string,
    {
      name: string;
      nodeId: number | null;
      runs: number;
      ms: number;
      readers: Set<number>;
      sequences: Map<number, Set<number>>;
    }
  >();

  function scope(event: Run | RecordMap["effect"], node: LiveNode) {
    const known = nodes.get(event.nodeId);
    if (known) {
      return known;
    }
    const ownerPath = observe!.ownerPath(node) ?? [];
    let source: string | null = null;
    let current: LiveNode | null | undefined = node;
    while (current) {
      const { _loc: location, _parent: parent }: LiveNode = current;
      if (location) {
        source = location;
        break;
      }
      current = parent;
    }
    const kind = "nodeKind" in event ? event.nodeKind : "effect";
    const key = JSON.stringify([kind, event.nodeName, source, ownerPath]);
    let entry = scopes.get(key);
    if (!entry) {
      entry = {
        name: event.nodeName,
        source,
        ownerPath,
        kind,
        ids: new Set(),
        instances: 0,
        executions: 0,
        creations: 0,
        reruns: 0,
        unchanged: 0,
        computeMs: 0,
        unchangedMs: 0,
        effectRuns: 0,
        effectMs: 0,
      };
      scopes.set(key, entry);
    }
    entry.ids.add(event.nodeId);
    entry.instances = entry.ids.size;
    nodes.set(event.nodeId, entry);
    return entry;
  }

  function record(event: Run, node: LiveNode, creation: boolean) {
    if (!active) {
      return;
    }
    const entry = scope(event, node);
    entry.executions++;
    entry.computeMs += event.selfMs;
    if (creation) {
      entry.creations++;
    } else {
      entry.reruns++;
      if (event.changed === false && event.phase === "plain" && !event.held) {
        entry.unchanged++;
        entry.unchangedMs += event.selfMs;
      }
    }
    const seen = new Set<number>();
    const causes = [...(event.causes ?? [])];
    for (const cause of causes) {
      if (seen.has(cause.seq)) {
        continue;
      }
      seen.add(cause.seq);
      if (cause.causes?.length) {
        causes.push(...cause.causes);
        continue;
      }
      const key = JSON.stringify([cause.nodeId ?? null, cause.name]);
      let write = writes.get(key);
      if (!write) {
        write = {
          name: cause.name,
          nodeId: cause.nodeId ?? null,
          runs: 0,
          ms: 0,
          readers: new Set(),
          sequences: new Map(),
        };
        writes.set(key, write);
      }
      let readers = write.sequences.get(cause.seq);
      if (!readers) {
        readers = new Set();
        write.sequences.set(cause.seq, readers);
      }
      readers.add(event.nodeId);
      write.readers.add(event.nodeId);
      write.runs++;
      write.ms += event.selfMs;
    }
  }

  const unsubscribe = [
    observe.records.subscribe("create", (event, node) => record(event, node, true)),
    observe.records.subscribe("rerun", (event, node) => record(event, node, false)),
    observe.records.subscribe("effect", (event, node) => {
      if (active) {
        const entry = scope(event, node);
        entry.effectRuns++;
        entry.effectMs += event.durationMs;
      }
    }),
  ];
  function snapshot(): ReactiveGraphSummary {
    const rows = [...scopes.values()].map(({ ids: _ids, ...row }) => row);
    const sum = (
      key:
        | "executions"
        | "creations"
        | "reruns"
        | "unchanged"
        | "computeMs"
        | "effectRuns"
        | "effectMs",
    ) => rows.reduce((total, row) => total + row[key], 0);
    return {
      label,
      elapsedMs: active ? performance.now() - started : elapsed,
      executions: sum("executions"),
      creations: sum("creations"),
      reruns: sum("reruns"),
      unchanged: sum("unchanged"),
      computeMs: sum("computeMs"),
      effectRuns: sum("effectRuns"),
      effectMs: sum("effectMs"),
      scopes: rows.toSorted((a, b) => b.unchanged - a.unchanged || b.computeMs - a.computeMs),
      writes: [...writes.values()]
        .map((write) => ({
          name: write.name,
          nodeId: write.nodeId,
          writes: write.sequences.size,
          downstreamRuns: write.runs,
          readers: write.readers.size,
          maxReadersPerWrite: Math.max(0, ...[...write.sequences.values()].map((set) => set.size)),
          computeMs: write.ms,
        }))
        .toSorted(
          (a, b) =>
            b.maxReadersPerWrite - a.maxReadersPerWrite || b.downstreamRuns - a.downstreamRuns,
        ),
    };
  }
  const controller: ReactiveGraphController = {
    start(nextLabel) {
      // A second hold resets the capture window without losing prior output facts.
      const nextRelease = attribution.enable({
        log: false,
        values: "none",
        stacks: false,
        checks: false,
      });
      release();
      release = nextRelease;
      scopes.clear();
      nodes.clear();
      writes.clear();
      label = nextLabel;
      started = performance.now();
      active = true;
    },
    snapshot,
    stop() {
      elapsed = performance.now() - started;
      active = false;
      return snapshot();
    },
    dispose() {
      active = false;
      unsubscribe.forEach((stop) => stop());
      release();
      scopes.clear();
      nodes.clear();
      writes.clear();
    },
  };
  return controller;
}
