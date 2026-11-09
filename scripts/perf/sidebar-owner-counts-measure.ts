/**
 * Compare client roster work with an observed versus absent sidebar owner-count query.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sidebar-owner-counts-measure.ts \
 *   --mode cpu --iterations 3000 --output .local/owner-counts-cpu.json
 * Repeat with --mode allocation for a separate Inspector allocation pass.
 *
 * ABBA order; 10,000 prepared synthetic rows, 60 held active rows. Each iteration
 * delivers one full lifecycle snapshot and advances virtual coordinator time by
 * six seconds. Both arms retain the same primary roster; initial hydration is
 * excluded. Mock RPCs return prepared results: this measures client owners, not
 * database/server work, network, serialization, rendering, or production rates.
 * Allocation sampling includes collected objects at a 16 KiB sampling interval.
 */
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { mock } from "node:test";
import { parseArgs } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayBrowserClient, type GatewayEventFrame } from "../../ui/src/api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../ui/src/api/types.ts";
import { createConnectionBootstrapCoordinator } from "../../ui/src/app/connection-bootstrap.ts";
import { SidebarOwnerSessionCounts } from "../../ui/src/components/sidebar-owner-session-counts.ts";
import { createSessionCapability } from "../../ui/src/lib/sessions/index.ts";
import type { SessionGateway } from "../../ui/src/lib/sessions/session-types.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "cpu" },
    iterations: { type: "string", default: "3000" },
    output: { type: "string" },
  },
});
const mode = values.mode;
const iterations = Number(values.iterations);
if (mode !== "cpu" && mode !== "allocation") {
  throw new Error("--mode must be cpu or allocation");
}
if (!Number.isSafeInteger(iterations) || iterations < 1) {
  throw new Error("--iterations must be a positive integer");
}

const initialNow = 1_800_000_000_000;
const rows: GatewaySessionRow[] = Array.from({ length: 10_000 }, (_, index) => ({
  key: `agent:main:synthetic-${index}`,
  agentId: "main",
  sessionId: `synthetic-${index}`,
  kind: "direct",
  label: `Synthetic session ${index}`,
  updatedAt: initialNow - index,
  snapshotAt: initialNow - index,
  status: "done",
  hasActiveRun: false,
  archived: index >= 60,
  createdActor: { type: "human", id: "viewer" },
  owner: {
    actor: { type: "human", id: "viewer", identity: { type: "profile", id: "viewer" } },
  },
}));
const list: SessionsListResult = {
  ts: initialNow,
  path: "(synthetic)",
  count: 60,
  defaults: { modelProvider: null, model: null, contextTokens: null },
  sessions: rows.slice(0, 60),
  hasMore: false,
  totalCount: 60,
};
const summary: SessionsListResult = {
  ...list,
  sessions: rows.slice(0, 1),
  hasMore: true,
  nextOffset: 1,
  ownerSessionCounts: [{ profileId: "viewer", open: 60, running: 0 }],
};

async function settle() {
  for (let turn = 0; turn < 32; turn++) {
    await Promise.resolve();
  }
}

async function run(active: boolean) {
  const eventListeners = new Set<(frame: GatewayEventFrame) => void>();
  let countsReads = 0;
  let primaryReads = 0;
  const transport = (method: string, params: unknown): unknown => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.groups.list") {
      return { groups: [], sectionOrder: [] };
    }
    if (method !== "sessions.list") {
      throw new Error(`Unexpected RPC ${method}`);
    }
    if (isRecord(params) && params.includeOwnerSessionCounts) {
      countsReads++;
      return summary;
    }
    primaryReads++;
    return list;
  };
  const client = new GatewayBrowserClient({ url: "ws://synthetic.invalid" });
  Object.defineProperties(client, {
    recoveryScope: { get: () => "synthetic-scope" },
    recoveryScopeReady: { get: () => true },
  });
  // This synthetic transport supplies the selected method's prepared response.
  client.request = async <T = unknown>(
    ...args: Parameters<GatewayBrowserClient["request"]>
  ): Promise<T> => transport(args[0], args[1]) as T;
  const gateway: SessionGateway = {
    snapshot: {
      client,
      phase: "connected",
      sessionKey: "agent:main:synthetic-0",
      assistantAgentId: "main",
      hello: null,
      selfUser: { id: "viewer" },
    },
    subscribe: () => () => {},
    subscribeEvents: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  };
  const sessions = createSessionCapability(gateway, {
    state: { selectedId: "main" },
    subscribe: () => () => {},
  });
  const bootstrap = createConnectionBootstrapCoordinator();
  const counts = new SidebarOwnerSessionCounts(() => {});
  const inspector = mode === "allocation" ? new Session() : null;
  try {
    await sessions.refresh({ agentId: "main", force: true });
    bootstrap.synchronize({ client, connected: true });
    if (active) {
      counts.synchronize(sessions, "viewer", bootstrap);
      await counts.refresh();
    }
    await settle();
    countsReads = primaryReads = 0;
    globalThis.gc?.();
    if (inspector) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 16_384,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const start = process.hrtime.bigint();
    const cpu = process.cpuUsage();
    for (let index = 0; index < iterations; index++) {
      const row = rows[index % 60]!;
      const running = Math.floor(index / 60) % 2 === 0;
      const updated: GatewaySessionRow = {
        ...row,
        updatedAt: Date.now(),
        snapshotAt: Date.now(),
        status: running ? "running" : "done",
        hasActiveRun: running,
      };
      const event: GatewayEventFrame = {
        type: "event",
        event: "sessions.changed",
        payload: {
          agentId: "main",
          key: row.key,
          reason: "lifecycle",
          session: updated,
          ancestorSessions: [],
          snapshotAt: Date.now(),
        },
      };
      for (const listener of eventListeners) {
        listener(event);
      }
      mock.timers.tick(6_000);
      await settle();
    }
    const cpuDelta = process.cpuUsage(cpu);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    let sampledAllocatedBytes: number | null = null;
    if (inspector) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      sampledAllocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    }
    return {
      active,
      mode,
      iterations,
      corpusRows: rows.length,
      heldRows: list.sessions.length,
      countsReads,
      primaryReads,
      cpuMs: (cpuDelta.user + cpuDelta.system) / 1_000,
      elapsedMs,
      sampledAllocatedBytes,
    };
  } finally {
    inspector?.disconnect();
    counts.dispose();
    sessions.dispose();
    bootstrap.reset();
  }
}

mock.timers.enable({ apis: ["Date", "setTimeout"], now: initialNow });
try {
  const results = [];
  for (const active of [true, false, false, true]) {
    results.push(await run(active));
  }
  const output = JSON.stringify({ mode, iterations, results }, null, 2);
  if (values.output) {
    writeFileSync(values.output, output + "\n");
  }
  console.log(output);
} finally {
  mock.timers.reset();
}
