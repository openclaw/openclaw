// Client-owner proof only: no Gateway, SQLite database, filesystem, or network.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/control-ui-forbidden-diff-measure.ts
// --module selects the unchanged owner API from a baseline checkout; --allocations
// samples a separate pass whose instrumented timings must not be compared.
// Acceptance: 5,000 denied diff activations issue zero RPCs, with lower CPU and
// allocation. Five interleaved pairs plus A/A controls quantify host/JIT variance.
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GatewayBrowserClient, GatewayRequestError } from "../../ui/src/api/gateway.ts";
import type { GatewaySessionRow } from "../../ui/src/api/types.ts";
import { createSessionCapabilityFixture } from "../../ui/src/pages/chat/chat-session-capability.test-support.ts";
import type { ChatPageHost } from "../../ui/src/pages/chat/chat-state-host.ts";
import { selectedChatSessionRow } from "../../ui/src/pages/chat/chat-state-route.ts";
import type { resolveSessionWorkspaceDiff as ResolveDiff } from "../../ui/src/pages/chat/components/chat-session-workspace-diff.ts";
import type { SessionWorkspaceHost } from "../../ui/src/pages/chat/components/chat-session-workspace-types.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    module: {
      type: "string",
      default: "ui/src/pages/chat/components/chat-session-workspace-diff.ts",
    },
    activations: { type: "string", default: "5000" },
    rows: { type: "string", default: "5000" },
    allocations: { type: "boolean", default: false },
  },
});
const integer = (name: "activations" | "rows") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 5000 });
const activations = integer("activations");
assert(global.gc, "Run with --expose-gc");
// SAFETY: --module selects the same diff owner API from the baseline or candidate.
const { resolveSessionWorkspaceDiff } = (await import(
  pathToFileURL(path.resolve(values.module)).href
)) as {
  resolveSessionWorkspaceDiff: typeof ResolveDiff;
};
const reason = "Your operator role requires a sandboxed session.";
const rows: GatewaySessionRow[] = Array.from({ length: integer("rows") }, (_, index) => ({
  key: `agent:main:synthetic-${index}`,
  sessionId: `synthetic-${index}`,
  kind: "direct",
  updatedAt: 1,
  workspaceReadDisabledReason: reason,
}));
let requests = 0;
let unavailable = 0;
const client = new GatewayBrowserClient({ url: "ws://synthetic.invalid" });
client.request = async () => {
  requests++;
  throw new GatewayRequestError({ code: "FORBIDDEN", message: reason });
};
const sessions = createSessionCapabilityFixture();
const host: SessionWorkspaceHost & Pick<ChatPageHost, "sessionsResult"> = {
  sessionKey: rows.at(-1)!.key,
  sessions,
  sessionsResult: {
    ts: 1,
    path: "",
    count: rows.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: rows,
  },
  client,
  connected: true,
  connectionEpoch: 1,
  hello: {
    type: "hello-ok",
    protocol: 4,
    auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
    features: { methods: ["sessions.diff"] },
  },
  sidebarContent: null,
  handleOpenSidebar() {},
  get sessionWorkspaceReadDisabledReason() {
    return selectedRow()?.workspaceReadDisabledReason;
  },
};
function selectedRow() {
  // SAFETY: This synthetic non-global pane supplies every field read by the selector.
  return selectedChatSessionRow(host as ChatPageHost);
}
async function run(count: number) {
  for (let index = 0; index < count; index++) {
    // The pane already selects its row before either version resolves the diff.
    selectedRow();
    const content = resolveSessionWorkspaceDiff(
      host,
      () => undefined,
      async () => false,
    );
    if (content?.kind === "session-diff") {
      await content.load({ scope: "uncommitted" }, { summaryOnly: true }).catch(() => {});
    } else if (content?.kind === "unavailable") {
      unavailable++;
    }
  }
}
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((total, child) => total + allocated(child), 0);
}
const inspector = new Session();
try {
  await run(500);
  global.gc();
  await nextTurn();
  requests = unavailable = 0;
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const before = process.threadCpuUsage();
  const started = performance.now();
  await run(activations);
  const elapsedMs = performance.now() - started;
  const cpu = process.threadCpuUsage(before);
  const profile = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  console.log(
    JSON.stringify({
      module: values.module,
      mode: values.allocations ? "allocations" : "timing",
      activations,
      rows: rows.length,
      deniedRequests: requests,
      unavailable,
      elapsedMs,
      mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
      allocatedBytes: profile ? allocated(profile.head) : undefined,
      hostLoad: loadavg(),
      ...process.memoryUsage(),
    }),
  );
} finally {
  inspector.disconnect();
}
