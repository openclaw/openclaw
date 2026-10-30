// Team-shaped stress: prepare team-shape-fixture.ts --sessions 10000 --runs 8000
// --settled-runs, then run this script against the built Gateway with:
// --state-dir <fixture> --scenario memory-soak --clients 65 --runs 4 --plugins 40
// --stress-tools --row-mode sidebar --limit 200 --list-filter-churn
// --list-interval-ms 10000 --poll-seed team-stress --duration-ms 600000
// --soak-rounds 40 --warmup-ms 60000 --round-interval-ms 15000 --chunks 200
// --chunk-interval-ms 50 --retained-profile-ms 0 --diagnostics.
// Trace allocations in a separate pass with matching fixture treatment on both sides:
// either fresh fixtures or consistently warmed post-timing state.
// wholeSoakCpu includes idle gaps; listFilterCounts proves measured search coverage.
// Team fanout checks use continuous foreground receipts and committed injection IDs;
// timed event counts can split unrelated background broadcasts at window boundaries.
// --stress-worktree-fanout instead uses prepared fixture worktrees and retains reconnect/filter churn.
// Worker-churn load (isolated built Gateway; run baseline/candidate on fresh identical fixtures):
// node --import ./scripts/tsx.mjs scripts/perf/team-shape-fixture.ts --state-dir .local/worker-base \
//   --sessions 10000 --runs 6000 --settled-runs --projects 36 --transcript-mib 16 --port 41723
// node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
//   --state-dir .local/worker-base --entry dist/entry.js --port 41723 --mock-port 41724 \
//   --scenario memory-soak --runs 36 --clients 64 --plugins 40 --duration-ms 600000 \
//   --warmup-ms 10000 --round-interval-ms 15000 --list-interval-ms 5000 --poll-seed worker-churn --mixed-rpc \
//   --row-mode sidebar --stress-tools --stress-worktree-fanout --list-filter-churn \
//   --diagnostics --retained-profile-ms 0 --reset-every-rounds 0
// Keep timing/GC acceptance untraced. Repeat separately with --allocations or
// --workload-cpu-profile for allocation rate or Worker-constructor CPU attribution.
// --worker-creation-counts writes operation-labeled constructor timing in a separate count pass.
// For cold restores, prepare with worker-cold-fixture.ts and add --cold-history.
// Each cold session is read once before cycling back to already-restored transcripts.
// Fixed-work comparison: omit --poll-seed and use --soak-rounds 16,
// --round-interval-ms 37500 and --list-interval-ms 600000 (256 requests per RPC method).
// Setup can restore cold histories; report setup-inclusive worker/CPU totals too.
// --cold-idle-ms 310000 adds a quiet tail after the measured soak, then reads the
// last cold-summary key reserved from load. Use 257 cold keys for 256 load reads.
// The tail records worker lifetimes/heaps and the real history response separately
// from timing gates. Background usage refresh can warm the reserved key; this is
// a functional history-read check, not guaranteed cold-restoration proof.

// Stream custom syntax with --answer-chunk $'```json\n{"ok":true}\n```\nprose\n'.
// Add --final-answer-phase to exercise the visible projection during each delta.
// Add --list-filter-churn to --scenario memory-soak --mixed-rpc to rotate sidebar/search filters.
// --operator-access-policy --operator-access-policies 40 enables one identified operator
// and 40 policy plugins (one applicable retained grant). Combine memory-soak with
// --stress-tools --stress-subagents for native child authority. A separate counting
// pass can use --gateway-preload scripts/perf/plugin-access-authority-census.mjs.
// --auth-availability-storm requires the matching fixture flag; alternate primary HTTP 429/success
// through a real shared auth profile. Tool continuations stay successful. Writes mock counts even on failure.
// --gateway-preload <file> imports benchmark instrumentation after tsx for source or dist entries;
// result.json records its resolved path and SHA-256. Use the same instrumentation on both arms.
// --chat-active-after-tool with --chat-active-hold-ms waits for the first text delta
// after a committed tool result before sending queued/steering inputs. Requires --runs 1;
// the stream continues during admission and holds completion for the requested interval.
// --scenario chat.send --runs 20 --heap-snapshot captures active-<round>.heapsnapshot
// after all primary requests arrive and any pre-release steering hold finishes,
// before releasing their mock responses. Heap capture is diagnostic, not timing evidence.
// Heap captures use a 131072-character string limit; match the analyzer's --string-limit.
// --turn-start-phases also retains at most 100,000 raw reservation/worker observations
// in turn-start-timeline.json. Observed clocks precede batched IPC; completed reservation
// intervals can be reconstructed from elapsed/queue/execution times (rounded to ms).
// blocking* labels describe the holder seen at enqueue, not every preceding queued job.
// Add --worktree-tool-churn to memory-soak --stress-tools --mixed-rpc to give each
// foreground session its own managed worktree, read/grep its README, and cycle list searches.
// This mode keeps a fixed viewer set instead of adding reconnect churn.
// --stress-tool-search adds a verified catalog search before each --stress-tools execution.
// --stress-network-tool adds a verified loopback HTTP tool inside each Code Mode cell.
// Fixed N/2N retention usage: transcript-broadcast-run-retention.md.
// --poll-between-rounds keeps list/mixed-RPC polling active between memory-soak cohorts.
// On a fresh team-shape fixture, exercise sidebar/search and usage refresh with:
// node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
//   --state-dir <fixture> --entry dist/entry.js --scenario memory-soak \
//   --clients 64 --exact-clients 4 --runs 8 --plugins 40 --row-mode sidebar \
//   --chunks 500 --chunk-interval-ms 10 --warmup-ms 60000 --duration-ms 600000 \
//   --soak-rounds 40 --round-interval-ms 15000 --memory-interval-ms 15000 \
//   --retained-profile-ms 0 --stress-tools --mixed-rpc --dashboard-rpc \
//   --list-filter-churn --usage-rpc --list-interval-ms 1000 --poll-seed usage \
//   --diagnostics --port 41712 --mock-port 41714 --revision <sha>
// List churn rotates the existing filters and patches a label every tenth list.
// Usage polling adds usage.cost and sessions.usage overview reads to the
// mixed rotation; each round reports response cache statuses, including partials.
// Use separate matching --allocations passes; their traced GC timing is diagnostic.
// --worker-heap-done-file/--worker-heap-peer-done-file also gate paired timing soaks
// before post-window collection or teardown; give each arm fresh, distinct paths.
// --node-policy-churn adds a paired synthetic node and node list/describe/invoke traffic;
// use memory-soak --mixed-rpc --plugins 40 --list-interval-ms 500 for policy load.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createCipheriv, createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { HeapProfiler, Profiler } from "node:inspector";
import path from "node:path";
import { createHistogram } from "node:perf_hooks";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { Value } from "typebox/value";
import { z } from "zod";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import { rawDataToString } from "../../packages/gateway-client/src/websocket-data.ts";
import { HelloOkSchema } from "../../packages/gateway-protocol/src/schema/frames.ts";
import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/schema/sessions-patch.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { stripInboundMetadata } from "../../src/auto-reply/reply/strip-inbound-meta.js";
import { prepareSessionEventMetrics } from "../../src/gateway/session-event-metrics.js";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../../src/infra/ed25519-signature.js";
import { encodePngRgba } from "../../src/media/png-encode.js";
import { GatewaySessionRowEvents } from "../../ui/src/api/gateway-session-row-events.ts";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import {
  readMockUserText,
  summarizeMockInferenceRequest,
} from "../e2e/lib/mock-inference-facts.ts";
import { readBody } from "../e2e/lib/mock-openai-http.mjs";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { startGatewayBenchDiagnostics } from "../lib/gateway-bench-diagnostics.ts";
import {
  GATEWAY_PROFILE_CHANNEL,
  controlGatewayProfile,
  readGatewayCpuProfile,
  readGatewayHeapProfile,
  readGatewayGcTrace,
  readGatewayCpuUsage,
  startGatewayDiagnostics,
  readGatewayResources,
  measureGatewayCpuUsage,
  measureGatewayAllocations,
} from "../lib/gateway-bench-profile.ts";
import {
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  writePluginFixtures,
  writeGatewayAuthorityCountsPreload,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";
import { TEAM_STRESS_PLUGIN_IDS } from "./team-shape-stress-fixture.ts";
import { createTeamStressFanoutReceipts } from "./team-shape-stress-receipts.ts";
import { observeTurnStartReceipt, type TurnStartSample } from "./turn-start-report.ts";

const { values } = parseArgs({
  options: {
    // Cold-history worker-churn instrumentation and fixture workload.
    "cold-history": { type: "boolean", default: false },
    "cold-idle-ms": { type: "string" },
    "worker-creation-counts": { type: "boolean", default: false },
    "stress-worktree-fanout": { type: "boolean", default: false },
    "state-dir": { type: "string" },
    allocations: { type: "boolean", default: false },
    "worker-allocations": { type: "boolean", default: false },
    diagnostics: { type: "boolean", default: false },
    "broadcast-timing": { type: "boolean", default: false },
    "session-projection-counts": { type: "boolean", default: false },
    "session-projection-source": { type: "string" },
    "disable-inlining": { type: "boolean", default: false },
    "transport-counts": { type: "boolean", default: false },
    compressed: { type: "boolean", default: false },
    "distinct-viewers": { type: "boolean", default: false },
    "prep-trace": { type: "boolean", default: false },
    "cpu-profile": { type: "boolean", default: false },
    "workload-cpu-profile": { type: "boolean", default: false },
    "sqlite-reply-census": { type: "boolean", default: false },
    "capture-responses": { type: "boolean", default: false },
    "list-filter-churn": { type: "boolean", default: false },
    "trace-gc": { type: "boolean", default: false },
    "worker-memory": { type: "boolean", default: false },
    "worker-snapshots": { type: "boolean", default: false },
    "worker-retained-heap": { type: "boolean", default: false },
    "worker-heap-snapshot": { type: "boolean", default: false },
    "knowledge-worker-heap": { type: "boolean", default: false },
    "worker-heap-done-file": { type: "string" },
    "worker-heap-peer-done-file": { type: "string" },
    "worker-baseline-dir": { type: "string" },
    "baseline-owners": { type: "boolean", default: false },
    "stress-shell-words": { type: "string", default: "0" },
    "stress-tools": { type: "boolean", default: false },
    "exec-io-storm": { type: "boolean", default: false },
    "worktree-tool-churn": { type: "boolean", default: false },
    "stress-tool-search": { type: "boolean", default: false },
    "stress-network-tool": { type: "boolean", default: false },
    "attempt-setup-image": { type: "string" },
    "sandbox-image": { type: "string" },
    "cold-session-rounds": { type: "string", default: "0" },
    "turn-start-phases": { type: "boolean", default: false },
    "turn-start-rich-context": { type: "boolean", default: false },
    "turn-start-advance-origin": { type: "boolean", default: false },
    "git-trace": { type: "boolean", default: false },
    "provider-delay-ms": { type: "string", default: "0" },
    "stress-session-store": { type: "boolean", default: false },
    "transcript-hydration-counts": { type: "boolean", default: false },
    "operator-access-policy": { type: "boolean", default: false },
    "operator-access-policies": { type: "string", default: "1" },
    "session-event-wake": { type: "boolean", default: false },
    "cron-operator-turn": { type: "boolean", default: false },
    "authority-counts": { type: "boolean", default: false },
    "config-capture-counts": { type: "boolean", default: false },
    "config-capture-source": { type: "string" },
    "authority-source-preload": { type: "string" },
    "stress-subagents": { type: "boolean", default: false },
    "mixed-rpc": { type: "boolean", default: false },
    "poll-between-rounds": { type: "boolean", default: false },
    "usage-rpc": { type: "boolean", default: false },
    "node-policy-churn": { type: "boolean", default: false },
    "team-stress": { type: "boolean", default: false },
    "auth-availability-storm": { type: "boolean", default: false },
    "operator-model-policy": { type: "boolean", default: false },
    "team-stress-churn-ms": { type: "string", default: "1000" },
    "team-stress-list-weight": { type: "string", default: "2" },
    "team-stress-allocation-sampling": { type: "boolean", default: false },
    "team-stress-retention-sampling": { type: "boolean", default: false },
    "dashboard-rpc": { type: "boolean", default: false },
    "github-options-connected": { type: "boolean", default: false },
    "github-options-observe": { type: "boolean", default: false },
    "github-observation-owner": { type: "string" },
    "github-availability-owner": { type: "string" },
    "github-state-handlers": { type: "string" },
    "github-publication-reader": { type: "string" },
    "stream-start-diagnostics": { type: "boolean", default: false },
    "stream-start-allocations": { type: "boolean", default: false },
    "active-work-diagnostics": { type: "boolean", default: false },
    scenario: { type: "string", default: "transcript-broadcast" },
    "startup-temperature": { type: "string", default: "warm" },
    "startup-targets": { type: "string" },
    "startup-source-preload": { type: "string" },
    "gateway-preload": { type: "string" },
    revision: { type: "string" },
    operations: { type: "string" },
    "warmup-operations": { type: "string" },
    "heap-sampling-interval": { type: "string" },
    "rpc-concurrency": { type: "string", default: "1" },
    "reconnect-stagger-ms": { type: "string", default: "125" },
    limit: { type: "string", default: "100" },
    "row-mode": { type: "string", default: "compact" },
    entry: { type: "string", default: "dist/entry.js" },
    "default-state-dir": { type: "boolean", default: false },
    port: { type: "string", default: "41033" },
    "mock-port": { type: "string" },
    clients: { type: "string", default: "60" },
    "exact-clients": { type: "string" },
    "activity-summaries": { type: "boolean", default: false },
    "recap-burst-repeats": { type: "string", default: "0" },
    "recap-burst-interval-ms": { type: "string", default: "50" },
    runs: { type: "string" },
    sessions: { type: "string", default: "100" },
    plugins: { type: "string", default: "0" },
    "plugin-update": { type: "boolean", default: false },
    "history-turns": { type: "string", default: "0" },
    "history-last-turns": { type: "string", default: "0" },
    "history-payload-kib": { type: "string", default: "0" },
    "verify-history-replay": { type: "boolean", default: false },
    "seed-history": { type: "boolean", default: false },
    rounds: { type: "string", default: "5" },
    "duration-ms": { type: "string", default: "3600000" },
    "warmup-ms": { type: "string", default: "300000" },
    "round-interval-ms": { type: "string", default: "15000" },
    "rpc-interval-ms": { type: "string", default: "0" },
    "soak-rounds": { type: "string" },
    "memory-interval-ms": { type: "string", default: "60000" },
    "retained-profile-ms": { type: "string", default: "600000" },
    "reset-every-rounds": { type: "string", default: "20" },
    chunks: { type: "string", default: "100" },
    "answer-chunk": { type: "string", default: "Synthetic streamed answer. " },
    "final-answer-phase": { type: "boolean", default: false },
    "chunk-interval-ms": { type: "string", default: "10" },
    "prompt-kib": { type: "string", default: "128" },
    "chat-attachment-kib": { type: "string", default: "0" },
    "chat-active-hold-ms": { type: "string", default: "0" },
    "chat-active-after-tool": { type: "boolean", default: false },
    "heap-snapshot": { type: "boolean", default: false },
    "session-census": { type: "boolean", default: false },
    "fingerprint-retention": { type: "boolean", default: false },
    "session-row-deltas": { type: "boolean", default: false },
    "session-capability-clients": { type: "string" },
    "roster-body-optional-clients": { type: "string" },
    "session-event-ancestors": { type: "string" },
    "presence-deltas": { type: "boolean", default: false },
    "session-envelope-refs": { type: "boolean", default: false },
    "start-at": { type: "string" },
    "start-file": { type: "string" },
    "list-interval-ms": { type: "string", default: "0" },
    "list-profile-reference": { type: "string" },
    "poll-seed": { type: "string" },
  },
});
// Fixture fanout keeps the same continuous polling as the explicit pacing option.
const pollBetweenRounds =
  values["poll-between-rounds"] || values["stress-worktree-fanout"] || values["team-stress"];
if (!values["state-dir"]) {
  throw new Error("--state-dir is required (existing team-shape fixture)");
}
if (values["worker-heap-snapshot"] && !values["worker-retained-heap"]) {
  throw new Error("--worker-heap-snapshot requires --worker-retained-heap");
}
if (values["worker-baseline-dir"] && path.resolve(values.entry) !== path.resolve("src/entry.ts")) {
  throw new Error("--worker-baseline-dir requires --entry src/entry.ts");
}
if (
  (values["github-options-observe"] &&
    (!values["dashboard-rpc"] || path.resolve(values.entry) !== path.resolve("src/entry.ts"))) ||
  ((values["github-observation-owner"] ||
    values["github-availability-owner"] ||
    values["github-state-handlers"] ||
    values["github-publication-reader"]) &&
    !values["github-options-observe"])
) {
  throw new Error(
    "GitHub stage observation requires --dashboard-rpc --entry src/entry.ts --github-options-observe",
  );
}
const integer = (raw: string, label: string, min = 1) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const port = integer(values.port, "--port", 40000);
const mockPort = integer(
  values["mock-port"] ?? String(values["dashboard-rpc"] ? port + 2 : 41034),
  "--mock-port",
  40000,
);
if (port > 65535 || mockPort > 65535 || port === mockPort) {
  throw new Error("ports must be distinct and <= 65535");
}
if (values["dashboard-rpc"] && mockPort === port + 1) {
  throw new Error("Dashboard widgets reserve Gateway port + 1; choose a different --mock-port");
}
const scenario = values.scenario;
const pluginCount = integer(values.plugins, "--plugins", 0);
const operatorAccessPolicyCount = integer(
  values["operator-access-policies"],
  "--operator-access-policies",
);
if (operatorAccessPolicyCount !== 1 && !values["operator-access-policy"]) {
  throw new Error("--operator-access-policies requires --operator-access-policy");
}
if (values["team-stress"] && (pluginCount < 4 || pluginCount > TEAM_STRESS_PLUGIN_IDS.length)) {
  throw new Error(
    `--team-stress requires --plugins between 4 and ${TEAM_STRESS_PLUGIN_IDS.length}`,
  );
}
const teamPluginCatalog = values["team-stress"] || values["turn-start-phases"];
const syntheticPluginCount = teamPluginCatalog ? 0 : pluginCount;
const teamStressPlugins: string[] = TEAM_STRESS_PLUGIN_IDS.slice(0, pluginCount);
if (values["turn-start-rich-context"]) {
  if (!values["turn-start-phases"] || pluginCount < 5) {
    throw new Error("--turn-start-rich-context requires --turn-start-phases and --plugins >= 5");
  }
  teamStressPlugins[teamStressPlugins.length - 1] = "memory-core";
}
if (values["plugin-update"] && scenario !== "plugins.reload") {
  throw new Error("--plugin-update requires --scenario plugins.reload");
}
if (
  ![
    "sessions.list",
    "status",
    "health",
    "sessions.describe",
    "sessions.patch",
    "sessions.cleanup",
    "connect",
    "reconnect",
    "subscribe",
    "chat.send",
    "chat.startup",
    "transcript-broadcast",
    "attempt-retention",
    "session-idle-retention",
    "memory-soak",
    "plugins.reload",
    "plugin.scope",
    "cron.list",
    "board.get",
  ].includes(scenario)
) {
  throw new Error(
    "--scenario must be sessions.list, status, health, sessions.describe, sessions.patch, sessions.cleanup, connect, reconnect, subscribe, chat.send, chat.startup, transcript-broadcast, attempt-retention, session-idle-retention, memory-soak, plugins.reload, plugin.scope, cron.list, or board.get",
  );
}
const startupTemperature = values["startup-temperature"];
if (!["warm", "cold"].includes(startupTemperature)) {
  throw new Error("--startup-temperature must be warm or cold");
}
if (scenario !== "chat.startup" && (values["startup-targets"] || startupTemperature !== "warm")) {
  throw new Error("Startup workload options require --scenario chat.startup");
}
if (
  values["startup-source-preload"] &&
  (scenario !== "chat.startup" || path.resolve(values.entry) !== path.resolve("src/entry.ts"))
) {
  throw new Error("--startup-source-preload requires --scenario chat.startup --entry src/entry.ts");
}
const startupSourcePreload = values["startup-source-preload"]
  ? {
      path: realpathSync(path.resolve(values["startup-source-preload"])),
      sha256: createHash("sha256")
        .update(readFileSync(values["startup-source-preload"]))
        .digest("hex"),
    }
  : undefined;
const gatewayPreload = values["gateway-preload"]
  ? {
      path: realpathSync(path.resolve(values["gateway-preload"])),
      sha256: createHash("sha256").update(readFileSync(values["gateway-preload"])).digest("hex"),
    }
  : undefined;
const retentionScenario = scenario === "attempt-retention";
if (
  values["list-filter-churn"] &&
  scenario !== "sessions.list" &&
  scenario !== "memory-soak" &&
  !values["turn-start-phases"]
) {
  throw new Error("--list-filter-churn requires --scenario sessions.list or memory-soak");
}
const idleScenario = scenario === "session-idle-retention";
const soakScenario = scenario === "memory-soak";
if (values["node-policy-churn"] && (!soakScenario || !values["mixed-rpc"] || !pluginCount)) {
  throw new Error("--node-policy-churn requires memory-soak --mixed-rpc --plugins > 0");
}
const historyTurns = integer(values["history-turns"], "--history-turns", 0);
const historyLastTurns = integer(values["history-last-turns"], "--history-last-turns", 0);
const historyPayloadBytes =
  integer(values["history-payload-kib"], "--history-payload-kib", 0) * 1024;
const verifyHistoryReplay = values["verify-history-replay"];
if (
  (historyTurns || values["seed-history"]) &&
  !idleScenario &&
  !soakScenario &&
  !values["turn-start-phases"]
) {
  throw new Error(
    "--history-turns and --seed-history require session-idle-retention, memory-soak, or warm --turn-start-phases",
  );
}
if (values["seed-history"] && !historyTurns) {
  throw new Error("--seed-history requires --history-turns > 0");
}
if ((historyLastTurns || historyPayloadBytes) && !historyTurns) {
  throw new Error("--history-last-turns and --history-payload-kib require --history-turns");
}
if (verifyHistoryReplay && (!soakScenario || !historyTurns)) {
  throw new Error("--verify-history-replay requires memory-soak and --history-turns > 0");
}
if (verifyHistoryReplay && (historyLastTurns || historyPayloadBytes)) {
  throw new Error(
    "--verify-history-replay uses equal-length histories with two 4 KiB reasoning items per turn; omit --history-last-turns and --history-payload-kib",
  );
}
const proxyViewers = values.compressed || values["distinct-viewers"];
if (proxyViewers && values["operator-access-policy"]) {
  throw new Error("--compressed/--distinct-viewers cannot combine with --operator-access-policy");
}
if (
  proxyViewers &&
  ((scenario !== "transcript-broadcast" && scenario !== "memory-soak") || values["mixed-rpc"])
) {
  throw new Error(
    "--compressed/--distinct-viewers require transcript-broadcast or memory-soak without --mixed-rpc",
  );
}
const reasoningScenario = retentionScenario || idleScenario || soakScenario;
if (
  (values["session-census"] || values["fingerprint-retention"]) &&
  (!idleScenario || path.resolve(values.entry) !== path.resolve("src/entry.ts"))
) {
  throw new Error(
    "--session-census and --fingerprint-retention require --scenario session-idle-retention --entry src/entry.ts",
  );
}
const toolScenario = scenario === "chat.send" || reasoningScenario;
if (values["stress-tool-search"] && !values["stress-tools"]) {
  throw new Error("--stress-tool-search requires --stress-tools");
}
if (values["stress-network-tool"] && !values["stress-tools"]) {
  throw new Error("--stress-network-tool requires --stress-tools");
}
const chatActiveHoldMs = integer(values["chat-active-hold-ms"], "--chat-active-hold-ms", 0);
if (scenario === "chat.send" && values["heap-snapshot"] && values["turn-start-phases"]) {
  throw new Error("Active heap snapshots require the cohort barrier; omit --turn-start-phases");
}
if (
  chatActiveHoldMs &&
  (scenario !== "chat.send" || values["session-event-wake"] || values["cron-operator-turn"])
) {
  throw new Error("--chat-active-hold-ms requires direct --scenario chat.send");
}
const chatAttachmentBytes =
  integer(values["chat-attachment-kib"], "--chat-attachment-kib", 0) * 1024;
if (
  chatAttachmentBytes &&
  (scenario !== "chat.send" || values["session-event-wake"] || values["cron-operator-turn"])
) {
  throw new Error("--chat-attachment-kib requires direct --scenario chat.send");
}
const chatAttachmentContent = chatAttachmentBytes
  ? Buffer.alloc(chatAttachmentBytes, "Synthetic attachment text.\n").toString("base64")
  : undefined;
const turnScenario =
  scenario === "chat.send" ||
  scenario === "transcript-broadcast" ||
  retentionScenario ||
  idleScenario ||
  soakScenario;
if (
  !values.allocations &&
  !values["stream-start-allocations"] &&
  !values["workload-cpu-profile"] &&
  !values["operator-access-policy"] &&
  !values["config-capture-counts"] &&
  !values.diagnostics &&
  !(["sessions.list", "sessions.patch"].includes(scenario) && values["capture-responses"]) &&
  scenario !== "transcript-broadcast" &&
  scenario !== "plugin.scope" &&
  !retentionScenario &&
  !idleScenario &&
  !soakScenario
) {
  throw new Error(
    "--scenario requires --allocations, --workload-cpu-profile, --diagnostics, --config-capture-counts for chat.send, or --capture-responses for sessions.list/sessions.patch",
  );
}
const operations = integer(
  values.operations ??
    (scenario === "plugins.reload" ? "1" : scenario === "reconnect" ? values.clients : "100"),
  "--operations",
);
const warmupOperations = integer(
  values["warmup-operations"] ?? String(operations),
  "--warmup-operations",
);
if (values["warmup-operations"] !== undefined && turnScenario) {
  throw new Error("--warmup-operations requires an RPC scenario");
}
const heapSamplingIntervalBytes = values["heap-sampling-interval"]
  ? integer(values["heap-sampling-interval"], "--heap-sampling-interval")
  : undefined;
const limit = integer(values.limit, "--limit");
const rowMode = values["row-mode"];
if (!["compact", "sidebar", "dashboard"].includes(rowMode)) {
  throw new Error("--row-mode must be compact, sidebar, or dashboard");
}
const clientCount =
  (scenario === "chat.send" && !values["turn-start-phases"]) || idleScenario
    ? 1
    : integer(values.clients, "--clients");
const rpcConcurrency = integer(values["rpc-concurrency"], "--rpc-concurrency");
if (values["plugin-update"] && rpcConcurrency !== 1) {
  throw new Error("--plugin-update requires --rpc-concurrency 1");
}
if (rpcConcurrency > clientCount) {
  throw new Error("--rpc-concurrency must not exceed --clients");
}
const reconnectStaggerMs = integer(values["reconnect-stagger-ms"], "--reconnect-stagger-ms", 0);
const connectionScenario = scenario === "connect" || scenario === "reconnect";
if (
  scenario === "reconnect" &&
  (Math.min(operations, clientCount) - 1) * reconnectStaggerMs > 5000
) {
  throw new Error("reconnect storm starts must fit within 5000 ms; reduce --reconnect-stagger-ms");
}
const exactClients = integer(
  values["exact-clients"] ?? String(idleScenario ? 0 : clientCount),
  "--exact-clients",
  0,
);
if (exactClients > clientCount) {
  throw new Error("--exact-clients must not exceed --clients");
}
function parseCapabilityCounts(raw: string | undefined, label: string) {
  if (raw === undefined) {
    return undefined;
  }
  const counts = raw.split(",");
  if (counts.length !== 3 || counts.some((count) => !count.trim())) {
    throw new Error(`${label} requires three explicit counts`);
  }
  return counts.map((count) => integer(count, label, 0));
}
const sessionCapabilityCounts = parseCapabilityCounts(
  values["session-capability-clients"],
  "--session-capability-clients",
);
if (
  sessionCapabilityCounts &&
  (sessionCapabilityCounts.reduce((sum, count) => sum + count, 0) !== clientCount ||
    values["session-row-deltas"] ||
    values["session-envelope-refs"])
) {
  throw new Error(
    "--session-capability-clients requires legacy,delta,field-reference counts totaling --clients, without uniform session capability flags",
  );
}
const rosterBodyOptionalCounts = parseCapabilityCounts(
  values["roster-body-optional-clients"],
  "--roster-body-optional-clients",
);
if (
  rosterBodyOptionalCounts &&
  (!sessionCapabilityCounts ||
    rosterBodyOptionalCounts.some((count, index) => count > sessionCapabilityCounts[index]!))
) {
  throw new Error(
    "--roster-body-optional-clients requires --session-capability-clients and cannot exceed each cohort count",
  );
}
const sessionEventAncestors =
  values["session-event-ancestors"] === undefined
    ? undefined
    : integer(values["session-event-ancestors"], "--session-event-ancestors", 0);
if (
  sessionEventAncestors !== undefined &&
  (![0, 2].includes(sessionEventAncestors) ||
    !turnScenario ||
    historyTurns ||
    values["activity-summaries"])
) {
  throw new Error(
    "--session-event-ancestors requires 0 or 2 with fresh turn sessions, without history or activity summaries",
  );
}
const runCount = integer(values.runs ?? (scenario === "chat.send" ? "1" : "20"), "--runs");
if (values["chat-active-after-tool"] && (!chatActiveHoldMs || runCount !== 1)) {
  throw new Error("--chat-active-after-tool requires --chat-active-hold-ms and --runs 1");
}
const sessionCount = idleScenario ? integer(values.sessions, "--sessions") : runCount;
const historyBytesPerTurn = 16 * 1024;
const historyReasoningBytes = 4 * 1024;
function historyReasoningContent(index: number, turn: number, phase: "tool" | "answer") {
  return createCipheriv(
    "aes-256-ctr",
    createHash("sha256").update(`rs_soak_history_${index}_${turn}_${phase}`).digest(),
    Buffer.alloc(16),
  )
    .update(Buffer.alloc(historyReasoningBytes / 2))
    .toString("hex");
}
if (verifyHistoryReplay && historyTurns * sessionCount * historyBytesPerTurn > 1024 ** 3) {
  throw new Error("Memory-soak history must fit within the 1 GiB estimated seed budget");
}
if (
  idleScenario &&
  (exactClients ||
    values["activity-summaries"] ||
    values["cpu-profile"] ||
    values["stream-start-allocations"] ||
    values["stream-start-diagnostics"])
) {
  throw new Error(
    "session-idle-retention requires no exact subscriptions, activity summaries, or stream-start profiling",
  );
}
const rounds = integer(values.rounds, "--rounds");
const coldSessionRounds = integer(values["cold-session-rounds"], "--cold-session-rounds", 0);
if (
  (coldSessionRounds || values["attempt-setup-image"]) &&
  (scenario !== "chat.send" ||
    (values["stress-tools"] && !values["turn-start-phases"]) ||
    values["session-event-wake"] ||
    historyTurns)
) {
  throw new Error(
    "Attempt setup measurements require direct chat.send without stress tools or seeded history",
  );
}
if (coldSessionRounds > rounds) {
  throw new Error("--cold-session-rounds must not exceed --rounds");
}
const durationMs = integer(values["duration-ms"], "--duration-ms");
const warmupMs = integer(values["warmup-ms"], "--warmup-ms", 0);
const roundIntervalMs = integer(values["round-interval-ms"], "--round-interval-ms");
const rpcIntervalMs = integer(values["rpc-interval-ms"], "--rpc-interval-ms", 0);
const soakRounds =
  values["soak-rounds"] === undefined ? undefined : integer(values["soak-rounds"], "--soak-rounds");
if (soakRounds !== undefined && !soakScenario) {
  throw new Error("--soak-rounds requires --scenario memory-soak");
}
if (values["worker-allocations"] && (!soakScenario || !values.allocations)) {
  throw new Error("--worker-allocations requires memory-soak --allocations");
}
const memoryIntervalMs = integer(values["memory-interval-ms"], "--memory-interval-ms");
const retainedProfileMs = integer(values["retained-profile-ms"], "--retained-profile-ms", 0);
const resetEveryRounds = integer(values["reset-every-rounds"], "--reset-every-rounds", 0);
if (soakScenario && historyTurns && resetEveryRounds) {
  throw new Error("Seeded memory-soak histories require --reset-every-rounds 0");
}
if (
  soakScenario &&
  (values["stream-start-allocations"] ||
    (values.allocations && retainedProfileMs > 0) ||
    retainedProfileMs > durationMs)
) {
  throw new Error(
    "memory-soak requires --retained-profile-ms 0 for --allocations; retained capture must fit its duration and cannot overlap stream-start allocation capture",
  );
}
const chunkCount = integer(values.chunks, "--chunks");
const chunkIntervalMs = integer(values["chunk-interval-ms"], "--chunk-interval-ms", 0);
const providerDelayMs = integer(values["provider-delay-ms"], "--provider-delay-ms", 0);
if (values["turn-start-phases"] && scenario !== "chat.send") {
  throw new Error("--turn-start-phases requires --scenario chat.send");
}
if (values["turn-start-phases"] && (!values["stress-tools"] || exactClients < 2)) {
  throw new Error("--turn-start-phases requires --stress-tools and --exact-clients >= 2");
}
let measuredPhaseRound: number | undefined;
const turnStartPhases: Array<Record<string, unknown>> = [];
const turnStartSamples: TurnStartSample[] = [];
const turnStartTimeline: Array<Record<string, unknown>> = [];
let turnStartTimelineDropped = 0;
const turnStartTimelineLimit = 100_000;
const listIntervalMs = integer(values["list-interval-ms"], "--list-interval-ms", 0);
if (soakScenario && values["list-filter-churn"] && !listIntervalMs) {
  throw new Error("memory-soak --list-filter-churn requires --list-interval-ms");
}
if (connectionScenario && listIntervalMs) {
  throw new Error("connection scenarios use their own sidebar refresh; omit --list-interval-ms");
}
if (values["stress-tools"] && !toolScenario) {
  throw new Error(
    "--stress-tools requires chat.send, attempt-retention, session-idle-retention, or memory-soak",
  );
}
const stressShellWords = integer(values["stress-shell-words"], "--stress-shell-words", 0);
if (
  values["exec-io-storm"] &&
  (process.platform !== "linux" ||
    !values["team-stress"] ||
    !values["stress-tools"] ||
    !soakScenario ||
    values["sandbox-image"])
) {
  throw new Error(
    "--exec-io-storm requires Linux memory-soak --team-stress --stress-tools host exec",
  );
}
// At most 50,007 source characters and about 10,000 syntax nodes, below both parser limits.
if (stressShellWords > 10_000 || (stressShellWords > 0 && !values["stress-tools"])) {
  throw new Error("--stress-shell-words must be 0–10000 and requires --stress-tools when positive");
}
const stressShellCommand = stressShellWords ? `: ${"word ".repeat(stressShellWords)}; pwd` : "pwd";
if (
  values["stress-worktree-fanout"] &&
  (!soakScenario || !values["stress-tools"] || historyTurns)
) {
  throw new Error(
    "--stress-worktree-fanout requires memory-soak --stress-tools without seeded history",
  );
}
if (values["stress-worktree-fanout"] && values["worktree-tool-churn"]) {
  throw new Error("Choose fixture worktree fanout or managed worktree tool churn, not both");
}
if (values["stress-session-store"] && !values["stress-tools"]) {
  throw new Error("--stress-session-store requires --stress-tools");
}
if (
  values["worktree-tool-churn"] &&
  (!soakScenario || !values["stress-tools"] || !values["mixed-rpc"] || historyTurns > 0)
) {
  throw new Error(
    "--worktree-tool-churn requires memory-soak --stress-tools --mixed-rpc without seeded history",
  );
}
if (
  values["operator-access-policy"] &&
  ((scenario !== "chat.send" && !soakScenario) ||
    !values["stress-tools"] ||
    (!soakScenario && (runCount !== 1 || listIntervalMs !== 0)))
) {
  throw new Error(
    "--operator-access-policy requires --stress-tools and either memory-soak or chat.send with --runs 1 and no polling",
  );
}
if (values["session-event-wake"] && !values["operator-access-policy"]) {
  throw new Error("--session-event-wake requires --operator-access-policy");
}
if (
  values["config-capture-source"] &&
  path.resolve(values.entry) !== path.resolve("src/entry.ts")
) {
  throw new Error("--config-capture-source requires --entry src/entry.ts");
}
const configCaptureSource = values["config-capture-source"]
  ? Object.fromEntries(
      ["src/config/runtime-snapshot.ts", "src/acp/runtime/session-meta-read-context.ts"].map(
        (file) => {
          const source = readFileSync(path.resolve(values["config-capture-source"]!, file), "utf8");
          return [file, { source, sha256: createHash("sha256").update(source).digest("hex") }];
        },
      ),
    )
  : undefined;
if (
  values["config-capture-counts"] &&
  (scenario !== "chat.send" ||
    path.resolve(values.entry) !== path.resolve("src/entry.ts") ||
    values.allocations ||
    values.diagnostics ||
    values["trace-gc"] ||
    values["cpu-profile"] ||
    values["workload-cpu-profile"] ||
    values["stream-start-allocations"] ||
    values["stream-start-diagnostics"])
) {
  throw new Error(
    "--config-capture-counts requires --scenario chat.send --entry src/entry.ts in a separate counting pass without profiling or diagnostics",
  );
}
if (
  values["cron-operator-turn"] &&
  (!values["operator-access-policy"] ||
    values["session-event-wake"] ||
    sessionCount !== 1 ||
    resetEveryRounds !== 0)
) {
  throw new Error(
    "--cron-operator-turn requires --operator-access-policy --sessions 1 --reset-every-rounds 0 and no session-event wake",
  );
}
if (
  values["authority-counts"] &&
  (!values["operator-access-policy"] ||
    path.resolve(values.entry) !== path.resolve("src/entry.ts") ||
    values.allocations ||
    values.diagnostics ||
    values["trace-gc"] ||
    values["cpu-profile"] ||
    values["workload-cpu-profile"] ||
    values["stream-start-allocations"])
) {
  throw new Error(
    "--authority-counts requires --operator-access-policy --entry src/entry.ts in a separate pass without allocation, CPU, GC, or diagnostics profiling",
  );
}
if (
  values["authority-source-preload"] &&
  (!values["operator-access-policy"] || path.resolve(values.entry) !== path.resolve("src/entry.ts"))
) {
  throw new Error(
    "--authority-source-preload requires --operator-access-policy --entry src/entry.ts",
  );
}
let authoritySourcePreload: { path: string; sha256: string } | undefined;
if (values["authority-source-preload"]) {
  const preloadPath = path.resolve(values["authority-source-preload"]);
  try {
    authoritySourcePreload = {
      path: preloadPath,
      sha256: createHash("sha256").update(readFileSync(preloadPath)).digest("hex"),
    };
  } catch (cause) {
    throw new Error(`Cannot read --authority-source-preload: ${preloadPath}`, { cause });
  }
}
if (values["stress-subagents"] && (!soakScenario || !values["stress-tools"])) {
  throw new Error("--stress-subagents requires memory-soak and --stress-tools");
}
if (values["mixed-rpc"] && (!listIntervalMs || !turnScenario || clientCount < 4)) {
  throw new Error(
    "--mixed-rpc requires a turn scenario, --list-interval-ms, and at least four clients",
  );
}
if (
  values["poll-between-rounds"] &&
  ((!soakScenario && !values["turn-start-phases"]) || !listIntervalMs)
) {
  throw new Error("--poll-between-rounds requires memory-soak and --list-interval-ms");
}
const teamStressChurnMs = integer(values["team-stress-churn-ms"], "--team-stress-churn-ms");
const teamStressListWeight = integer(
  values["team-stress-list-weight"],
  "--team-stress-list-weight",
  1,
);
if (teamStressListWeight > 64) {
  throw new Error("--team-stress-list-weight must not exceed 64");
}
if (values["team-stress"] && (!soakScenario || !values["mixed-rpc"])) {
  throw new Error("--team-stress requires memory-soak and --mixed-rpc");
}
if (values["team-stress-retention-sampling"] && !values["team-stress-allocation-sampling"]) {
  throw new Error("--team-stress-retention-sampling requires --team-stress-allocation-sampling");
}
if (
  values["team-stress-allocation-sampling"] &&
  (!values["team-stress"] ||
    values.allocations ||
    values["stream-start-allocations"] ||
    retainedProfileMs > 0)
) {
  throw new Error(
    "--team-stress-allocation-sampling requires --team-stress and no other heap sampling (--retained-profile-ms 0)",
  );
}
if (values["dashboard-rpc"] && (!soakScenario || !values["mixed-rpc"])) {
  throw new Error("--dashboard-rpc requires memory-soak and --mixed-rpc");
}
if (values["usage-rpc"] && (!soakScenario || !values["mixed-rpc"])) {
  throw new Error("--usage-rpc requires memory-soak and --mixed-rpc");
}
if (values["github-options-connected"] && !values["dashboard-rpc"]) {
  throw new Error("--github-options-connected requires --dashboard-rpc");
}
if (values["github-options-connected"] && historyTurns) {
  throw new Error(
    "--github-options-connected requires fresh foreground sessions; omit --history-turns",
  );
}
const recapBurstRepeats = integer(values["recap-burst-repeats"], "--recap-burst-repeats", 0);
const recapBurstIntervalMs = integer(
  values["recap-burst-interval-ms"],
  "--recap-burst-interval-ms",
  0,
);
if (recapBurstRepeats > 100 || recapBurstIntervalMs > 1000) {
  throw new Error("recap burst limits are 100 repeats and a 1000 ms interval");
}
if (recapBurstRepeats && (!values["activity-summaries"] || !turnScenario)) {
  throw new Error("--recap-burst-repeats requires --activity-summaries and a turn scenario");
}
if ((values["cpu-profile"] || values["stream-start-diagnostics"]) && !turnScenario) {
  throw new Error("--cpu-profile and --stream-start-diagnostics require a turn scenario");
}
if (values["workload-cpu-profile"] && values["cpu-profile"]) {
  throw new Error("--workload-cpu-profile and --cpu-profile cannot capture CPU simultaneously");
}
if (
  values["sqlite-reply-census"] &&
  !values["workload-cpu-profile"] &&
  !values["cpu-profile"] &&
  !values.allocations &&
  !values["stream-start-allocations"]
) {
  throw new Error("--sqlite-reply-census requires a CPU or allocation profile window");
}
if (
  values["workload-cpu-profile"] &&
  (values.allocations ||
    values["trace-gc"] ||
    values["stream-start-allocations"] ||
    (soakScenario && retainedProfileMs > 0))
) {
  throw new Error(
    "--workload-cpu-profile needs a separate pass without --allocations, --trace-gc, --stream-start-allocations, or memory-soak retained heap capture (--retained-profile-ms 0)",
  );
}
if (values["stream-start-allocations"] && (!turnScenario || values.allocations)) {
  throw new Error("--stream-start-allocations requires a turn scenario without --allocations");
}
if (
  values["broadcast-timing"] &&
  (!values.diagnostics || path.resolve(values.entry) !== path.resolve("src/entry.ts"))
) {
  throw new Error("--broadcast-timing requires --diagnostics --entry src/entry.ts");
}
if (
  values["broadcast-timing"] &&
  (values.allocations ||
    values["stream-start-allocations"] ||
    (soakScenario && retainedProfileMs > 0))
) {
  throw new Error(
    "--broadcast-timing needs a separate pass without --allocations, --stream-start-allocations, or memory-soak retained heap capture (--retained-profile-ms 0)",
  );
}
if (
  values["session-projection-source"] &&
  path.resolve(values.entry) !== path.resolve("src/entry.ts")
) {
  throw new Error("--session-projection-source requires --entry src/entry.ts");
}
if (values["session-projection-counts"]) {
  if (path.resolve(values.entry) !== path.resolve("src/entry.ts")) {
    throw new Error("--session-projection-counts requires --entry src/entry.ts");
  }
  if (
    values.allocations ||
    values["worker-allocations"] ||
    values["cpu-profile"] ||
    values["workload-cpu-profile"] ||
    values["broadcast-timing"] ||
    values["transport-counts"] ||
    values["stream-start-allocations"] ||
    values["trace-gc"] ||
    (soakScenario && retainedProfileMs > 0)
  ) {
    throw new Error(
      "--session-projection-counts needs a separate pass without profiling or timing",
    );
  }
}
const sessionProjectionSource = values["session-projection-source"]
  ? realpathSync(path.resolve(values["session-projection-source"]))
  : undefined;
if (values["disable-inlining"] && !values.allocations) {
  throw new Error("--disable-inlining requires --allocations for a separate attribution capture");
}
if (values["poll-seed"] !== undefined && !listIntervalMs) {
  throw new Error("--poll-seed requires --list-interval-ms");
}
if (
  values["transport-counts"] &&
  (values.allocations ||
    values.diagnostics ||
    values["cpu-profile"] ||
    values["workload-cpu-profile"] ||
    values["stream-start-allocations"] ||
    values["stream-start-diagnostics"] ||
    values["active-work-diagnostics"] ||
    values["trace-gc"] ||
    soakScenario)
) {
  throw new Error("--transport-counts needs a separate pass without profiling or diagnostics");
}
const recordListRequests =
  values.diagnostics ||
  values["dashboard-rpc"] ||
  values["stream-start-diagnostics"] ||
  values["cpu-profile"] ||
  values["poll-seed"] !== undefined;
let startAt = values["start-at"] ? integer(values["start-at"], "--start-at") : undefined;
if (startAt !== undefined && values["start-file"]) {
  throw new Error("Use only one of --start-at and --start-file");
}
if (values["worker-snapshots"] && !values["worker-memory"]) {
  throw new Error("--worker-snapshots requires --worker-memory; use a separate diagnostic pass");
}
if (values["session-envelope-refs"] && !values["session-row-deltas"]) {
  throw new Error("--session-envelope-refs requires --session-row-deltas");
}
const promptBytes = integer(values["prompt-kib"], "--prompt-kib") * 1024;
const promptContent = createCipheriv(
  "aes-256-ctr",
  createHash("sha256").update("attempt-retention-967").digest(),
  Buffer.alloc(16),
);
const root = path.resolve(values["state-dir"]);
if (
  (process.env.OPENCLAW_PERF_MEDIA_IO === "1" ||
    process.env.OPENCLAW_PERF_FSYNC_DELAY_MS !== undefined) &&
  path.resolve(values.entry) !== path.resolve("scripts/perf/fsync-gateway-entry.ts")
) {
  throw new Error("Filesystem probe settings require --entry scripts/perf/fsync-gateway-entry.ts");
}
const fixture: unknown = JSON.parse(
  readFileSync(path.join(root, "team-shape-summary.json"), "utf8"),
);
if (!isRecord(fixture) || fixture.format !== "openclaw-team-shape-v1") {
  throw new Error("--state-dir must contain a generated team-shape fixture");
}
if (values["github-options-connected"] && fixture.githubOptionsConnected !== true) {
  throw new Error("Regenerate this fixture with --github-options-connected before measurement");
}
const output = path.join(root, `broadcast-measure-${Date.now()}`);
mkdirSync(output);
type WorkerHeapEvidence = {
  prefix: string;
  script: string;
  threadId: number;
  before?: Record<string, unknown>;
  start?: Record<string, unknown>;
  stop?: Record<string, unknown>;
  after?: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
};
const workerHeapEvidence = {
  complete: true,
  acceptanceTiming:
    !values.allocations &&
    !values["stream-start-allocations"] &&
    !values["worker-snapshots"] &&
    !idleScenario &&
    (!soakScenario || retainedProfileMs === 0),
  errors: [] as string[],
  workers: [] as WorkerHeapEvidence[],
};
const workerHeapDoneFile = values["worker-heap-done-file"];
const workerHeapPeerDoneFile = values["worker-heap-peer-done-file"];
if (
  Boolean(workerHeapDoneFile) !== Boolean(workerHeapPeerDoneFile) ||
  (workerHeapDoneFile &&
    (scenario !== "memory-soak" ||
      values["fingerprint-retention"] ||
      !workerHeapEvidence.acceptanceTiming))
) {
  throw new Error(
    "Measurement pair markers require both paths and a timing-compatible memory soak without fingerprint retention",
  );
}
if (
  workerHeapDoneFile &&
  workerHeapPeerDoneFile &&
  path.resolve(workerHeapDoneFile) === path.resolve(workerHeapPeerDoneFile)
) {
  throw new Error("Worker heap pair markers must use distinct paths");
}
async function workerHeapCommand(worker: WorkerHeapEvidence, operation: string) {
  const id = `${operation}-${randomUUID()}`;
  const commandPath = `${worker.prefix}.command.json`;
  const replyPath = `${worker.prefix}.${id}.json`;
  try {
    writeFileSync(`${commandPath}.tmp`, JSON.stringify({ id, operation }));
    renameSync(`${commandPath}.tmp`, commandPath);
    const deadline = Date.now() + (operation === "snapshot" ? 120_000 : 30_000);
    while (!existsSync(replyPath) && Date.now() < deadline) {
      await delay(25);
    }
    const reply: unknown = JSON.parse(readFileSync(replyPath, "utf8"));
    if (!isRecord(reply) || reply.ok !== true || reply.complete === false) {
      throw new Error(`Worker heap ${operation} failed: ${JSON.stringify(reply)}`);
    }
    return reply;
  } catch (error) {
    const message = `${worker.script}/${worker.threadId} ${operation}: ${String(error)}`;
    workerHeapEvidence.complete = false;
    workerHeapEvidence.errors.push(message);
    return { ok: false, error: message };
  }
}
const targetWorkerScript = (script: string) =>
  /^(?:(sqlite-store|prepared-model-catalog|git-operation|openclaw-state-read|session-accessor\.sqlite-archive)\.worker|storage-worker)\.[cm]?[jt]s$/.test(
    script,
  );
const project = Array.isArray(fixture.projectWorktrees) ? fixture.projectWorktrees[0] : undefined;
const coldBaseRefs =
  isRecord(project) && Array.isArray(project.coldBaseRefs)
    ? project.coldBaseRefs.filter((ref: unknown): ref is string => typeof ref === "string")
    : [];
if (values["attempt-setup-image"] && coldBaseRefs.length < coldSessionRounds * runCount) {
  throw new Error(
    "Regenerate the fixture with --worktree-cold-commits >= cold-session-rounds * runs",
  );
}
const fixtureSessionCount = typeof fixture.sessionCount === "number" ? fixture.sessionCount : 0;
const teamStressTargets =
  teamPluginCatalog && Array.isArray(fixture.stressTargets)
    ? fixture.stressTargets.map((target: unknown) => {
        if (
          !isRecord(target) ||
          typeof target.sessionKey !== "string" ||
          typeof target.agentId !== "string"
        ) {
          throw new Error("Team stress targets require sessionKey and agentId");
        }
        return { sessionKey: target.sessionKey, agentId: target.agentId };
      })
    : [];
if (values["team-stress"] && teamStressTargets.length === 0) {
  throw new Error("--team-stress requires unarchived fixture targets");
}
const teamStressFanout = values["team-stress"]
  ? createTeamStressFanoutReceipts(
      clientCount,
      teamStressTargets.map((target) => target.sessionKey),
    )
  : undefined;
type StartupTarget = {
  sessionKey: string;
  shortId?: string;
  minimumMessages?: number;
  minimumPendingInputs?: number;
  requireMetadata?: boolean;
};
const startupTargets: StartupTarget[] = [];
if (scenario === "chat.startup") {
  const rawTargets: unknown = values["startup-targets"]
    ? JSON.parse(readFileSync(values["startup-targets"], "utf8"))
    : Array.isArray(fixture.chatStartupTargets)
      ? fixture.chatStartupTargets.slice(
          0,
          startupTemperature === "cold" ? operations * rounds : runCount,
        )
      : Array.from(
          { length: startupTemperature === "cold" ? operations * rounds : runCount },
          (_, index) => ({ sessionKey: `agent:main:team-shape-session-${index}` }),
        );
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
    throw new Error(
      "--startup-targets must contain a nonempty array of prepared synthetic targets",
    );
  }
  for (const target of rawTargets) {
    if (
      !isRecord(target) ||
      typeof target.sessionKey !== "string" ||
      !target.sessionKey.startsWith("agent:main:") ||
      (target.requireMetadata !== undefined && typeof target.requireMetadata !== "boolean") ||
      (target.shortId !== undefined &&
        (typeof target.shortId !== "string" || !/^[a-f0-9]{8,32}$/i.test(target.shortId))) ||
      [target.minimumMessages, target.minimumPendingInputs].some(
        (count) => count !== undefined && (!Number.isSafeInteger(count) || Number(count) < 0),
      )
    ) {
      throw new Error(
        "Invalid startup target: expected a main-agent key and optional read assertions",
      );
    }
    startupTargets.push({
      sessionKey: target.sessionKey,
      requireMetadata: target.requireMetadata === true,
      ...(typeof target.shortId === "string" ? { shortId: target.shortId } : {}),
      ...(target.minimumMessages !== undefined
        ? { minimumMessages: Number(target.minimumMessages) }
        : {}),
      ...(target.minimumPendingInputs !== undefined
        ? { minimumPendingInputs: Number(target.minimumPendingInputs) }
        : {}),
    });
  }
  if (!values["startup-targets"] && startupTargets.length > fixtureSessionCount) {
    throw new Error("chat.startup needs more retained fixture sessions; regenerate the fixture");
  }
  if (
    startupTemperature === "cold" &&
    (startupTargets.length < operations * rounds ||
      new Set(startupTargets.map((target) => target.sessionKey)).size !== startupTargets.length)
  ) {
    throw new Error(
      "Cold chat.startup requires one distinct untouched target per measured operation",
    );
  }
}
const patchKeys =
  scenario === "sessions.patch"
    ? Array.from({ length: fixtureSessionCount }, (_, index) => index)
        .filter((index) => index % 5 !== 0)
        .slice(0, clientCount)
        .map((index) => `agent:main:team-shape-session-${index}`)
    : [];
if (scenario === "sessions.patch" && patchKeys.length !== clientCount) {
  throw new Error("sessions.patch requires one unarchived fixture session per client");
}
const patchSequences = patchKeys.map(() => 0);
if (values["mixed-rpc"] && fixtureSessionCount < 1) {
  throw new Error("--mixed-rpc requires retained fixture sessions for chat.history");
}
const coldHistoryKeys: string[] = values["cold-history"]
  ? JSON.parse(readFileSync(path.join(root, "worker-cold-summary.json"), "utf8")).sessionKeys
  : [];
if (values["cold-history"] && (!values["mixed-rpc"] || !coldHistoryKeys.length)) {
  throw new Error("--cold-history requires --mixed-rpc and a prepared worker-cold fixture");
}
const coldIdleMs =
  values["cold-idle-ms"] === undefined
    ? undefined
    : integer(values["cold-idle-ms"], "--cold-idle-ms", 300_000);
if (
  coldIdleMs !== undefined &&
  (!soakScenario || !values["cold-history"] || coldHistoryKeys.length < 2)
) {
  throw new Error("--cold-idle-ms requires memory-soak --cold-history with at least two cold keys");
}
const coldIdleKey = coldIdleMs === undefined ? undefined : coldHistoryKeys.pop();
let coldHistorySequence = 0;
let stressWorktree: string | undefined;
const worktreeToolRoots = new Map<number, string>();
const worktreeToolSearches = new Map<string, number>();
let diffControlOriginal: string | undefined;
if (
  values["stress-tools"] ||
  values["mixed-rpc"] ||
  values["attempt-setup-image"] ||
  values["turn-start-phases"]
) {
  if (!isRecord(project) || typeof project.path !== "string") {
    throw new Error("stress tools and mixed RPCs require a fixture generated with --projects >= 1");
  }
  stressWorktree = realpathSync(project.path);
  if (
    !stressWorktree.startsWith(`${realpathSync(root)}${path.sep}`) ||
    !readFileSync(path.join(stressWorktree, ".git"), "utf8").startsWith("gitdir: ")
  ) {
    throw new Error("stress worktree must be a real linked worktree inside the synthetic fixture");
  }
  if (values["mixed-rpc"]) {
    diffControlOriginal = readFileSync(path.join(stressWorktree, "README.md"), "utf8");
  }
}
if (values["stress-worktree-fanout"]) {
  const projects: unknown[] = Array.isArray(fixture.projectWorktrees)
    ? fixture.projectWorktrees
    : [];
  if (projects.length < sessionCount) {
    throw new Error("--stress-worktree-fanout requires one fixture project per active session");
  }
  for (const entry of projects.slice(0, sessionCount)) {
    if (!isRecord(entry) || typeof entry.path !== "string") {
      throw new Error("Invalid synthetic worktree fixture");
    }
    const worktree = realpathSync(entry.path);
    if (
      !worktree.startsWith(`${realpathSync(root)}${path.sep}`) ||
      !readFileSync(path.join(worktree, ".git"), "utf8").startsWith("gitdir: ") ||
      [...worktreeToolRoots.values()].includes(worktree)
    ) {
      throw new Error("Stress sessions require distinct linked worktrees inside the fixture");
    }
    worktreeToolRoots.set(worktreeToolRoots.size + 1, worktree);
  }
}
const viewerOrigin = "https://broadcast-measure.example.invalid";
const viewerIdentity = (index: number) =>
  `broadcast-viewer-${values["distinct-viewers"] ? index : 0}@example.invalid`;
const viewerProfiles = new Set<string>();
const cfg = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
if (sessionEventAncestors !== undefined) {
  // Explicit fixture lineage must not acquire sessions.create's implicit main-session parent.
  cfg.session = { ...cfg.session, dmScope: "per-channel-peer" };
}
if (scenario === "sessions.cleanup") {
  // Exercise live preservation admission repeatedly without consuming the fixture inventory.
  cfg.session = {
    ...cfg.session,
    maintenance: { ...cfg.session?.maintenance, mode: "warn" },
  };
}
applyMockOpenAiModelConfig(cfg, {
  mockPort,
  modelRef: "openai/gpt-4.1",
  ...(scenario === "sessions.patch" ? { utilityModelRef: "openai/gpt-4.1-mini" } : {}),
});
if (values["auth-availability-storm"]) {
  cfg.models.providers.openai.apiKey = "openai:auth-availability-storm";
}
if (verifyHistoryReplay) {
  for (const model of cfg.models.providers.openai.models) {
    // The synthetic provider must fit the seed plus turns accumulated across restarts.
    model.contextWindow = 2_097_152;
    model.contextTokens = 2_000_000;
  }
}
if (proxyViewers) {
  const identities = Array.from(
    { length: values["distinct-viewers"] ? clientCount : 1 },
    (_, index) => viewerIdentity(index),
  );
  const scopes = ["operator.admin", "operator.read", "operator.write"];
  cfg.gateway = {
    ...cfg.gateway,
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowUsers: identities,
        allowLoopback: true,
      },
      identityScopes: Object.fromEntries(identities.map((identity) => [identity, scopes])),
    },
    trustedProxies: ["127.0.0.1", "::1"],
    controlUi: { enabled: false, allowedOrigins: [viewerOrigin] },
    roles: {
      default: "administrator",
      definitions: { administrator: { agents: "*", sessions: { others: "write" }, scopes } },
    },
  };
}
cfg.agents.defaults = {
  ...cfg.agents.defaults,
  maxConcurrent: runCount,
  subagents: { ...cfg.agents.defaults.subagents, maxConcurrent: runCount },
  skipBootstrap: true,
};
cfg.memory = { ...cfg.memory, search: { enabled: false } };
cfg.tools = {
  codeMode: values["stress-tools"],
  ...(values["stress-tools"] ? { exec: { host: "gateway", mode: "full" } } : {}),
};
if (values["sandbox-image"]) {
  if (!values["turn-start-phases"] || values["attempt-setup-image"]) {
    throw new Error("--sandbox-image requires --turn-start-phases without --attempt-setup-image");
  }
  cfg.tools.exec = { host: "sandbox", mode: "full" };
  cfg.tools.sandbox = { tools: { allow: ["*"] } };
  cfg.agents.defaults.sandbox = {
    mode: "all",
    backend: "docker",
    scope: "session",
    workspaceAccess: "rw",
    workspaceRoot: path.join(root, "sandboxes"),
    docker: {
      image: values["sandbox-image"],
      containerPrefix: `bench-turn-${port}-`,
      network: "none",
      cpus: 1,
      memory: "512m",
    },
  };
}
if (values["cron-operator-turn"]) {
  cfg.cron = { ...cfg.cron, enabled: true };
}
if (stressWorktree) {
  cfg.agents.entries.main.workspace = stressWorktree;
}
if (scenario !== "plugins.reload") {
  cfg.plugins = {
    ...cfg.plugins,
    entries: {
      ...cfg.plugins?.entries,
      "memory-core": { config: { dreaming: { enabled: false } } },
    },
  };
}
if (values["active-work-diagnostics"]) {
  if (scenario !== "transcript-broadcast") {
    throw new Error("--active-work-diagnostics requires --scenario transcript-broadcast");
  }
  cfg.diagnostics = { ...cfg.diagnostics, enabled: true };
  cfg.plugins.entries["diagnostics-prometheus"] = { enabled: true };
}
if (scenario === "chat.startup") {
  cfg.diagnostics = { ...cfg.diagnostics, enabled: true };
}
if (soakScenario) {
  cfg.diagnostics = { ...cfg.diagnostics, enabled: true };
  if (cfg.plugins.allow?.length) {
    cfg.plugins.allow = [...new Set([...cfg.plugins.allow, "diagnostics-prometheus"])];
  }
  cfg.plugins.entries["diagnostics-prometheus"] = { enabled: true };
  if (values["stress-tools"]) {
    cfg.cron = { ...cfg.cron, enabled: true };
  }
}
if (teamPluginCatalog) {
  const bundled = teamStressPlugins;
  cfg.plugins.enabled = true;
  cfg.plugins.allow = [...new Set([...(cfg.plugins.allow ?? []), ...bundled])];
  for (const id of bundled) {
    cfg.plugins.entries[id] = { ...cfg.plugins.entries[id], enabled: true };
  }
}
let knowledgeRoot: string | undefined;
let knowledgeRevision = 0;
const knowledgeLatencies: number[] = [];
const writeKnowledgeRecord = (index: number) => {
  const title = `Synthetic person ${index}`;
  const body =
    `# ${title}\n\n[[Synthetic person ${(index + 1) % 256}]]\n\n` +
    `Synthetic knowledge paragraph ${index} revision ${knowledgeRevision}.\n\n`.repeat(300);
  writeFileSync(
    path.join(knowledgeRoot!, `person-${index}.md`),
    `---\nformat: knowledge-record-v1\nid: synthetic_person_${index}\nrevision: ${knowledgeRevision + 1}\nkind: page\ntitle: ${title}\nscope:\n  visibility: private\nrecorded_at: 2026-10-01T00:00:00Z\nupdated_at: 2026-10-01T00:00:00Z\nlifecycle: active\ntype: person\n---\n${body}`,
  );
};
if (values["knowledge-worker-heap"]) {
  const { StoreRegistry } = await import("../../extensions/knowledge/src/store-registry.ts");
  const registry = new StoreRegistry(path.join(root, "knowledge"));
  try {
    const snapshot = registry.provision("agent:main");
    knowledgeRoot = path.join(
      snapshot.stores[snapshot.bindings["agent:main"]!]!.root,
      "private",
      "people",
    );
    mkdirSync(knowledgeRoot, { recursive: true });
    for (let index = 0; index < 256; index++) {
      writeKnowledgeRecord(index);
    }
  } finally {
    registry.close();
  }
  cfg.plugins.enabled = true;
  cfg.plugins.allow = [...new Set([...(cfg.plugins.allow ?? []), "knowledge"])];
  cfg.plugins.slots = { ...cfg.plugins.slots, memory: "knowledge" };
  cfg.plugins.entries.knowledge = { enabled: true, config: { writesEnabled: false } };
}
if (values["turn-start-rich-context"]) {
  cfg.plugins.slots = { ...cfg.plugins.slots, memory: "memory-core" };
  cfg.mcp = {
    servers: Object.fromEntries(
      ["context_a", "context_b"].map((name) => [
        name,
        {
          transport: "streamable-http",
          url: `http://127.0.0.1:${mockPort}/mcp/${name}`,
          enabled: true,
        },
      ]),
    ),
  };
}
const dashboardBoardId = "synthetic-soak-board";
const dashboardPreviewUrl = "https://github.com/openclaw-fixture/soak/issues/1";
const dashboardPreviewTitle = "Synthetic dashboard issue";
let dashboardFixtureRequests = 0;
const githubStages: Array<{
  request: number;
  phase: string;
  startedAtEpochMs: number;
  durationMs: number;
}> = [];
let githubObservationOwner: { path: string; override: boolean } | undefined;
let githubAvailabilityOwner: { path: string; override: boolean } | undefined;
type GitHubFixtureRequest = {
  phase: "setup/preflight" | "measurement" | "outside-measurement";
  route: string;
  sequence: number;
  startedAtEpochMs: number;
  durationMs: number;
  delayMs: number;
  status: number;
  accountRevision?: number;
};
const githubFixtureRequests: GitHubFixtureRequest[] = [];
const githubOptionsObservations: Array<{
  phase: GitHubFixtureRequest["phase"];
  sessionKey: string;
  startedAtEpochMs: number;
  durationMs: number;
  stale: boolean;
  login: string;
}> = [];
const dashboardPreload = path.join(output, "dashboard-preload.mjs");
const startupObserverPreload = path.join(output, "startup-observer-preload.mjs");
const teamStressPreload = path.join(output, "team-stress-preload.mjs");
const turnStartPreload = path.join(output, "turn-start-preload.mjs");
if (values["turn-start-phases"]) {
  writeFileSync(
    turnStartPreload,
    `import { isMainThread } from "node:worker_threads";
import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { onTrustedInternalDiagnosticEvent } from ${JSON.stringify(new URL("../../src/infra/diagnostic-events.ts", import.meta.url).href)};
import { onWorkerRequestMetrics } from ${JSON.stringify(new URL("../../src/infra/worker-request-diagnostics.ts", import.meta.url).href)};
if (isMainThread) {
  const limit = ${turnStartTimelineLimit};
  let captured = 0, dropped = 0, stopped = false, pending = [];
  const observe = (source, fields) => {
    if (stopped) return;
    if (captured >= limit) { dropped++; return; }
    pending.push({ sequence: captured++, source, observedAtEpochMs: Date.now(),
      observedAtMonotonicMs: performance.now(), ...fields });
  };
  const numbers = (source, keys) => Object.fromEntries(keys.flatMap(key =>
    typeof source?.[key] === "number" && Number.isFinite(source[key]) && source[key] >= 0
      ? [[key, source[key]]] : []));
  const label = value => typeof value === "string" && /^[a-zA-Z0-9_.-]{1,160}$/.test(value)
    ? value : undefined;
  const labels = values => Array.isArray(values) ? values.map(label).filter(Boolean).slice(0, 8) : undefined;
  const flush = () => {
    if (!process.connected) return;
    const batch = pending;
    pending = [];
    for (let at = 0; at < batch.length; at += 256) {
      process.send?.({ turnStartTimelineBatch: batch.slice(at, at + 256), dropped });
    }
  };
  const reservation = channel("openclaw.agent-database.reservation");
  const onReservation = event => observe("reservation", {
    operation: label(event.operation), caller: label(event.caller), outcome: label(event.outcome),
    workerOperations: labels(event.workerOperations), blockingOperation: label(event.blockingOperation),
    blockingCaller: label(event.blockingCaller), blockingWorkerOperations: labels(event.blockingWorkerOperations),
    ...numbers(event, ["elapsedMs", "queueWaitMs", "writerExecutionMs", "completionDelayMs", "transactionCount"]),
  });
  reservation.subscribe(onReservation);
  const worker = channel("openclaw.worker.task");
  const onWorker = event => observe("worker-task", {
    worker: label(event.worker), outcome: label(event.outcome),
    ...numbers(event, ["queueMs", "preparationMs", "hostWaitMs", "runMs", "transferMs", "pendingTasks", "pendingBytes"]),
  });
  worker.subscribe(onWorker);
  const stopRequests = onWorkerRequestMetrics((kind, requestClass, phase, queueDepth, queueWaitMs, durationMs, timing) => {
    if (phase !== "completed") return;
    observe("worker-request", { kind, requestClass, queueDepth, queueWaitMs, durationMs,
      timing: numbers(timing, ["enqueued", "dispatched", "posted", "postFinished", "received", "inputReady",
        "executeStarted", "executeFinished", "serialized", "replied", "replyReceived"]) });
  });
  const timer = setInterval(flush, 250);
  timer.unref();
  process.on("message", message => {
    if (message?.turnStartTimelineFlush !== true) return;
    process.channel?.ref();
    stopped = true;
    clearInterval(timer);
    reservation.unsubscribe(onReservation);
    worker.unsubscribe(onWorker);
    stopRequests();
    flush();
    process.send?.({ turnStartTimelineFlushed: true, dropped }, () => process.channel?.unref());
  });
  process.channel?.unref();
}
if (isMainThread) onTrustedInternalDiagnosticEvent(event => {
  if (event.type === "diagnostic.phase.completed" &&
      (event.name.startsWith("chat.send.") || event.name === "worktree.preparation")) {
    process.send?.({ turnStartPhase: { name: event.name, durationMs: event.durationMs,
      startedAt: event.startedAt, endedAt: event.endedAt, details: event.details } });
  }
}, { include: ["diagnostic.phase.completed"] });
`,
  );
}
if (values["team-stress"]) {
  writeFileSync(
    teamStressPreload,
    `import { isMainThread } from "node:worker_threads";\nimport { installTeamStressTelemetryIpc } from ${JSON.stringify(new URL("./team-shape-stress-telemetry.ts", import.meta.url).href)};\nif (isMainThread) installTeamStressTelemetryIpc();\n`,
  );
}
if (scenario === "chat.startup") {
  writeFileSync(
    startupObserverPreload,
    `import { channel } from "node:diagnostics_channel";
import { onTrustedInternalDiagnosticEvent } from ${JSON.stringify(new URL("../../src/infra/diagnostic-events.ts", import.meta.url).href)};
const stages = channel("openclaw.gateway.request.stages");
onTrustedInternalDiagnosticEvent((event) => {
  if (event.type === "diagnostic.phase.completed" && event.name.startsWith("chat.startup.") && stages.hasSubscribers) {
    stages.publish({ operation: event.name, durationMs: event.durationMs });
  }
}, { include: ["diagnostic.phase.completed"] });
`,
  );
}
if (values["dashboard-rpc"]) {
  for (const id of ["github", "workboard"]) {
    cfg.plugins.entries[id] = { enabled: true };
    if (cfg.plugins.allow?.length && !cfg.plugins.allow.includes(id)) {
      cfg.plugins.allow.push(id);
    }
  }
  writeFileSync(
    dashboardPreload,
    `import { MockAgent } from ${JSON.stringify(import.meta.resolve("undici"))};
import { setTimeout as delay } from 'node:timers/promises';
const transport = new MockAgent();
transport.disableNetConnect();
const github = transport.get('https://api.github.com');
const repository = '/repos/openclaw-fixture/soak';
const connected = ${JSON.stringify(values["github-options-connected"])};
let firstAccountRequestAt;
let accountRevision = 1;
if (connected) {
  github.intercept({ path: '/user', method: 'GET' }).reply(() => {
    firstAccountRequestAt ??= Date.now();
    accountRevision = Date.now() - firstAccountRequestAt >= 60_000 ? 2 : 1;
    return { statusCode: 200, data: JSON.stringify({ id: 1516,
      login: accountRevision === 1 ? 'synthetic-shared' : 'synthetic-shared-updated',
      avatar_url: null }), responseOptions: { headers: {
        'content-type': 'application/json', 'x-oauth-scopes': 'repo, read:org, gist',
      } } };
  }).persist();
  github.intercept({ path: /^\\/repos\\/openclaw-fixture\\/soak\\/pulls\\?/, method: 'GET' })
    .reply(200, []).persist();
}
github.intercept({ path: repository, method: 'GET' }).reply(200, {
  id: 1516, private: false, visibility: 'public', fork: false,
  full_name: 'openclaw-fixture/soak', default_branch: 'main',
}).persist();
github.intercept({ path: repository + '/issues/1', method: 'GET' }).reply(() => {
  process.send?.({ channel: 'dashboard-github-fixture' });
  return { statusCode: 200, data: JSON.stringify({
    title: ${JSON.stringify(dashboardPreviewTitle)}, state: 'open', number: 1,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
    repository_url: 'https://api.github.com' + repository,
    user: { login: 'synthetic-user' }, comments: 0,
  }), responseOptions: { headers: { 'content-type': 'application/json' } } };
}).persist();
// Startup replaces global agents; bind the synthetic transport on each fetch.
const nativeFetch = globalThis.fetch;
const routeRequests = new Map();
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.origin === 'https://api.github.com') {
    const route = url.pathname + url.search;
    const sequence = (routeRequests.get(route) ?? 0) + 1;
    routeRequests.set(route, sequence);
    const delayMs = connected && url.pathname === '/user' ? 300 + ((sequence - 1) % 3) * 300 : 0;
    const startedAtEpochMs = performance.timeOrigin + performance.now();
    let status = 0;
    try {
      if (delayMs) await delay(delayMs, undefined, { signal: options?.signal ?? undefined });
      const response = await nativeFetch(input, { ...options, dispatcher: transport });
      status = response.status;
      return response;
    } finally {
      if (connected) process.send?.({ channel: 'dashboard-github-upstream', route, sequence,
        startedAtEpochMs, durationMs: performance.timeOrigin + performance.now() - startedAtEpochMs,
        delayMs, status, ...(url.pathname === '/user' ? { accountRevision } : {}) });
    }
  }
  if (url.hostname !== '127.0.0.1') throw new Error('Benchmark blocked external fetch');
  return nativeFetch(input, options);
};\n`,
  );
}
let reloadPluginId: string | undefined;
let scopePluginId: string | undefined;
let updateReloadPlugin: (() => number) | undefined;
const pluginUpdateLatenciesMs: number[] = [];
if (
  scenario === "plugins.reload" ||
  scenario === "plugin.scope" ||
  syntheticPluginCount > 0 ||
  values["stress-network-tool"]
) {
  const plugin = writePluginFixtures(output, {
    count: Math.max(1, syntheticPluginCount),
    activationOnStartup: true,
    nodePolicy: values["node-policy-churn"],
  });
  if (scenario === "plugins.reload") {
    reloadPluginId = plugin.pluginIds[0];
    if (values["plugin-update"]) {
      const pluginSource = path.join(plugin.pluginsDir, reloadPluginId!, "index.cjs");
      let revision = 0;
      updateReloadPlugin = () => {
        revision++;
        writeFileSync(
          pluginSource,
          `module.exports = { id: ${JSON.stringify(reloadPluginId)}, register(api) {
  api.registerGatewayMethod("benchmark.pluginVersion", async ({ respond }) => {
    respond(true, { revision: ${revision} });
  }, { scope: "operator.read" });
} };\n`,
        );
        return revision;
      };
      updateReloadPlugin();
    }
  } else if (scenario === "plugin.scope") {
    scopePluginId = plugin.pluginIds[0];
    const pluginSource = path.join(plugin.pluginsDir, scopePluginId!, "index.cjs");
    writeFileSync(
      pluginSource,
      `const { getPluginRuntimeGatewayRequestScope } = require("openclaw/plugin-sdk/plugin-runtime");
const id = ${JSON.stringify(scopePluginId)};
const source = ${JSON.stringify(pluginSource)};
function currentScope() {
  const scope = getPluginRuntimeGatewayRequestScope();
  if (scope?.pluginId !== id || scope.pluginSource !== source || !scope.pluginOrigin ||
      !scope.pluginRegistry || !scope.client) throw new Error("Synthetic plugin scope is missing");
  return scope;
}
module.exports = { id, register(api) {
  api.registerGatewayMethod("benchmark.pluginScope", async ({ params, respond }) => {
    const before = currentScope();
    await Promise.resolve();
    const after = currentScope();
    if (before !== after) throw new Error("Synthetic plugin scope changed across await");
    respond(true, { pluginId: id, sequence: params.sequence, scopeVerified: true });
  }, { scope: "operator.read" });
} };\n`,
    );
  } else if (values["stress-network-tool"]) {
    const id = plugin.pluginIds[0]!;
    const pluginDir = path.join(plugin.pluginsDir, id);
    writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `module.exports = { id: ${JSON.stringify(id)}, register(api) {
  api.registerTool(() => ({ name: "benchmark_network", label: "Synthetic HTTP probe",
    description: "Fetch a synthetic note from the isolated benchmark server.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async (_id, _params, signal) => {
      const response = await fetch(${JSON.stringify(`http://127.0.0.1:${mockPort}/network-tool`)}, { signal });
      if (!response.ok) throw new Error("Synthetic HTTP probe failed");
      const text = await response.text();
      return { content: [{ type: "text", text }], details: { text } };
    }
  }), { name: "benchmark_network" });
} };\n`,
    );
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.contracts = { tools: ["benchmark_network"] };
    writeFileSync(manifestPath, JSON.stringify(manifest));
  }
  cfg.plugins = {
    ...cfg.plugins,
    enabled: true,
    allow: [...new Set([...(cfg.plugins?.allow ?? []), ...plugin.pluginIds])],
    load: { paths: [plugin.pluginsDir] },
  };
}
if (values["attempt-setup-image"]) {
  cfg.tools.toolSearch = { enabled: false };
  cfg.tools.sandbox = { tools: { allow: ["*"] } };
  cfg.agents.defaults.sandbox = {
    mode: "all",
    backend: "podman",
    scope: "session",
    workspaceAccess: "rw",
    workspaceRoot: path.join(root, "sandboxes"),
    docker: {
      image: values["attempt-setup-image"],
      containerPrefix: `bench-attempt-${port}-`,
      network: "none",
      cpus: 1,
      memory: "512m",
    },
  };
  const plugin = writePluginFixtures(output, { count: 1, activationOnStartup: true });
  writeFileSync(
    path.join(plugin.pluginsDir, plugin.pluginIds[0]!, "index.cjs"),
    `module.exports = { id: ${JSON.stringify(plugin.pluginIds[0])}, register(api) {
      api.registerTool({ name: "benchmark_probe", label: "Benchmark probe",
        description: "Read a synthetic benchmark fact.", parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "synthetic-plugin-ready" }] }) });
    } };\n`,
  );
  cfg.plugins = {
    ...cfg.plugins,
    enabled: true,
    allow: [...new Set([...(cfg.plugins?.allow ?? []), ...plugin.pluginIds])],
    load: { paths: [plugin.pluginsDir] },
  };
  const manifestPath = path.join(plugin.pluginsDir, plugin.pluginIds[0]!, "openclaw.plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.contracts = { tools: ["benchmark_probe"] };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  cfg.mcp = {
    servers: {
      benchmark: {
        transport: "streamable-http",
        url: `http://127.0.0.1:${mockPort}/mcp`,
        enabled: true,
      },
    },
  };
}
const configCapturePreload = path.join(output, "config-capture-counts-preload.mjs");
const configCaptureCountsPath = path.join(output, "config-capture-counts.json");
const configCaptureSourcePreload = path.join(output, "config-capture-source-preload.mjs");
if (configCaptureSource) {
  writeFileSync(
    configCaptureSourcePreload,
    `import { registerHooks } from "node:module";
const sources = ${JSON.stringify(configCaptureSource)};
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  const owner = Object.keys(sources).find(file => url.endsWith("/" + file));
  return owner ? { ...loaded, format: "module-typescript", source: sources[owner].source } : loaded;
} });\n`,
  );
}
if (values["config-capture-counts"]) {
  writeFileSync(
    configCapturePreload,
    String.raw`
import fs from "node:fs";
import { registerHooks } from "node:module";
import { isMainThread } from "node:worker_threads";
if (isMainThread) {
  const fresh = () => ({ calls: {}, callers: {}, clonedPayloads: 0, serializedBytes: 0, graphObjects: 0 });
  let active = true, counts = fresh(), beforeFirstWindow;
  const installed = {};
  const observer = {
    count(name) {
      if (!active) return;
      counts.calls[name] = (counts.calls[name] ?? 0) + 1;
      const caller = name + " <- " + new Error().stack.split("\n").slice(3, 6).join(" <- ").trim();
      counts.callers[caller] = (counts.callers[caller] ?? 0) + 1;
    },
    clone(value) {
      if (!active) return;
      counts.clonedPayloads++;
      counts.serializedBytes += Buffer.byteLength(JSON.stringify(value));
      const seen = new Set(), pending = [value];
      while (pending.length) {
        const current = pending.pop();
        if (!current || typeof current !== "object" || seen.has(current)) continue;
        seen.add(current);
        for (const member of Object.values(current)) pending.push(member);
      }
      counts.graphObjects += seen.size;
    }
  };
  globalThis[Symbol.for("openclaw.benchmark.configCaptureCounts")] = observer;
  registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    const owner = url.match(/\/(runtime-config-capture-state|runtime-source-projection)\.ts$/)?.[1];
    if (!owner) return loaded;
    const raw = loaded.format === "module-typescript" ? loaded.source : fs.readFileSync(new URL(url));
    let source = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const name = owner === "runtime-config-capture-state" ? "captureRuntimeConfigWithSource" : "captureRuntimeConfig";
    const signature = new RegExp("export function " + name + "\\([^{}]*\\): OpenClawConfig \\{");
    if (!signature.test(source)) throw new Error("Config capture observation signature changed: " + owner);
    source = source.replace(signature, match => match + "__configCaptureCounts.count(" + JSON.stringify(name) + ");");
    if (owner === "runtime-config-capture-state") {
      const clone = "freezeJsonSnapshot(cloneConfigWithResolutionFacts(value))";
      if (source.split(clone).length !== 2) throw new Error("Config capture clone observation source changed");
      source = source.replace(clone, "(__configCaptureCounts.clone(value), " + clone + ")");
    }
    installed[owner] = true;
    return { ...loaded, format: "module-typescript",
      source: 'const __configCaptureCounts = globalThis[Symbol.for("openclaw.benchmark.configCaptureCounts")];\n' + source };
  } });
  process.prependListener("message", message => {
    if (message?.channel !== "openclaw-gateway-bench-profile" || message.kind !== "diagnostics") return;
    if (message.action === "start") {
      beforeFirstWindow ??= counts;
      active = false;
      counts = fresh();
      queueMicrotask(() => { active = true; });
    } else {
      active = false;
      if (Object.keys(installed).length !== 2) throw new Error("Config capture observers were not both installed");
      fs.writeFileSync(${JSON.stringify(configCaptureCountsPath)}, JSON.stringify({ ...counts, installed, beforeFirstWindow,
        scope: "main-isolate capture calls and clone payloads; serialized UTF-8 bytes and graph objects, not heap allocation" }));
    }
  });
  process.channel?.unref();
}
`,
  );
}
const authorityPreload = path.join(output, "authority-counts-preload.mjs");
if (values["authority-counts"]) {
  writeGatewayAuthorityCountsPreload(authorityPreload);
}
const authorityChannel = "openclaw-operator-authority-bench";
const authorityEmail = "operator@authority.example.test";
const authorityOrigin = "https://authority.example.test";
const fixtureDirectPassword = "synthetic-connected-github-local-caller";
const trustedProxyScenario =
  values["operator-model-policy"] ||
  values["operator-access-policy"] ||
  values["github-options-connected"] ||
  values["presence-deltas"];
const clientConnection = {
  url: `ws://127.0.0.1:${port}`,
  // Long streamed replies plus allocation sampling can queue admission beyond the
  // helper's interactive default. Keep the full delay in measured connect latency.
  handshakeTimeoutMs: 60_000,
  openTimeoutMs: 60_000,
  openTimeoutMessage: "benchmark WebSocket admission exceeded 60s",
  ...(trustedProxyScenario
    ? {
        origin: authorityOrigin,
        headers: {
          "x-forwarded-user": authorityEmail,
          "x-forwarded-proto": "https",
          "x-forwarded-for": "203.0.113.50",
        },
      }
    : {}),
};
if (values["operator-access-policy"]) {
  const id = "synthetic-operator-access";
  const pluginDir = path.join(output, id);
  mkdirSync(pluginDir);
  writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false },
    }),
  );
  writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `
module.exports = { id: ${JSON.stringify(id)}, register(api) {
  const channel = ${JSON.stringify(authorityChannel)};
  let active = false, profileId, unsubscribe;
  const census = globalThis[Symbol.for("openclaw.benchmark.accessPolicyFixture")] = { active: false, policies: new Set(),
    counts: { authorize: 0, resume: 0, assert: 0, tools: 0, transcriptUpdates: 0, messageAppends: 0 } };
  const counts = census.counts;
  const messages = new Set();
  const controller = new AbortController();
  const grant = { grantId: "00000000-0000-4000-8000-000000000001", signal: controller.signal,
    assertCurrent() { if (active) counts.assert++; controller.signal.throwIfAborted(); } };
  function checkProfile(context) {
    if (context.profile.profileId === "gateway-owner" ||
        !context.profile.emails.includes(${JSON.stringify(authorityEmail)}) || !context.requiredByRole)
      throw new Error("Synthetic policy requires its non-owner operator");
    profileId = context.profile.profileId;
  }
  api.registerGatewayAccessPolicy({
    authorize(context) { checkProfile(context); census.policies.add(${JSON.stringify(id)});
      if (active) counts.authorize++; return grant; },
    resume(context) { checkProfile(context); if (active) counts.resume++;
      if (context.grantId !== grant.grantId) throw new Error("Synthetic grant mismatch"); return grant; }
  });
  api.on("after_tool_call", () => { if (active) counts.tools++; });
  function control(message) {
    if (message?.channel !== channel || typeof message.id !== "string" ||
        !["start", "stop"].includes(message.action)) return;
    if (census.policies.size !== ${operatorAccessPolicyCount})
      throw new Error("Synthetic access policy inventory was not fully authorized");
    active = census.active = message.action === "start";
    if (active) { for (const key of Object.keys(counts)) counts[key] = 0; messages.clear(); }
    const host = globalThis[Symbol.for("openclaw.benchmark.authorityCounts")];
    if (host) { host.active = active; if (active) { host.counts = {}; host.callers = {}; host.firstAuthPolicyStacks = []; } }
    process.send?.({ channel, id: message.id, counts: { ...counts }, profileId,
      sourceOverlay: globalThis[Symbol.for("openclaw.benchmark.sourceOverlay")],
      scopeCounts: globalThis[Symbol.for("openclaw.benchmark.accessAuthorityCensus")]?.snapshot(),
      ...(host ? { hostCounts: host.counts, hostCallers: host.callers, installed: host.installed, firstAuthPolicyStacks: host.firstAuthPolicyStacks } : {}) });
  }
  api.registerService({ id: "synthetic-authority-counters",
    start() {
      unsubscribe = api.runtime.events.onSessionTranscriptUpdate((update) => {
        if (!active || !update.target.sessionKey.startsWith("agent:main:transcript-broadcast-measure-")) return;
        counts.transcriptUpdates++;
        if (update.message !== undefined && Number.isSafeInteger(update.messageSeq)) {
          const key = update.target.sessionKey + ":" + update.messageSeq;
          if (!messages.has(key)) { messages.add(key); counts.messageAppends++; }
        }
      });
      process.on("message", control);
    },
    stop() { active = false; process.off("message", control); unsubscribe?.(); controller.abort(); }
  });
} };
`,
  );
  cfg.plugins.load = {
    ...cfg.plugins.load,
    paths: [...(cfg.plugins.load?.paths ?? []), pluginDir],
  };
  if (cfg.plugins.allow?.length) {
    cfg.plugins.allow.push(id);
  }
  cfg.plugins.entries[id] = { enabled: true };
  // Only one grant is applicable: persisted child recovery records one original grant.
  for (let index = 1; index < operatorAccessPolicyCount; index++) {
    const otherId = `${id}-${index}`;
    const otherDir = path.join(output, otherId);
    mkdirSync(otherDir);
    writeFileSync(
      path.join(otherDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: otherId,
        activation: { onStartup: true },
        configSchema: { type: "object", additionalProperties: false },
      }),
    );
    writeFileSync(
      path.join(otherDir, "index.cjs"),
      `
module.exports = { id: ${JSON.stringify(otherId)}, register(api) {
  api.registerGatewayAccessPolicy({ authorize(context) {
    const census = globalThis[Symbol.for("openclaw.benchmark.accessPolicyFixture")];
    if (!census) throw new Error("Synthetic access policy census is unavailable");
    census.policies.add(${JSON.stringify(otherId)});
    if (census.active) census.counts.authorize++;
    if (context.requiredByRole) throw new Error("Unselected synthetic policy was required");
    return undefined;
  } });
} };\n`,
    );
    cfg.plugins.load.paths.push(otherDir);
    if (cfg.plugins.allow?.length) {
      cfg.plugins.allow.push(otherId);
    }
    cfg.plugins.entries[otherId] = { enabled: true };
  }
}
if (trustedProxyScenario) {
  cfg.gateway = {
    ...cfg.gateway,
    trustedProxies: ["127.0.0.1"],
    auth: {
      mode: "trusted-proxy",
      ...(values["github-options-connected"] ? { password: fixtureDirectPassword } : {}),
      identityScopes: { [authorityEmail]: ["operator.admin"] },
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowLoopback: true,
      },
    },
    controlUi: { ...cfg.gateway.controlUi, allowedOrigins: [authorityOrigin] },
    roles: {
      default: "synthetic-operator",
      definitions: {
        "synthetic-operator": {
          scopes: ["operator.admin"],
          agents: "*",
          sessions: { others: "write" },
          ...(values["operator-model-policy"]
            ? {
                modelPolicy: {
                  sourceAgent: "main",
                  allow: ["openai/*"],
                  deny: ["openai/blocked-*"],
                },
              }
            : {}),
          ...(values["operator-access-policy"]
            ? { accessPolicyPlugin: "synthetic-operator-access" }
            : {}),
        },
      },
    },
  };
}
const toolPaths = Array.from({ length: retentionScenario ? 3 : 1 }, (_, index) => {
  if (values["attempt-setup-image"] || values["sandbox-image"]) {
    return "README.md";
  }
  const file = path.join(root, "workspace", `synthetic-tool-input-${index}.txt`);
  writeFileSync(
    file,
    "Synthetic allocation benchmark tool result.\n" +
      (retentionScenario ? promptContent.update(Buffer.alloc(8192)).toString("hex") : ""),
  );
  return file;
});
const configPath = values["default-state-dir"]
  ? path.join(root, `${path.basename(output)}.json`)
  : path.join(output, "openclaw.json");
writeFileSync(configPath, JSON.stringify(cfg));
const chunk = values["answer-chunk"];
function createTextResponse(chunks: string[], phase?: "commentary") {
  const text = chunks.join("");
  const item = {
    type: "message",
    id: "msg_broadcast",
    role: "assistant",
    status: "completed",
    ...(phase ? { phase } : values["final-answer-phase"] ? { phase: "final_answer" } : {}),
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    ...chunks.map((delta) => ({
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta,
    })),
    {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_broadcast",
        status: "completed",
        output: [item],
        usage: { input_tokens: 11, output_tokens: chunks.length, total_tokens: 11 + chunks.length },
      },
    },
  ];
  return { item, events };
}
function functionCallEvents(name: string, args: unknown, callId: string) {
  const item = {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  };
  return [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${callId}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 11, output_tokens: 10, total_tokens: 21 },
      },
    },
  ];
}
function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content
        .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
        .join("\n")
    : "";
}
type StressSubagent = {
  parentPrompt: string;
  childPrompt: string;
  childResult: string;
  parentAck: string;
  spawnCallId: string;
  yieldCallId: string;
  phase: "initial" | "spawn-issued" | "yield-issued" | "ack-issued";
  accepted?: { childSessionKey: string; runId: string };
  childRequests: number;
  yieldObserved: boolean;
  cancelled: boolean;
  releaseChild: () => void;
  childReady: Promise<void>;
  cohortReady: Promise<void>;
};
let stressSubagent: StressSubagent | undefined;
async function stressSubagentEvents(body: unknown, input: unknown, purpose: string) {
  const state = stressSubagent;
  if (
    !state ||
    !Array.isArray(input) ||
    purpose === "activity-recap" ||
    purpose === "session-observer"
  ) {
    return undefined;
  }
  const userTexts = input
    .filter((item) => isRecord(item) && item.role === "user")
    .map((item) => stripInboundMetadata(contentText(item.content)).trim());
  const isParent = userTexts.includes(state.parentPrompt);
  // Native child envelopes reach the provider with escaped delimiters. The parent's
  // completion quotes that task too, so its original prompt takes precedence.
  if (!isParent && userTexts.some((text) => text.split("\n").includes(state.childPrompt))) {
    if (++state.childRequests !== 1) {
      throw new Error("stress subagent issued more than one child model request");
    }
    // Parent yield releases its main-lane slot; all foreground streams must be admitted too.
    await Promise.all([state.childReady, state.cohortReady]);
    if (state.cancelled) {
      throw new Error("stress subagent cohort was cancelled");
    }
    return createTextResponse([state.childResult]).events;
  }
  if (!isParent) {
    return undefined;
  }
  if (state.phase === "initial") {
    const tools = isRecord(body) && Array.isArray(body.tools) ? body.tools : [];
    for (const name of ["exec", "sessions_yield"]) {
      if (!tools.some((tool) => isRecord(tool) && tool.type === "function" && tool.name === name)) {
        throw new Error(`stress subagent parent is missing declared tool ${name}`);
      }
    }
    state.phase = "spawn-issued";
    return functionCallEvents(
      "exec",
      {
        title: "Start the synthetic child task",
        awaitResults: true,
        code: `return await sessions_spawn(${JSON.stringify({
          task: state.childPrompt,
          agentId: "main",
          runtime: "subagent",
          mode: "run",
          context: "isolated",
          cleanup: "delete",
          completionTarget: "parent",
          runTimeoutSeconds: 120,
        })});`,
      },
      state.spawnCallId,
    );
  }
  if (state.phase === "spawn-issued") {
    const spawnOutput = input.findLast(
      (item) =>
        isRecord(item) &&
        item.type === "function_call_output" &&
        item.call_id === state.spawnCallId,
    );
    const receipt: unknown = JSON.parse(contentText(spawnOutput?.output));
    const accepted = isRecord(receipt) ? receipt.value : undefined;
    if (
      !isRecord(receipt) ||
      receipt.status !== "completed" ||
      !isRecord(accepted) ||
      accepted.status !== "accepted" ||
      accepted.context !== "isolated" ||
      accepted.completionTarget !== "parent" ||
      typeof accepted.runId !== "string" ||
      typeof accepted.childSessionKey !== "string" ||
      !accepted.childSessionKey.startsWith("agent:main:subagent:")
    ) {
      throw new Error("stress subagent spawn did not return an accepted native child");
    }
    state.accepted = { runId: accepted.runId, childSessionKey: accepted.childSessionKey };
    teamStressFanout?.trackForeground([accepted.childSessionKey], false);
    state.phase = "yield-issued";
    return functionCallEvents(
      "sessions_yield",
      { message: "Await the synthetic child result." },
      state.yieldCallId,
    );
  }
  if (
    state.phase !== "yield-issued" ||
    !state.yieldObserved ||
    state.childRequests !== 1 ||
    !userTexts.some((text) => text.includes(state.childResult))
  ) {
    throw new Error(
      `stress subagent parent resumed without its yielded child result: phase=${state.phase}, yielded=${state.yieldObserved}, childRequests=${state.childRequests}, resultObserved=${userTexts.some((text) => text.includes(state.childResult))}`,
    );
  }
  state.phase = "ack-issued";
  return createTextResponse([state.parentAck]).events;
}
const events = createTextResponse(Array.from({ length: chunkCount }, () => chunk)).events;
const utilityEvents = createTextResponse(["Synthetic acknowledgement."]).events;
let activeStreams = 0;
let peakStreams = 0;
let streamRequests = 0;
let primaryStreamRequests = 0;
let activePrimaryStreams = 0;
let peakPrimaryStreams = 0;
let toolCalls = 0;
let toolResults = 0;
let networkToolRequests = 0;
let outputLimitResponses = 0;
let recoveredResponses = 0;
let imageRequests = 0;
let reasoningResponses = 0;
let reasoningResponseSequence = 0;
let reasoningReplayRequests = 0;
let historicalReplayRequests = 0;
const sessionStoreValues = new Map<string, string>();
const execIoStarted = new Set<number>();
function readExecIoProgress() {
  return [...execIoStarted].map((index) => {
    const lines = readFileSync(path.join(output, `agent-exec-io-${index}.jsonl`), "utf8")
      .trim()
      .split("\n");
    const last: unknown = JSON.parse(lines.at(-1)!);
    if (
      !isRecord(last) ||
      typeof last.bytesWritten !== "number" ||
      typeof last.atEpochMs !== "number" ||
      typeof last.pid !== "number" ||
      last.phase === "stopped"
    ) {
      throw new Error(`Synthetic IO writer ${index} stopped or has invalid evidence`);
    }
    process.kill(last.pid, 0);
    return { index, bytesWritten: last.bytesWritten, atEpochMs: last.atEpochMs };
  });
}
let activeWorkCounts: { running: number; queued: number } | undefined;
async function readActiveWorkCounts() {
  let lastCounts: { running: number; queued: number } | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/prometheus`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`active-work metrics scrape failed: HTTP ${response.status}`);
    }
    const metrics = await response.text();
    const running = metrics.match(/^openclaw_sessions_active\{state="running"\} (\d+)$/mu);
    const queued = metrics.match(/^openclaw_sessions_active\{state="queued"\} (\d+)$/mu);
    if (running && queued) {
      lastCounts = { running: Number(running[1]), queued: Number(queued[1]) };
      if (lastCounts.running === runCount && lastCounts.queued === 0) {
        writeFileSync(path.join(output, `held-streams-${cohort?.id}.prom`), metrics);
        return lastCounts;
      }
    }
    await delay(100);
  }
  throw new Error(
    `active-work exporter did not observe ${runCount} running and zero queued held streams: ${JSON.stringify(lastCounts)}`,
  );
}
type StreamStartPhases = {
  admissionStartedAtEpochMs: number;
  firstPrimaryRequestAtEpochMs?: number;
  lastPrimaryRequestAtEpochMs?: number;
  streamsReleasedAtEpochMs?: number;
  firstPrimarySseWrittenAtEpochMs?: number;
  completedAtEpochMs?: number;
};
type TurnTiming = {
  runId: string;
  sessionKey: string;
  startedAt: number;
  acknowledgedMs?: number;
  firstAssistantDeltaMs?: number;
  firstToolStartMs?: number;
  receivedRunId?: string;
  awaitingCreatedRunId?: boolean;
  completedMs?: number;
  providerRequestMs?: number;
  providerBarrierMs?: number;
  firstTextMs?: number;
};
const epochNow = () => performance.timeOrigin + performance.now();
function createPollRandom(round: number, client: number) {
  if (values["poll-seed"] === undefined) {
    return undefined;
  }
  let state = createHash("sha256")
    .update(JSON.stringify([values["poll-seed"], round, client]))
    .digest()
    .readUInt32LE();
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
const sessionEventRuns = new Map<string, { resolve: (runId: string) => void }>();
const queuedChatInputs = new Map<string, () => void>();
const terminalChatInputs = new Map<string, (state: string) => void>();
const cronOperatorSetupPrompt = "Create the synthetic scheduled operator continuation fixtures.";
const cronOperatorSetupCallId = "call_cron_operator_setup";
const cronOperatorJobs: Array<{ id?: string; cohortId: string }> = values["cron-operator-turn"]
  ? [{ cohortId: randomUUID() }]
  : [];
let cronOperatorSetupCompleted = false;
let cohort:
  | {
      id: string;
      expectedCount: number;
      arrivals: Set<number>;
      turns: Map<number, TurnTiming>;
      toolCallIds: Set<string>;
      completedToolCallIds: Set<string>;
      outputLimited: Set<string>;
      requestPhases: Map<string, string>;
      reasoningSignatures: Map<string, Set<string>>;
      incompleteReasoningSignatures: Map<string, string>;
      phases: StreamStartPhases;
      beforeRelease?: () => Promise<void>;
      afterToolStreamStart?: () => Promise<void>;
      activeInputAdmission?: Promise<void>;
      ready: Promise<void>;
      release: () => void;
      reject: (error: Error) => void;
    }
  | undefined;
const expectedHistoricalReasoning =
  verifyHistoryReplay && !values["seed-history"]
    ? Array.from(
        { length: sessionCount },
        (_, index) =>
          new Set(
            Array.from({ length: historyTurns * 2 }, (_unused, ordinal) =>
              createHash("sha256")
                .update(
                  historyReasoningContent(
                    index,
                    Math.floor(ordinal / 2),
                    ordinal % 2 === 0 ? "tool" : "answer",
                  ),
                )
                .digest("hex"),
            ),
          ),
      )
    : [];
const attemptSetupCatalog = new Set<string>();
const richContextMcpLists: Record<string, number> = {};
const richContextSessionKeys = new Set<string>();
const turnStartHistoryReplayCounts: number[] = [];
const authAvailabilityMock = { requests: 0, rateLimits: 0, successes: 0 };
const authAvailabilityStartedAt = Date.now();
const authAvailabilityMinutes = new Map<number, typeof authAvailabilityMock>();
const mock = createServer((req, res) => {
  if (values["stress-network-tool"] && req.url === "/network-tool") {
    networkToolRequests++;
    res.end("synthetic-network-tool-verified");
    return;
  }
  if (req.url === "/health") {
    res.end("ok");
    return;
  }
  void (async () => {
    const richContextServer = values["turn-start-rich-context"]
      ? /^\/mcp\/(context_[ab])$/.exec(req.url ?? "")?.[1]
      : undefined;
    if (richContextServer) {
      const server = new McpServer({ name: richContextServer, version: "1.0.0" });
      for (let index = 0; index < 40; index++) {
        server.registerTool(
          `fixture_${index}`,
          {
            description: `Read synthetic context fact ${index}.`,
            inputSchema: z.object({ key: z.string().optional() }),
          },
          async () => ({ content: [{ type: "text", text: "synthetic-context-ready" }] }),
        );
      }
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        const body: unknown = req.method === "POST" ? JSON.parse(await readBody(req)) : undefined;
        if (isRecord(body) && body.method === "tools/list") {
          richContextMcpLists[richContextServer] =
            (richContextMcpLists[richContextServer] ?? 0) + 1;
        }
        await transport.handleRequest(req, res, body);
      } finally {
        await server.close();
      }
      return;
    }
    if (values["attempt-setup-image"] && req.url === "/mcp") {
      const server = new McpServer({ name: "attempt-setup-fixture", version: "1.0.0" });
      server.registerTool(
        "lookup_note",
        {
          description: "Read a synthetic fixture note.",
          inputSchema: z.object({ id: z.string() }),
        },
        async () => ({ content: [{ type: "text", text: "synthetic-mcp-ready" }] }),
      );
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        await transport.handleRequest(req, res);
      } finally {
        await server.close();
      }
      return;
    }
    const body: unknown = JSON.parse(
      await readBody(
        req,
        verifyHistoryReplay
          ? { requestMaxBytes: historyTurns * historyBytesPerTurn + 64 * 1024 ** 2 }
          : undefined,
      ),
    );
    const facts = summarizeMockInferenceRequest(body);
    if (facts.purpose === "activity-recap") {
      recapRequests++;
    }
    let input: unknown;
    if (body && typeof body === "object") {
      if ("input" in body) {
        input = body.input;
      }
      if (input === undefined && "messages" in body) {
        input = body.messages;
      }
    }
    const lastUser = Array.isArray(input)
      ? input
          .toReversed()
          .map(readMockUserText)
          .find((text) => text !== undefined)
      : undefined;
    if (values["cron-operator-turn"] && lastUser?.includes(cronOperatorSetupPrompt)) {
      const setupOutput =
        facts.hasToolOutput && Array.isArray(input)
          ? input.findLast((item) => isRecord(item) && item.type === "function_call_output")
          : undefined;
      let setupEvents;
      if (setupOutput) {
        if (!contentText(setupOutput.output).includes("synthetic-cron-operator-created")) {
          throw new Error(`Cron operator setup failed: ${contentText(setupOutput.output)}`);
        }
        cronOperatorSetupCompleted = true;
        setupEvents = createTextResponse([
          "Synthetic scheduled operator continuations created.",
        ]).events;
      } else {
        const jobs = cronOperatorJobs.map(({ cohortId }) => ({
          name: `Synthetic operator continuation ${cohortId}`,
          enabled: false,
          schedule: { kind: "every", everyMs: 3_600_000 },
          sessionTarget: `session:${keys[0]}`,
          wakeMode: "now",
          payload: {
            kind: "agentTurn",
            message: `Reply with benchmark stream 1. Transcript-broadcast cohort ${cohortId}.`,
            toolsAllow: ["*"],
            timeoutSeconds: 120,
          },
          delivery: { mode: "none" },
          failureAlert: false,
        }));
        setupEvents = functionCallEvents(
          "exec",
          {
            title: "Create synthetic scheduled continuations",
            awaitResults: true,
            code: `for (const job of ${JSON.stringify(jobs)}) json(await automations({ action: "add", job })); return "synthetic-cron-operator-created";`,
          },
          cronOperatorSetupCallId,
        );
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of setupEvents) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
      return;
    }
    const index = facts.turnIndex;
    const toolOutputs =
      Array.isArray(input) &&
      cohort &&
      facts.purpose !== "activity-recap" &&
      facts.purpose !== "session-observer"
        ? input.filter(
            (item) =>
              item?.type === "function_call_output" && cohort?.toolCallIds.has(item.call_id),
          )
        : [];
    const toolOutput = toolOutputs.at(-1);
    const continuation = toolScenario && toolOutput !== undefined;
    const primaryMessage = cohort
      ? `Reply with benchmark stream ${index}. Transcript-broadcast cohort ${cronOperatorJobs[0]?.cohortId ?? cohort.id}.`
      : undefined;
    const primary =
      primaryMessage !== undefined &&
      facts.purpose === "benchmark-turn" &&
      !facts.hasToolOutput &&
      !continuation &&
      index !== undefined &&
      index >= 1 &&
      index <= runCount &&
      lastUser !== undefined &&
      (values["session-event-wake"] || values["cron-operator-turn"]
        ? lastUser.includes(primaryMessage)
        : chatAttachmentContent
          ? lastUser
              .split("\n")
              .some((line) => stripInboundMetadata(line).trim() === primaryMessage)
          : stripInboundMetadata(lastUser).trim().split("\n")[0] === primaryMessage);
    if (primary && values["auth-availability-storm"]) {
      const minute = Math.floor((Date.now() - authAvailabilityStartedAt) / 60_000);
      let counts = authAvailabilityMinutes.get(minute);
      if (!counts) {
        counts = { requests: 0, rateLimits: 0, successes: 0 };
        authAvailabilityMinutes.set(minute, counts);
      }
      counts.requests++;
      if (++authAvailabilityMock.requests % 2 === 1) {
        counts.rateLimits++;
        authAvailabilityMock.rateLimits++;
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        res.end(
          JSON.stringify({
            error: {
              type: "rate_limit_error",
              message: "Synthetic capacity rate limit; retry shortly.",
            },
          }),
        );
        return;
      }
      counts.successes++;
      authAvailabilityMock.successes++;
    }
    if (primary && values["attempt-setup-image"]) {
      const tools = isRecord(body) && Array.isArray(body.tools) ? body.tools : [];
      const names = new Set(
        tools.flatMap((tool: unknown) => {
          if (!isRecord(tool)) {
            return [];
          }
          const name = tool.name ?? (isRecord(tool.function) ? tool.function.name : undefined);
          return typeof name === "string" ? [name] : [];
        }),
      );
      for (const expected of ["benchmark_probe", "benchmark__lookup_note"]) {
        if (!names.has(expected)) {
          throw new Error(`Attempt setup did not expose synthetic tool ${expected}`);
        }
        attemptSetupCatalog.add(expected);
      }
    }
    const requestPhase = primary
      ? `primary:${index}`
      : continuation
        ? `${retentionScenario && !cohort?.outputLimited.has(toolOutput.call_id) ? "limit" : "answer"}:${toolOutput.call_id}`
        : undefined;
    const firstRequestPhase =
      requestPhase !== undefined && !cohort?.requestPhases.has(requestPhase);
    if (values["turn-start-phases"] && historyTurns && primary && firstRequestPhase) {
      const replayed = new Set(
        (Array.isArray(input) ? input : []).flatMap((item) => {
          const text = stripInboundMetadata(readMockUserText(item) ?? "").trim();
          return /^Inspect synthetic file \d+\.$/.test(text) ? [text] : [];
        }),
      ).size;
      const expected = historyLastTurns && index === sessionCount ? historyLastTurns : historyTurns;
      if (replayed !== expected) {
        throw new Error(`Turn-start history replay mismatch: ${replayed}/${expected}`);
      }
      turnStartHistoryReplayCounts.push(replayed);
    }
    if (continuation) {
      if (reasoningScenario) {
        const expectedSignatures = cohort?.reasoningSignatures.get(toolOutput.call_id);
        if (
          expectedSignatures === undefined ||
          !Array.isArray(input) ||
          !input.some(
            (item) => item?.type === "reasoning" && expectedSignatures.has(item.encrypted_content),
          )
        ) {
          throw new Error("synthetic reasoning signature did not survive the provider request");
        }
        const incompleteSignature = cohort?.incompleteReasoningSignatures.get(toolOutput.call_id);
        if (
          incompleteSignature !== undefined &&
          input.some(
            (item) => item?.type === "reasoning" && item.encrypted_content === incompleteSignature,
          )
        ) {
          throw new Error("reasoning-only output-limit signature was replayed during recovery");
        }
        if (firstRequestPhase) {
          reasoningReplayRequests++;
        }
      }
      if (
        toolOutputs.some(
          (toolResult) =>
            typeof toolResult.output !== "string" ||
            !toolResult.output.includes(
              values["attempt-setup-image"] ||
                values["sandbox-image"] ||
                values["worktree-tool-churn"] ||
                values["stress-worktree-fanout"]
                ? "# Synthetic project "
                : "Synthetic allocation benchmark tool result.",
            ) ||
            (values["stress-tools"] && !toolResult.output.includes("synthetic-code-exec-verified")),
        )
      ) {
        throw new Error(
          "synthetic tool result did not verify its read and optional code-mode exec",
        );
      }
      if (!retentionScenario || !cohort?.outputLimited.has(toolOutput.call_id)) {
        // Provider history can replay a completed call in several requests.
        for (const result of toolOutputs) {
          if (cohort && !cohort.completedToolCallIds.has(result.call_id)) {
            cohort.completedToolCallIds.add(result.call_id);
            toolResults++;
          }
        }
      }
    }
    if (verifyHistoryReplay && primary) {
      const expected = expectedHistoricalReasoning[index - 1]!;
      const replayed = new Set(
        (Array.isArray(input) ? input : []).flatMap((item: unknown) => {
          if (
            !isRecord(item) ||
            item.type !== "reasoning" ||
            typeof item.encrypted_content !== "string" ||
            item.encrypted_content.length !== historyReasoningBytes
          ) {
            return [];
          }
          const digest = createHash("sha256").update(item.encrypted_content).digest("hex");
          return expected.has(digest) ? [digest] : [];
        }),
      );
      if (replayed.size !== historyTurns * 2) {
        throw new Error(
          `Deep-history replay lost reasoning items for session ${index - 1}: ${replayed.size}/${historyTurns * 2}`,
        );
      }
      historicalReplayRequests++;
    }
    if (retentionScenario && (primary || continuation)) {
      const hasImage =
        Array.isArray(input) &&
        input.some(
          (message) =>
            Array.isArray(message?.content) &&
            message.content.some(
              (part: unknown) =>
                isRecord(part) &&
                part.type === "input_image" &&
                typeof part.image_url === "string" &&
                part.image_url.startsWith("data:image/"),
            ),
        );
      if (!hasImage) {
        throw new Error("synthetic inline image did not survive the provider request");
      }
      if (firstRequestPhase) {
        imageRequests++;
      }
    }
    if (firstRequestPhase && requestPhase !== undefined) {
      // Histories can repeat a completed call; count and sign each logical phase once.
      cohort?.requestPhases.set(requestPhase, "");
    }
    activeStreams++;
    peakStreams = Math.max(peakStreams, activeStreams);
    streamRequests++;
    if (primary) {
      primaryStreamRequests++;
      activePrimaryStreams++;
      peakPrimaryStreams = Math.max(peakPrimaryStreams, activePrimaryStreams);
    }
    try {
      if (primary && cohort) {
        if (cohort.arrivals.has(index)) {
          throw new Error(`duplicate primary stream ${index} in cohort ${cohort.id}`);
        }
        cohort.arrivals.add(index);
        const timing = cohort.turns.get(index)!;
        timing.providerRequestMs = performance.now() - timing.startedAt;
        cohort.phases.firstPrimaryRequestAtEpochMs ??= epochNow();
        cohort.phases.lastPrimaryRequestAtEpochMs = epochNow();
        if (cohort.arrivals.size === cohort.expectedCount) {
          if (values["active-work-diagnostics"]) {
            activeWorkCounts = await readActiveWorkCounts();
          }
          if (cohort.beforeRelease) {
            await cohort.beforeRelease();
          }
          cohort.phases.streamsReleasedAtEpochMs = epochNow();
          cohort.release();
        }
        // User-perceived latency must not include waiting for slower peers in the burst.
        if (!values["turn-start-phases"]) {
          await cohort.ready;
        }
        timing.providerBarrierMs = performance.now() - timing.startedAt - timing.providerRequestMs;
      }
      const subagentAnswer = await stressSubagentEvents(body, input, facts.purpose);
      res.writeHead(200, { "content-type": "text/event-stream" });
      let toolAnswer;
      let reasoningReplayKey = toolOutput?.call_id;
      if (primary && toolScenario && cohort) {
        const currentCohort = cohort;
        const toolWorktree = values["sandbox-image"]
          ? "/workspace"
          : values["worktree-tool-churn"] || values["stress-worktree-fanout"]
            ? worktreeToolRoots.get(index)
            : stressWorktree;
        if ((values["worktree-tool-churn"] || values["stress-worktree-fanout"]) && !toolWorktree) {
          throw new Error("Synthetic foreground turn has no owned worktree");
        }
        const items = toolPaths.map((toolPath, toolIndex) => {
          const callId = `call_allocation_${currentCohort.id}_${index}_${toolIndex}`;
          currentCohort.toolCallIds.add(callId);
          const storeKey = `benchmark-${index}-${toolIndex}`;
          const previous = sessionStoreValues.get(storeKey);
          const storeCode = values["stress-session-store"]
            ? `if ((await load(${JSON.stringify(storeKey)})) !== ${JSON.stringify(previous) ?? "undefined"}) throw new Error("Synthetic session store replay mismatch");\n` +
              `await store(${JSON.stringify(storeKey)}, ${JSON.stringify(currentCohort.id)});\n`
            : "";
          if (values["stress-session-store"]) {
            sessionStoreValues.set(storeKey, currentCohort.id);
          }
          let execIoCode = "";
          if (values["exec-io-storm"] && toolIndex === 0 && !execIoStarted.has(index)) {
            execIoStarted.add(index);
            const command = [
              process.execPath,
              fileURLToPath(new URL("./agent-exec-io-load.mjs", import.meta.url)),
              output,
              String(index),
              String(durationMs + warmupMs + 900_000),
            ]
              .map((argument) => `'${argument.replaceAll("'", "'\\''")}'`)
              .join(" ");
            execIoCode =
              `const io = await exec({ command: ${JSON.stringify(command)}, workdir: ${JSON.stringify(toolWorktree)}, background: true, timeoutSeconds: 0 });\n` +
              'if (io.status !== "running" || typeof io.sessionId !== "string") throw new Error("Synthetic IO writer did not remain in background");\n';
          }
          return {
            type: "function_call",
            id: `fc_${currentCohort.id}_${index}_${toolIndex}`,
            call_id: callId,
            name: values["stress-tools"] ? "exec" : "read",
            arguments: JSON.stringify(
              values["stress-tools"]
                ? {
                    title: "Read the synthetic fixture and verify its worktree",
                    awaitResults: true,
                    code:
                      storeCode +
                      execIoCode +
                      (values["stress-tool-search"]
                        ? 'if (!(await catalog.search("read file content", { limit: 5 })).some(tool => tool.name === "read")) throw new Error("Synthetic tool search omitted read");\n'
                        : "") +
                      (values["stress-network-tool"]
                        ? 'const network = await benchmark_network({}); if (network.text !== "synthetic-network-tool-verified") throw new Error("Synthetic network tool result mismatch");\n'
                        : "") +
                      `json(await read({ path: ${JSON.stringify((values["worktree-tool-churn"] || values["stress-worktree-fanout"]) && toolWorktree ? path.join(toolWorktree, "README.md") : toolPath)} }));\n` +
                      `const shell = await exec({ command: ${JSON.stringify(stressShellCommand)}, workdir: ${JSON.stringify(toolWorktree)} });\n` +
                      `if (shell.exitCode !== 0 || shell.aggregated.trim() !== ${JSON.stringify(toolWorktree)}) throw new Error("Synthetic exec worktree mismatch");\n` +
                      (values["worktree-tool-churn"] || values["stress-worktree-fanout"]
                        ? `const match = await exec({ command: "grep -n 'Synthetic project' README.md", workdir: ${JSON.stringify(toolWorktree)} });\n` +
                          'if (match.exitCode !== 0 || !match.aggregated.includes("Synthetic project")) throw new Error("Synthetic worktree grep failed");\n'
                        : "") +
                      'return "synthetic-code-exec-verified";',
                  }
                : { path: toolPath },
            ),
          };
        });
        toolCalls += items.length;
        reasoningReplayKey = items.at(-1)?.call_id;
        const preamble = values["turn-start-phases"]
          ? createTextResponse(["I will inspect the synthetic workspace. "], "commentary")
          : undefined;
        const preambleItem = preamble?.item;
        toolAnswer = [
          ...(preamble?.events.slice(0, -1) ?? []),
          ...items.flatMap((item, toolIndex) => {
            const output_index = toolIndex + (preambleItem ? 1 : 0);
            return [
              {
                type: "response.output_item.added",
                output_index,
                item: { ...item, arguments: "" },
              },
              {
                type: "response.function_call_arguments.delta",
                item_id: item.id,
                output_index,
                delta: item.arguments,
              },
              { type: "response.output_item.done", output_index, item },
            ];
          }),
          {
            type: "response.completed",
            response: {
              id: `resp_${cohort.id}`,
              status: "completed",
              output: [...(preambleItem ? [preambleItem] : []), ...items],
              usage: { input_tokens: 11, output_tokens: 10, total_tokens: 21 },
            },
          },
        ];
      }
      let answer =
        subagentAnswer ??
        toolAnswer ??
        (facts.purpose === "activity-recap"
          ? createTextResponse([`Synthetic recap for cohort ${cohort?.id}.`]).events
          : primary || continuation
            ? events
            : utilityEvents);
      if (retentionScenario && continuation && cohort) {
        if (!cohort.outputLimited.has(toolOutput.call_id)) {
          cohort.outputLimited.add(toolOutput.call_id);
          outputLimitResponses++;
          const outputLimitAnswer = [
            {
              type: "response.incomplete",
              response: {
                id: `resp_limit_${toolOutput.call_id}`,
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" },
                output: [],
                usage: { input_tokens: 11, output_tokens: 4096, total_tokens: 4107 },
              },
            },
          ];
          answer = outputLimitAnswer;
        } else if (firstRequestPhase) {
          recoveredResponses++;
        }
      }
      if (providerDelayMs > 0) {
        await delay(providerDelayMs);
      }
      for (const event of answer) {
        if (res.destroyed) {
          break;
        }
        if (continuation && event.type === "response.completed") {
          await cohort?.activeInputAdmission;
        }
        if (primary && cohort) {
          cohort.phases.firstPrimarySseWrittenAtEpochMs ??= epochNow();
        }
        if (
          reasoningScenario &&
          (primary || continuation) &&
          "response" in event &&
          event.response !== undefined
        ) {
          const encryptedContent =
            (requestPhase !== undefined && cohort?.requestPhases.get(requestPhase)) ||
            promptContent.update(Buffer.alloc(8192)).toString("hex");
          if (firstRequestPhase && requestPhase !== undefined) {
            reasoningResponses++;
            cohort?.requestPhases.set(requestPhase, encryptedContent);
          }
          const reasoning = {
            type: "reasoning",
            id: `rs_${cohort?.id}_${index}_${reasoningResponseSequence++}`,
            status: "completed",
            summary: [],
            encrypted_content: encryptedContent,
          };
          if (firstRequestPhase && reasoningReplayKey && cohort) {
            // Accept any completed signature already issued for this call, never a length stop.
            if (event.type === "response.completed") {
              let signatures = cohort.reasoningSignatures.get(reasoningReplayKey);
              if (!signatures) {
                signatures = new Set();
                cohort.reasoningSignatures.set(reasoningReplayKey, signatures);
              }
              signatures.add(encryptedContent);
            } else {
              cohort.incompleteReasoningSignatures.set(reasoningReplayKey, encryptedContent);
            }
          }
          const output_index = event.response.output.length;
          for (const type of ["response.output_item.added", "response.output_item.done"]) {
            res.write(`data: ${JSON.stringify({ type, output_index, item: reasoning })}\n\n`);
          }
          res.write(
            `data: ${JSON.stringify({ ...event, response: { ...event.response, output: [...event.response.output, reasoning] } })}\n\n`,
          );
        } else {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        if (
          continuation &&
          event.type === "response.output_text.delta" &&
          cohort?.afterToolStreamStart
        ) {
          const beginActiveInputs = cohort.afterToolStreamStart;
          cohort.afterToolStreamStart = undefined;
          cohort.activeInputAdmission = beginActiveInputs();
          void cohort.activeInputAdmission.catch(cohort.reject);
        }
        if ((primary || continuation) && event.type === "response.output_text.delta") {
          await delay(chunkIntervalMs);
        }
      }
      res.end("data: [DONE]\n\n");
    } finally {
      activeStreams--;
      if (primary) {
        activePrimaryStreams--;
      }
    }
  })().catch((error: unknown) => {
    subscriberFailure ??= error instanceof Error ? error : new Error(String(error));
    console.error("Synthetic mock request failed:", subscriberFailure.message);
    res.destroy();
  });
});
const children: ChildProcess[] = [];
const clients: ReturnType<typeof createGatewayWsClient>[] = [];
let policyNode: ReturnType<typeof createGatewayWsClient> | undefined;
let policyNodeId: string | undefined;
const policyNodeCommands = Array.from(
  { length: values["node-policy-churn"] ? pluginCount : 0 },
  (_, index) => `bench-plugin-${String(index + 1).padStart(2, "0")}.echo`,
);
const githubOptionsClients: ReturnType<typeof createGatewayWsClient>[] = [];
const chatDeltaDeliveryMs: number[] = [];
const expectedClosures = new WeakSet<ReturnType<typeof createGatewayWsClient>>();
const responseFrameBytes = new WeakMap<
  ReturnType<typeof createGatewayWsClient>,
  Map<string, number>
>();
type RpcMeasurement = {
  latenciesMs: number[];
  responseBytes: number;
  representativeResponse?: { payload: unknown };
};
const rpcMeasurements = new Map<string, RpcMeasurement>();
const handshakeLatenciesMs: number[] = [];
const reconnectStorms: Array<{
  clients: number;
  startSpreadMs: number;
  allSidebarsCurrentMs: number;
}> = [];
const childLogs: ReturnType<typeof createWriteStream>[] = [];
const counters = new Map<string, number>();
const eventBytes = new Map<string, number>();
const sessionEventSizes = new Map<string, { frames: number; bytes: number }>();
type FrameSizes = {
  frameBytes: number;
  payloadBytes: number;
  fields: Record<string, number>;
  sessionFields?: Record<string, number>;
  duplicateEnvelopeFields?: number;
  potentialNumericRefsFrameBytes?: number;
};
const representativeFrames = new Map<string, FrameSizes>();
let initialFullFrame: FrameSizes | undefined;
const perClientCounters: Map<string, number>[] = [];
let measuring = false;
let teamStressStartedAt: number | undefined;
let teamStressTelemetryActive = false;
let teamStressPrometheusScrapes = 0;
let teamStressRpcBucket:
  | {
      minute: number;
      methods: Map<string, { histogram: ReturnType<typeof createHistogram>; errors: number }>;
    }
  | undefined;
const teamStressRpcMinutes: Array<{
  minute: number;
  startedAtEpochMs: number;
  methods: Record<
    string,
    { count: number; errors: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number }
  >;
}> = [];
function flushTeamStressRpcMinute() {
  if (!teamStressRpcBucket || teamStressStartedAt === undefined) {
    return;
  }
  const minute = {
    minute: teamStressRpcBucket.minute,
    startedAtEpochMs: teamStressStartedAt + teamStressRpcBucket.minute * 60_000,
    methods: Object.fromEntries(
      [...teamStressRpcBucket.methods].map(([method, { histogram, errors }]) => [
        method,
        {
          count: histogram.count,
          errors,
          p50Ms: (histogram.percentile(50) - 1) / 1000,
          p95Ms: (histogram.percentile(95) - 1) / 1000,
          p99Ms: (histogram.percentile(99) - 1) / 1000,
          maxMs: (histogram.max - 1) / 1000,
        },
      ]),
    ),
  };
  teamStressRpcMinutes.push(minute);
  appendFileSync(path.join(output, "stress-rpc-minutes.jsonl"), `${JSON.stringify(minute)}\n`);
  teamStressRpcBucket = undefined;
}
function recordTeamStressRpc(method: string, elapsedMs: number, ok: boolean) {
  if (!teamStressTelemetryActive || teamStressStartedAt === undefined) {
    return;
  }
  const minute = Math.floor((Date.now() - teamStressStartedAt) / 60_000);
  if (teamStressRpcBucket && teamStressRpcBucket.minute !== minute) {
    flushTeamStressRpcMinute();
  }
  const { methods } = (teamStressRpcBucket ??= { minute, methods: new Map() });
  let metric = methods.get(method);
  if (!metric) {
    metric = {
      histogram: createHistogram({ lowest: 1, highest: 3_600_000_001, figures: 3 }),
      errors: 0,
    };
    methods.set(method, metric);
  }
  metric.histogram.record(Math.min(3_600_000_000, Math.round(elapsedMs * 1000)) + 1);
  metric.errors += Number(!ok);
}
let measuringWholeSoakAllocation = false;
let wholeSoakDeliveredSessionEvents = 0;
let capturingColdSetup = values["dashboard-rpc"];
const coldSetupRpc: Array<{
  phase: "setup/preflight";
  method: string;
  startedAtEpochMs: number;
  durationMs: number;
  sessionKey?: string;
}> = [];
let lastSubscriberEventAt = performance.now();
let lastSubscriberEventName: string | undefined;
let closing = false;
let subscriberFailure: Error | undefined;
let recapRequests = 0;
type RecapReceipt = {
  client: number;
  key: string;
  state: unknown;
  text: unknown;
  updatedAt: unknown;
  receivedAtEpochMs: number;
};
const perClientRecaps: Map<string, RecapReceipt>[] = [];
const recapReceipts: RecapReceipt[] = [];
let recapPhase: Awaited<ReturnType<typeof runRecapBurst>> | undefined;
let gateway: ChildProcess | undefined;
let stressCronJobId: string | undefined;
function fieldBytes(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).map(([field, value]) => [
      field,
      Buffer.byteLength(JSON.stringify({ [field]: value })) - 2,
    ]),
  );
}
function measureFrameFields(
  event: { payload?: unknown },
  payload: Record<string, unknown>,
  frameBytes: number,
): FrameSizes {
  const wire = isRecord(payload.session) ? payload.session : undefined;
  const full =
    wire && isRecord(wire.full) ? wire.full : wire && !("base" in wire) ? wire : undefined;
  const fields = wire && isRecord(wire.set) ? wire.set : full;
  const result: FrameSizes = {
    frameBytes,
    payloadBytes: Buffer.byteLength(JSON.stringify(payload)),
    fields: fieldBytes(payload),
    ...(fields ? { sessionFields: fieldBytes(fields) } : {}),
  };
  if (full) {
    const sortedFields = Object.keys(full).toSorted();
    const duplicateFields = sortedFields.filter(
      (field) =>
        field !== "key" &&
        field !== "agentId" &&
        Object.hasOwn(payload, field) &&
        JSON.stringify(payload[field]) === JSON.stringify(full[field]),
    );
    const potential: Record<string, unknown> = {
      ...payload,
      sessionFieldRefs: duplicateFields.map((field) => sortedFields.indexOf(field)),
    };
    for (const field of duplicateFields) {
      delete potential[field];
    }
    result.duplicateEnvelopeFields = duplicateFields.length;
    result.potentialNumericRefsFrameBytes = Buffer.byteLength(
      JSON.stringify({ ...event, payload: potential }),
    );
  }
  return result;
}
const ownedListeners = new Set<ChildProcess>();
if (values["default-state-dir"] && path.basename(root) !== ".openclaw") {
  throw new Error("--default-state-dir requires a fixture rooted at <synthetic-home>/.openclaw");
}
const env = {
  ...createGatewayBenchEnv(path.join(root, "home"), configPath, { startupTrace: false }),
  ...(values["default-state-dir"]
    ? { OPENCLAW_HOME: path.dirname(root), OPENCLAW_STATE_DIR: undefined }
    : { OPENCLAW_STATE_DIR: root }),
  ...(values["attempt-setup-image"] && process.env.CONTAINERS_STORAGE_CONF
    ? { CONTAINERS_STORAGE_CONF: process.env.CONTAINERS_STORAGE_CONF }
    : {}),
  ...(values["attempt-setup-image"] && process.env.CONTAINERS_CONF
    ? { CONTAINERS_CONF: process.env.CONTAINERS_CONF }
    : {}),
  ...(values["attempt-setup-image"] && process.env.OPENCLAW_PATH_BOOTSTRAPPED === "1"
    ? { OPENCLAW_PATH_BOOTSTRAPPED: "1" }
    : {}),
  TMPDIR: path.join(root, "tmp"),
  OPENAI_API_KEY: "synthetic-fixture",
  ...(values["operator-model-policy"] && values["team-stress-allocation-sampling"]
    ? { OPENCLAW_BENCH_OPERATOR_MODEL_POLICY_COUNTS: "1" }
    : {}),
  ...(values["github-options-connected"]
    ? {
        GH_TOKEN: "synthetic-github-options",
        GITHUB_TOKEN: "synthetic-github-options",
        // Trusted-proxy local-call resolution selects the explicit/env password.
        OPENCLAW_GATEWAY_PASSWORD: fixtureDirectPassword,
        // Synthetic HTTPS origins are metadata only, including during worktree preparation.
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "protocol.https.allow",
        GIT_CONFIG_VALUE_0: "never",
      }
    : {}),
  OPENCLAW_PROFILE: values["default-state-dir"] ? "default" : `team-shape-${port}`,
  OPENCLAW_SYSTEMD_UNIT: `openclaw-gateway-team-shape-${port}`,
  ...(values["prep-trace"] ? { OPENCLAW_LOG_LEVEL: "trace" } : {}),
  ...(idleScenario ? { OPENCLAW_BENCH_FIRST_TEXT: "1" } : {}),
  ...(process.env.OPENCLAW_BENCH_RETAIN_TOOL_CONTEXT === "1"
    ? { OPENCLAW_BENCH_RETAIN_TOOL_CONTEXT: "1" }
    : {}),
  ...(process.env.OPENCLAW_BENCH_TOOL_EXECUTION_SOURCE
    ? { OPENCLAW_BENCH_TOOL_EXECUTION_SOURCE: process.env.OPENCLAW_BENCH_TOOL_EXECUTION_SOURCE }
    : {}),
  ...(values["broadcast-timing"] ? { OPENCLAW_BENCH_BROADCAST_TIMING: "1" } : {}),
  ...(process.env.OPENCLAW_BENCH_WORKER_ATTRIBUTION === "1"
    ? { OPENCLAW_BENCH_WORKER_ATTRIBUTION: "1" }
    : {}),
  ...(process.env.OPENCLAW_PERF_MEDIA_IO === "1" ? { OPENCLAW_PERF_MEDIA_IO: "1" } : {}),
  ...(process.env.OPENCLAW_PERF_FSYNC_DELAY_MS !== undefined
    ? { OPENCLAW_PERF_FSYNC_DELAY_MS: process.env.OPENCLAW_PERF_FSYNC_DELAY_MS }
    : {}),
  ...(values["session-projection-counts"] ? { OPENCLAW_BENCH_SESSION_PROJECTION_COUNTS: "1" } : {}),
  ...(values["disable-inlining"] ? { OPENCLAW_BENCH_DISABLE_INLINING: "1" } : {}),
  ...(sessionProjectionSource
    ? { OPENCLAW_BENCH_SESSION_PROJECTION_SOURCE: sessionProjectionSource }
    : {}),
  ...(values["worker-memory"] ? { OPENCLAW_BENCH_WORKER_MEMORY_DIR: output } : {}),
  ...(values["worker-snapshots"] ? { OPENCLAW_BENCH_WORKER_SNAPSHOTS: "1" } : {}),
  ...(values["worker-retained-heap"] ? { OPENCLAW_BENCH_RETAINED_WORKER_DIR: output } : {}),
  ...(values["worker-baseline-dir"]
    ? { OPENCLAW_BENCH_BASELINE_DIR: path.resolve(values["worker-baseline-dir"]) }
    : {}),
  ...(values["baseline-owners"] ? { OPENCLAW_BENCH_TRANSCRIPT_BASELINE_OWNERS: "1" } : {}),
  ...(values["github-observation-owner"]
    ? { OPENCLAW_BENCH_GITHUB_OBSERVATION_OWNER: path.resolve(values["github-observation-owner"]) }
    : {}),
  ...(values["github-availability-owner"]
    ? {
        OPENCLAW_BENCH_GITHUB_AVAILABILITY_OWNER: path.resolve(values["github-availability-owner"]),
      }
    : {}),
  ...(values["github-state-handlers"]
    ? { OPENCLAW_BENCH_GITHUB_STATE_HANDLERS: path.resolve(values["github-state-handlers"]) }
    : {}),
  ...(values["github-publication-reader"]
    ? {
        OPENCLAW_BENCH_GITHUB_PUBLICATION_READER: path.resolve(values["github-publication-reader"]),
      }
    : {}),
};
function launch(args: string[], name: string, extraEnv: NodeJS.ProcessEnv = {}, ipc = false) {
  const log = createWriteStream(path.join(output, `${name}.log`));
  const child = spawn(process.execPath, args, {
    env: { ...env, ...extraEnv },
    detached: true,
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.on("message", (message: unknown) => {
    if (
      isRecord(message) &&
      message.channel === "github-options-stage" &&
      typeof message.request === "number" &&
      typeof message.phase === "string" &&
      typeof message.startedAtEpochMs === "number" &&
      typeof message.durationMs === "number"
    ) {
      githubStages.push({
        request: message.request,
        phase: message.phase,
        startedAtEpochMs: message.startedAtEpochMs,
        durationMs: message.durationMs,
      });
    }
    if (
      isRecord(message) &&
      message.channel === "github-options-owner-loaded" &&
      typeof message.path === "string" &&
      typeof message.override === "boolean"
    ) {
      githubObservationOwner = { path: message.path, override: message.override };
    }
    if (
      isRecord(message) &&
      message.channel === "github-options-availability-loaded" &&
      typeof message.path === "string" &&
      typeof message.override === "boolean"
    ) {
      githubAvailabilityOwner = { path: message.path, override: message.override };
    }
    if (isRecord(message) && message.channel === "dashboard-github-fixture") {
      dashboardFixtureRequests++;
    }
    if (
      isRecord(message) &&
      message.channel === "dashboard-github-upstream" &&
      typeof message.route === "string" &&
      typeof message.sequence === "number" &&
      typeof message.startedAtEpochMs === "number" &&
      typeof message.durationMs === "number" &&
      typeof message.delayMs === "number" &&
      typeof message.status === "number"
    ) {
      githubFixtureRequests.push({
        phase: capturingColdSetup
          ? "setup/preflight"
          : measuring
            ? "measurement"
            : "outside-measurement",
        route: message.route,
        sequence: message.sequence,
        startedAtEpochMs: message.startedAtEpochMs,
        durationMs: message.durationMs,
        delayMs: message.delayMs,
        status: message.status,
        ...(typeof message.accountRevision === "number"
          ? { accountRevision: message.accountRevision }
          : {}),
      });
    }
    if (
      isRecord(message) &&
      message.channel === GATEWAY_PROFILE_CHANNEL &&
      message.kind === "agent-text" &&
      typeof message.atEpochMs === "number"
    ) {
      const turn = [...(cohort?.turns.values() ?? [])].find(
        (candidate) => candidate.runId === message.runId,
      );
      if (turn) {
        turn.firstTextMs ??= message.atEpochMs - performance.timeOrigin - turn.startedAt;
      }
    }
  });
  child.once("close", () => log.end());
  childLogs.push(log);
  if (values.allocations || values["stream-start-allocations"] || values["trace-gc"]) {
    // Keep stderr diagnostics from interleaving with V8's line-oriented GC trace.
    const stdoutLog = createWriteStream(path.join(output, `${name}.stdout.log`));
    child.stdout?.pipe(stdoutLog, { end: false });
    child.once("close", () => stdoutLog.end());
    childLogs.push(stdoutLog);
  }
  let startupOutput = "";
  const observeStartup = (data: Buffer) => {
    if (!ownedListeners.has(child)) {
      startupOutput = (startupOutput + data.toString()).slice(-4096);
      if (startupOutput.includes("http server listening (")) {
        ownedListeners.add(child);
      }
    }
  };
  child.stdout?.on("data", observeStartup);
  child.stderr?.on("data", observeStartup);
  children.push(child);
  return child;
}
function assertGatewayAlive() {
  if (!gateway || !gateway.connected || gateway.exitCode !== null || gateway.signalCode !== null) {
    throw new Error(`owned Gateway exited; inspect ${output}`);
  }
  if (subscriberFailure) {
    throw subscriberFailure;
  }
}
async function assertPortAvailable(targetPort: number) {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(targetPort, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
}
async function ready(targetPort: number, endpoint: string, owned?: ChildProcess) {
  // Loaded hosts can need several minutes for plugin startup; measurement starts after readiness.
  for (let attempt = 0; attempt < 1200; attempt++) {
    if (owned) {
      assertGatewayAlive();
      // Preflight is best effort; the owned bind-success log handles another process taking the port.
      if (!ownedListeners.has(owned)) {
        await delay(500);
        continue;
      }
    }
    try {
      if ((await fetch(`http://127.0.0.1:${targetPort}${endpoint}`)).ok) {
        if (owned) {
          assertGatewayAlive();
        }
        return;
      }
    } catch {
      /* Startup has no listener yet. */
    }
    await delay(500);
  }
  throw new Error(`listener ${targetPort} did not become ready; inspect ${output}`);
}
const parentKey = verifyHistoryReplay
  ? "agent:main:memory-soak-history-parent"
  : "agent:main:transcript-broadcast-measure-parent";
const diffTargets =
  stressWorktree && diffControlOriginal !== undefined
    ? [{ sessionKey: parentKey, worktree: stressWorktree, original: diffControlOriginal }]
    : [];
if (values["dashboard-rpc"] && Array.isArray(fixture.projectWorktrees)) {
  for (const [index, item] of fixture.projectWorktrees.slice(1).entries()) {
    if (!isRecord(item) || typeof item.path !== "string") {
      throw new Error("Dashboard diffs require registered fixture worktrees");
    }
    const worktree = realpathSync(item.path);
    if (
      !worktree.startsWith(`${realpathSync(root)}${path.sep}`) ||
      !readFileSync(path.join(worktree, ".git"), "utf8").startsWith("gitdir: ")
    ) {
      throw new Error("Dashboard diff worktree must be linked and inside the synthetic fixture");
    }
    diffTargets.push({
      sessionKey: `agent:main:transcript-broadcast-diff-${index + 1}`,
      worktree,
      original: readFileSync(path.join(worktree, "README.md"), "utf8"),
    });
  }
}
function readManagedWorktree(created: unknown): string {
  if (
    !isRecord(created) ||
    !isRecord(created.entry) ||
    !isRecord(created.entry.worktree) ||
    typeof created.entry.worktree.id !== "string" ||
    typeof created.entry.sessionRoot !== "string"
  ) {
    throw new Error("Synthetic session requires a session-owned managed worktree");
  }
  const worktree = realpathSync(created.entry.sessionRoot);
  if (
    !worktree.startsWith(`${realpathSync(root)}${path.sep}`) ||
    !readFileSync(path.join(worktree, ".git"), "utf8").startsWith("gitdir: ")
  ) {
    throw new Error("Managed worktree must be linked and inside the synthetic fixture");
  }
  return worktree;
}
function bindConnectedOptionsWorktree(target: (typeof diffTargets)[number], created: unknown) {
  const worktree = readManagedWorktree(created);
  target.worktree = worktree;
  target.original = readFileSync(path.join(worktree, "README.md"), "utf8");
}
const dashboardRpcShapes = values["dashboard-rpc"]
  ? [
      { method: "board.get", params: { sessionKey: parentKey } },
      { method: "workboard.boards.list", params: {} },
      { method: "workboard.cards.list", params: { boardId: dashboardBoardId } },
      { method: "sessions.github.options", params: { sessionKey: parentKey } },
      { method: "github.preview", params: { url: dashboardPreviewUrl } },
      { method: "models.list", params: { agentId: "main" } },
      { method: "models.authStatus", params: { agentId: "main" } },
      { method: "sessions.describe", params: { key: parentKey } },
      {
        method: "controlUi.sessionPullRequests.subscribe",
        params: { sessionKeys: [parentKey] },
      },
    ]
  : [];
const mixedRpcMethods = [
  "sessions.list",
  "chat.history",
  ...(values["team-stress"] ? ["chat.startup"] : []),
  "sessions.diff",
  ...(values["worktree-tool-churn"] ? [] : ["connect"]),
  ...(values["node-policy-churn"] ? ["node.list", "node.describe", "node.invoke"] : []),
  ...(values["team-stress"] ? Array<string>(teamStressListWeight - 1).fill("sessions.list") : []),
  ...dashboardRpcShapes.map(({ method }) => method),
  ...(values["usage-rpc"] ? ["usage.cost", "sessions.usage"] : []),
];
const stressParentKey = "agent:main:transcript-broadcast-measure-native-parent";
const keys = Array.from({ length: sessionCount }, (_, index) =>
  verifyHistoryReplay
    ? `agent:main:memory-soak-history-child-${index}`
    : values["turn-start-phases"]
      ? `agent:main:transcript-broadcast-measure-${port}-child-${index}`
      : `agent:main:transcript-broadcast-measure-child-${index}`,
);
const historyNamespace = verifyHistoryReplay ? "memory-soak-history" : "reopen-history";
const historySeedPath = path.join(root, `${historyNamespace}.json`);
if (values["seed-history"]) {
  // Run offline, separately from measurement, using the transcript append owner.
  mkdirSync(path.join(root, `${historyNamespace}-seed`));
  process.env = { ...env };
  const [
    { SessionManager },
    { upsertSessionEntryCore, loadExactSessionEntry },
    { resolveOpenClawAgentSqlitePath },
    agentDb,
    stateDb,
    lifecycle,
    { waitForTeamShapeWriteBudget },
    { buildOpenAIResponsesReasoningReplayMetadata },
  ] = await Promise.all([
    import("../../src/agents/sessions/session-manager.js"),
    import("../../src/config/sessions/session-accessor.js"),
    import("../../src/state/openclaw-agent-db.paths.js"),
    import("../../src/state/openclaw-agent-db.js"),
    import("../../src/state/openclaw-state-db.js"),
    import("../../src/shared/global-singleton.js"),
    import("./team-shape-sessions.js"),
    import("../../packages/ai/src/transports/openai-responses-compaction-replay.js"),
  ]);
  try {
    if (soakScenario) {
      await waitForTeamShapeWriteBudget();
    }
    const timestamp = Number(fixture.now);
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
    const parentTarget = { agentId: "main", sessionKey: parentKey, storePath, env };
    if (loadExactSessionEntry(parentTarget)) {
      throw new Error(`Synthetic ${historyNamespace} parent already exists`);
    }
    await upsertSessionEntryCore(parentTarget, {
      sessionId: `${historyNamespace}-parent`,
      updatedAt: timestamp,
      createdAt: timestamp,
      lifecycleRevision: `${historyNamespace}-v1`,
      createdVia: "operator",
      visibility: "shared",
      ...(verifyHistoryReplay && stressWorktree ? { spawnedCwd: stressWorktree } : {}),
    });
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    for (const [index, sessionKey] of keys.entries()) {
      const sessionId = `${historyNamespace}-${index}`;
      const target = { agentId: "main", sessionId, sessionKey, storePath, env };
      if (loadExactSessionEntry(target)) {
        throw new Error(`Synthetic ${historyNamespace} session already exists: ${sessionKey}`);
      }
      await upsertSessionEntryCore(target, {
        sessionId,
        createdAt: timestamp,
        updatedAt: timestamp,
        lifecycleRevision: `${historyNamespace}-v1`,
        createdVia: "operator",
        visibility: "shared",
        parentSessionKey: parentKey,
        parentSessionId: `${historyNamespace}-parent`,
        parentSessionLifecycleRevision: `${historyNamespace}-v1`,
        spawnDepth: 1,
        ...(verifyHistoryReplay && stressWorktree ? { spawnedCwd: stressWorktree } : {}),
      });
      const manager = await SessionManager.openAsync(
        target,
        verifyHistoryReplay && stressWorktree ? stressWorktree : path.join(root, "workspace"),
      );
      await manager.appendModelChange("openai", "gpt-4.1");
      await manager.appendThinkingLevelChange("off");
      const turns = index === keys.length - 1 && historyLastTurns ? historyLastTurns : historyTurns;
      const reasoningReplayMetadata = verifyHistoryReplay
        ? buildOpenAIResponsesReasoningReplayMetadata(
            {
              ...cfg.models.providers.openai.models[0],
              provider: "openai",
              baseUrl: cfg.models.providers.openai.baseUrl,
            },
            { sessionId },
          )
        : undefined;
      for (let turn = 0; turn < turns; turn++) {
        if (soakScenario && turn % 50 === 0) {
          await waitForTeamShapeWriteBudget();
        }
        const thinking = (phase: "tool" | "answer") => {
          if (!verifyHistoryReplay && (!historyPayloadBytes || phase === "answer")) {
            return [];
          }
          return [
            {
              type: "thinking" as const,
              thinking: verifyHistoryReplay
                ? "Inspecting the synthetic history fixture."
                : `Synthetic reasoning ${turn}.`,
              ...(verifyHistoryReplay ? { openclawReasoningReplay: reasoningReplayMetadata } : {}),
              thinkingSignature: JSON.stringify({
                type: "reasoning",
                id: verifyHistoryReplay
                  ? `rs_soak_history_${index}_${turn}_${phase}`
                  : `rs_fixture_${index}_${turn}`,
                ...(verifyHistoryReplay ? { status: "completed" } : {}),
                summary: [],
                encrypted_content: verifyHistoryReplay
                  ? historyReasoningContent(index, turn, phase)
                  : promptContent.update(Buffer.alloc(historyPayloadBytes / 2)).toString("hex"),
              }),
            },
          ];
        };
        const callId = `fixture-${turn}`;
        const assistant = {
          role: "assistant" as const,
          api: "openai-responses" as const,
          provider: "openai",
          model: "gpt-4.1",
          usage,
          timestamp: timestamp + turn,
        };
        await manager.appendMessageAsync({
          role: "user",
          content: `Inspect synthetic file ${turn}.`,
          timestamp: timestamp + turn,
        });
        await manager.appendMessageAsync({
          ...assistant,
          stopReason: "toolUse",
          content: [
            ...thinking("tool"),
            { type: "toolCall", id: callId, name: "read", arguments: { path: "fixture.txt" } },
          ],
        });
        await manager.appendMessageAsync({
          role: "toolResult",
          toolCallId: callId,
          toolName: "read",
          isError: false,
          content: [
            {
              type: "text",
              text: `Synthetic file ${turn}.\n${
                historyPayloadBytes
                  ? promptContent.update(Buffer.alloc(historyPayloadBytes / 2)).toString("hex")
                  : "Fixture content. ".repeat(128)
              }`,
            },
          ],
          timestamp: timestamp + turn,
        });
        await manager.appendMessageAsync({
          ...assistant,
          stopReason: "stop",
          content: [
            ...thinking("answer"),
            { type: "text", text: `Synthetic inspection ${turn} complete.` },
          ],
        });
      }
      console.log(`SEEDED ${index + 1}/${sessionCount}`);
    }
    if (soakScenario) {
      await waitForTeamShapeWriteBudget();
    }
    writeFileSync(
      historySeedPath,
      JSON.stringify({
        sessionCount,
        historyTurns,
        historyLastTurns,
        historyPayloadBytes,
        verifyHistoryReplay,
        ...(values["turn-start-phases"] ? { turnStartPort: port } : {}),
        ...(verifyHistoryReplay ? { modelBaseUrl: cfg.models.providers.openai.baseUrl } : {}),
      }),
    );
  } finally {
    await agentDb.closeOpenClawAgentDatabasesAsync();
    await stateDb.closeOpenClawStateDatabaseAsync();
    await lifecycle.drainGlobalSingletonLifecycleState();
  }
  process.exit(0);
}
if (historyTurns) {
  const seeded = JSON.parse(readFileSync(historySeedPath, "utf8"));
  if (
    seeded.sessionCount !== sessionCount ||
    seeded.historyTurns !== historyTurns ||
    (seeded.historyLastTurns ?? 0) !== historyLastTurns ||
    (seeded.historyPayloadBytes ?? 0) !== historyPayloadBytes ||
    (values["turn-start-phases"] && seeded.turnStartPort !== port)
  ) {
    throw new Error("Run --seed-history with matching session count and history options first");
  }
  if (verifyHistoryReplay && seeded.modelBaseUrl !== cfg.models.providers.openai.baseUrl) {
    throw new Error("Deep-history reasoning replay requires the same --mock-port used to seed it");
  }
}
const connectParams = {
  minProtocol: PROTOCOL_VERSION,
  maxProtocol: PROTOCOL_VERSION,
  client: {
    id: proxyViewers || trustedProxyScenario ? "openclaw-control-ui" : "gateway-client",
    displayName: "synthetic-broadcast-measurement",
    version: "1.0.0",
    platform: process.platform,
    mode: proxyViewers ? "ui" : trustedProxyScenario ? "webchat" : "backend",
  },
  role: "operator",
  scopes: ["operator.read", "operator.admin"],
  caps: [
    "session-scoped-events",
    "chat-only-assistant-text",
    ...(!rosterBodyOptionalCounts && exactClients < clientCount
      ? ["roster-message-bodies-optional"]
      : []),
    ...(values["presence-deltas"] ? ["presence-deltas"] : []),
  ],
};
const sessionCapabilityCohorts = [
  [],
  ["session-row-deltas"],
  ["session-row-deltas", "session-event-field-refs"],
].map((caps, index) => {
  const cohortClientCount =
    sessionCapabilityCounts?.[index] ??
    (index === (values["session-envelope-refs"] ? 2 : values["session-row-deltas"] ? 1 : 0)
      ? clientCount
      : 0);
  return {
    caps,
    clients: cohortClientCount,
    exactClients: 0,
    rosterBodyOptionalClients:
      rosterBodyOptionalCounts?.[index] ?? (exactClients < clientCount ? cohortClientCount : 0),
  };
});
const clientConnectParams: (typeof connectParams)[] = [];
for (let offset = 0; clientConnectParams.length < clientCount; offset++) {
  for (const capabilityCohort of sessionCapabilityCohorts) {
    if (offset < capabilityCohort.clients) {
      if (clientConnectParams.length < exactClients) {
        capabilityCohort.exactClients++;
      }
      clientConnectParams.push({
        ...connectParams,
        caps: [
          ...connectParams.caps,
          ...capabilityCohort.caps,
          ...(rosterBodyOptionalCounts && offset < capabilityCohort.rosterBodyOptionalClients
            ? ["roster-message-bodies-optional"]
            : []),
        ],
      });
    }
  }
}
async function controlAuthorityCounters(child: ChildProcess, action: "start" | "stop") {
  const id = randomUUID();
  const response = Promise.withResolvers<unknown>();
  const onMessage = (message: unknown) => {
    if (isRecord(message) && message.channel === authorityChannel && message.id === id) {
      response.resolve(message);
    }
  };
  child.on("message", onMessage);
  const timeout = setTimeout(
    () => response.reject(new Error("Authority counter IPC timed out")),
    10000,
  );
  try {
    child.send({ channel: authorityChannel, id, action }, (error) => {
      if (error) {
        response.reject(error);
      }
    });
    const message = await response.promise;
    if (
      !isRecord(message) ||
      !isRecord(message.counts) ||
      typeof message.profileId !== "string" ||
      message.profileId === "gateway-owner"
    ) {
      throw new Error("Authority probe did not attest a non-owner operator");
    }
    const counts = message.counts;
    const count = (key: string) => {
      const value = counts[key];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Invalid authority counter ${key}`);
      }
      return value;
    };
    return {
      ...(values["authority-counts"]
        ? {
            host: (() => {
              if (!isRecord(message.hostCounts) || !isRecord(message.installed)) {
                throw new Error("Authority source counters were not installed");
              }
              const entries = Object.entries(message.hostCounts);
              if (entries.some(([, value]) => !Number.isSafeInteger(value) || Number(value) < 0)) {
                throw new Error("Invalid authority source counts");
              }
              return {
                counts: message.hostCounts,
                callers: message.hostCallers,
                installed: message.installed,
                firstAuthPolicyStacks: message.firstAuthPolicyStacks,
              };
            })(),
          }
        : {}),
      sourceOverlay: isRecord(message.sourceOverlay) ? message.sourceOverlay : undefined,
      scopeCounts: isRecord(message.scopeCounts) ? message.scopeCounts : undefined,
      profileId: message.profileId,
      authorize: count("authorize"),
      resume: count("resume"),
      assert: count("assert"),
      tools: count("tools"),
      transcriptUpdates: count("transcriptUpdates"),
      messageAppends: count("messageAppends"),
    };
  } finally {
    clearTimeout(timeout);
    child.off("message", onMessage);
  }
}
async function controlTeamStressTelemetry(child: ChildProcess, action: "start" | "stop") {
  await new Promise<void>((resolve, reject) => {
    const pending = new Set([
      "team-shape-stress",
      ...(action === "stop" && values["exec-io-storm"] ? ["agent-exec-io"] : []),
    ]);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", finish);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onMessage = (message: unknown) => {
      if (
        !isRecord(message) ||
        typeof message.channel !== "string" ||
        !pending.has(message.channel) ||
        message.action !== action
      ) {
        return;
      }
      if (message.ok !== true) {
        finish(new Error(`Team stress telemetry ${action}: ${String(message.error)}`));
      } else {
        pending.delete(message.channel);
        if (pending.size === 0) {
          finish();
        }
      }
    };
    const onExit = () => finish(new Error(`Gateway exited during Team stress telemetry ${action}`));
    const timeout = setTimeout(
      () => finish(new Error(`Team stress telemetry ${action} timed out`)),
      action === "stop" && values["team-stress-retention-sampling"] ? 600_000 : 60_000,
    );
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", finish);
    child.send(
      {
        channel: "team-shape-stress",
        action,
        output,
        allocations: values["team-stress-allocation-sampling"],
        retention: values["team-stress-retention-sampling"],
      },
      (error) => {
        if (error) {
          finish(error);
        }
      },
    );
  });
}
function summarizeLatencies(latencies: number[]) {
  const sorted = latencies.toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    p99: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
    max: sorted.at(-1) ?? null,
    latencies,
  };
}
function validateDiff(result: unknown, additions = 1, worktree = stressWorktree) {
  if (
    !isRecord(result) ||
    result.root !== worktree ||
    result.unavailableReason !== undefined ||
    !Array.isArray(result.files) ||
    !result.files.some(
      (file: unknown) =>
        isRecord(file) && file.path === "README.md" && file.additions === additions,
    )
  ) {
    throw new Error(
      `sessions.diff did not return the synthetic worktree control (${additions} added lines): ${JSON.stringify(result)}`,
    );
  }
}
function validateDashboardRpc(method: string, result: unknown) {
  if (!isRecord(result)) {
    throw new Error(`${method} returned no dashboard response`);
  }
  const hasRows = (field: string) => Array.isArray(result[field]) && result[field].length > 0;
  const valid =
    method === "board.get"
      ? hasRows("widgets")
      : method === "workboard.boards.list"
        ? Array.isArray(result.boards) &&
          result.boards.some((board: unknown) => isRecord(board) && board.id === dashboardBoardId)
        : method === "workboard.cards.list"
          ? hasRows("cards")
          : method === "github.preview"
            ? result.title === dashboardPreviewTitle && result.url === dashboardPreviewUrl
            : method === "models.list"
              ? hasRows("models")
              : method === "models.authStatus"
                ? Array.isArray(result.providers)
                : method === "sessions.describe"
                  ? isRecord(result.session) && result.session.key === parentKey
                  : method === "controlUi.sessionPullRequests.subscribe"
                    ? result.subscribed === true
                    : "personal" in result &&
                      "shared" in result &&
                      (!values["github-options-connected"] ||
                        (isRecord(result.shared) &&
                          result.shared.accountId === 1516 &&
                          ["synthetic-shared", "synthetic-shared-updated"].includes(
                            String(result.shared.login),
                          ) &&
                          result.sharedUnavailableReason === undefined));
  if (!valid) {
    throw new Error(`${method} did not return the expected synthetic dashboard data`);
  }
}
async function rpc(
  client: ReturnType<typeof createGatewayWsClient>,
  method: string,
  params: unknown,
  onResponse?: (id: string) => void,
) {
  assertGatewayAlive();
  const started = performance.now();
  let response: Awaited<ReturnType<typeof client.request>>;
  try {
    response = await client.request(method, params, 180_000);
  } catch (error) {
    recordTeamStressRpc(method, performance.now() - started, false);
    throw error;
  }
  const rpcDurationMs = performance.now() - started;
  recordTeamStressRpc(method, rpcDurationMs, response.ok);
  assertGatewayAlive();
  if (!response.ok) {
    throw new Error(`${method}: ${JSON.stringify(response.error)}`);
  }
  if (
    method === "chat.send" &&
    (!isRecord(params) ||
      !isRecord(response.payload) ||
      response.payload.status !== "started" ||
      response.payload.runId !== params.idempotencyKey)
  ) {
    throw new Error("chat.send did not acknowledge the requested fresh turn");
  }
  if (values["github-options-connected"] && method === "sessions.github.options") {
    validateDashboardRpc(method, response.payload);
    if (
      isRecord(params) &&
      typeof params.sessionKey === "string" &&
      isRecord(response.payload) &&
      isRecord(response.payload.shared) &&
      typeof response.payload.shared.login === "string"
    ) {
      githubOptionsObservations.push({
        phase: capturingColdSetup
          ? "setup/preflight"
          : measuring
            ? "measurement"
            : "outside-measurement",
        sessionKey: params.sessionKey,
        startedAtEpochMs: performance.timeOrigin + started,
        durationMs: rpcDurationMs,
        stale: response.payload.stale === true,
        login: response.payload.shared.login,
      });
    }
  }
  if (capturingColdSetup) {
    const sessionKey = isRecord(params) ? (params.sessionKey ?? params.key) : undefined;
    coldSetupRpc.push({
      phase: "setup/preflight",
      method,
      startedAtEpochMs: performance.timeOrigin + started,
      durationMs: rpcDurationMs,
      ...(typeof sessionKey === "string" ? { sessionKey } : {}),
    });
  }
  if (
    method === "sessions.messages.subscribe" &&
    (!isRecord(params) ||
      !isRecord(response.payload) ||
      response.payload.subscribed !== true ||
      response.payload.key !== params.key ||
      response.payload.agentId !== "main")
  ) {
    throw new Error(
      "sessions.messages.subscribe did not acknowledge the requested fixture session",
    );
  }
  if (measuring) {
    const measured: RpcMeasurement = rpcMeasurements.get(method) ?? {
      latenciesMs: [],
      responseBytes: 0,
    };
    const bytes = responseFrameBytes.get(client)?.get(response.id);
    if (bytes === undefined) {
      throw new Error(`missing wire response size for ${method}`);
    }
    if (values["capture-responses"] && measured.latenciesMs.length === 0) {
      measured.representativeResponse = { payload: response.payload };
    }
    measured.latenciesMs.push(rpcDurationMs);
    measured.responseBytes += bytes;
    rpcMeasurements.set(method, measured);
    responseFrameBytes.get(client)?.delete(response.id);
  }
  onResponse?.(response.id);
  return response.payload;
}
function latencySummary(latenciesMs: number[]) {
  const sorted = latenciesMs.toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
    maxMs: sorted.at(-1) ?? null,
    latenciesMs,
  };
}
function readPromotion(profilePath: string, operationCount: number) {
  const gcTrace = readGatewayGcTrace(path.join(output, "gateway.stdout.log"), profilePath);
  return { gcTrace, promotedBytesPerOperation: gcTrace.promotedBytes / operationCount };
}
function readAuthorityAllocation(profilePath: string, operationCount: number) {
  // Node's inspector declarations omit the CDP sample IDs emitted by heap sampling.
  type AllocationNode = {
    id: number;
    callFrame: HeapProfiler.SamplingHeapProfileNode["callFrame"];
    selfSize: number;
    children: AllocationNode[];
  };
  const profile: { head: AllocationNode; samples: { nodeId: number }[] } = JSON.parse(
    readFileSync(profilePath, "utf8"),
  );
  const owners = new Set([
    "session-source-authority",
    "admitted-run-context",
    "operator-run-authority",
    "session-event-handoff",
  ]);
  const families: Record<string, { sampledBytes: number; sampleCount: number }> = {};
  const sampleCounts = new Map<number, number>();
  for (const sample of profile.samples) {
    sampleCounts.set(sample.nodeId, (sampleCounts.get(sample.nodeId) ?? 0) + 1);
  }
  const visit = (node: AllocationNode, parents: string[]) => {
    const owner = node.callFrame.url.match(/\/([^/]+)\.(?:ts|js)$/)?.[1] ?? "";
    const stack = [...parents, owner].slice(-8);
    const family = stack.find((name) => owners.has(name));
    if (family) {
      const bucket = (families[family] ??= { sampledBytes: 0, sampleCount: 0 });
      bucket.sampledBytes += node.selfSize;
      bucket.sampleCount += sampleCounts.get(node.id) ?? 0;
    }
    for (const child of node.children) {
      visit(child, stack);
    }
  };
  visit(profile.head, []);
  const sampledBytes = Object.values(families).reduce(
    (sum, family) => sum + family.sampledBytes,
    0,
  );
  return {
    scope:
      "outermost authority owner in each eight-frame allocation stack; main isolate, including collected objects",
    operationCount,
    sampledBytes,
    estimatedBytesPerTurn: sampledBytes / operationCount,
    sampleCount: Object.values(families).reduce((sum, family) => sum + family.sampleCount, 0),
    families,
  };
}
function sessionPatchParams(index: number, sequence: number): SessionsPatchParams {
  const changes: Omit<SessionsPatchParams, "key">[] = [
    { label: `Synthetic patch ${index} ${sequence}` },
    { statusNote: `Synthetic progress ${sequence}`, ttlMinutes: 5 },
    { model: "openai/gpt-4.1-mini" },
    { label: null },
    { statusNote: null },
    { model: null },
  ];
  return { key: patchKeys[index]!, ...changes[sequence % changes.length] };
}
function assertSessionPatch(params: SessionsPatchParams, result: unknown) {
  if (
    !isRecord(result) ||
    result.ok !== true ||
    result.key !== params.key ||
    !isRecord(result.entry)
  ) {
    throw new Error("sessions.patch did not return the committed fixture session");
  }
  const entry = result.entry;
  if ("label" in params && entry.label !== (params.label ?? undefined)) {
    throw new Error("sessions.patch did not apply the requested label");
  }
  if ("statusNote" in params) {
    const note = isRecord(entry.agentStatus) ? entry.agentStatus.note : undefined;
    if (note !== (params.statusNote ?? undefined)) {
      throw new Error("sessions.patch did not apply the requested status note");
    }
  }
  if (
    "model" in params &&
    (!isRecord(result.resolved) ||
      result.resolved.modelProvider !== "openai" ||
      result.resolved.model !== (params.model ? "gpt-4.1-mini" : "gpt-4.1"))
  ) {
    throw new Error("sessions.patch did not apply the requested model selection");
  }
}
function assertListPage(
  page: unknown,
  method: string,
): asserts page is { totalCount: number; count: number; sessions: unknown[] } {
  if (
    !isRecord(page) ||
    typeof page.totalCount !== "number" ||
    page.count !== Math.min(limit, page.totalCount) ||
    !Array.isArray(page.sessions) ||
    page.sessions.length !== page.count ||
    page.count === 0
  ) {
    throw new Error(`${method} did not return the requested nonempty page`);
  }
}
function sidebarIdentity(page: unknown) {
  assertListPage(page, "sessions.list");
  return JSON.stringify({
    totalCount: page.totalCount,
    sessions: page.sessions.map((row) => {
      if (!isRecord(row) || typeof row.key !== "string") {
        throw new Error("sidebar response contains an invalid session row");
      }
      return [row.key, row.sessionId, row.updatedAt];
    }),
  });
}
function summarizeCpuProfile(profilePath: string) {
  const profile: Profiler.Profile = JSON.parse(readFileSync(profilePath, "utf8"));
  const nodes = new Map(profile.nodes.map((node) => [node.id, node.callFrame]));
  const childNodes = new Map(profile.nodes.map((node) => [node.id, node.children ?? []]));
  const broadcastNodes = new Set<number>();
  const pending = profile.nodes
    .filter((node) => node.callFrame.functionName === "broadcastInternal")
    .map((node) => node.id);
  while (pending.length) {
    const id = pending.pop()!;
    broadcastNodes.add(id);
    pending.push(...(childNodes.get(id) ?? []));
  }
  let broadcastSampledMs = 0;
  const sites = new Map<
    string,
    { frame: Profiler.ProfileNode["callFrame"]; sampledSelfMs: number }
  >();
  for (const [index, id] of (profile.samples ?? []).entries()) {
    const frame = nodes.get(id);
    if (!frame) {
      continue;
    }
    const key = JSON.stringify(frame);
    const site = sites.get(key) ?? { frame, sampledSelfMs: 0 };
    const sampledMs = (profile.timeDeltas?.[index] ?? 1000) / 1000;
    site.sampledSelfMs += sampledMs;
    if (broadcastNodes.has(id)) {
      broadcastSampledMs += sampledMs;
    }
    sites.set(key, site);
  }
  return {
    ...readGatewayCpuProfile(profilePath),
    broadcastSampledMs,
    topSelfTime: [...sites.values()]
      .toSorted((left, right) => right.sampledSelfMs - left.sampledSelfMs)
      .slice(0, 40),
  };
}
async function startStressSubagent(
  client: ReturnType<typeof createGatewayWsClient>,
  current: NonNullable<typeof cohort>,
) {
  teamStressFanout?.trackForeground([stressParentKey], false);
  await rpc(client, "sessions.reset", { key: stressParentKey });
  let releaseChild!: () => void;
  const childReady = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const state: StressSubagent = {
    parentPrompt: `LANE1486_PARENT_${current.id}`,
    childPrompt: `LANE1486_CHILD_${current.id}`,
    childResult: `LANE1486_CHILD_RESULT_${current.id}`,
    parentAck: `LANE1486_PARENT_ACK_${current.id}`,
    spawnCallId: `call_stress_spawn_${current.id}`,
    yieldCallId: `call_stress_yield_${current.id}`,
    phase: "initial",
    childRequests: 0,
    yieldObserved: false,
    cancelled: false,
    releaseChild,
    childReady,
    cohortReady: current.ready,
  };
  stressSubagent = state;
  const started = performance.now();
  await rpc(client, "agent", {
    sessionKey: stressParentKey,
    message: state.parentPrompt,
    deliver: false,
    idempotencyKey: randomUUID(),
  });
  return { state, started };
}
async function finishStressSubagent(
  client: ReturnType<typeof createGatewayWsClient>,
  work: Awaited<ReturnType<typeof startStressSubagent>>,
) {
  const { state, started } = work;
  let childCompleted = false;
  while (performance.now() - started < 180_000) {
    assertGatewayAlive();
    const history = await rpc(client, "chat.history", { sessionKey: stressParentKey, limit: 100 });
    if (!isRecord(history) || !Array.isArray(history.messages)) {
      throw new Error("stress subagent parent history is missing");
    }
    if (!state.yieldObserved) {
      const blocks = history.messages.flatMap((message) =>
        isRecord(message)
          ? [message, ...(Array.isArray(message.content) ? message.content.filter(isRecord) : [])]
          : [],
      );
      const yielded = blocks.find(
        (block) =>
          block.toolCallId === `${state.yieldCallId}|fc_${state.yieldCallId}` &&
          block.toolName === "sessions_yield",
      );
      if (yielded) {
        const receipt: unknown = JSON.parse(contentText(yielded.content));
        if (!isRecord(receipt) || receipt.status !== "yielded" || !state.accepted) {
          throw new Error("stress subagent parent did not persist a successful yield");
        }
        state.yieldObserved = true;
        // Observe the real child run before cleanup can retire its session.
        const completion = rpc(client, "agent.wait", {
          runId: state.accepted.runId,
          timeoutMs: 170_000,
        });
        state.releaseChild();
        const result = await completion;
        if (!isRecord(result) || result.status !== "ok") {
          throw new Error("stress subagent child did not complete successfully");
        }
        childCompleted = true;
      }
    }
    const ack = history.messages.find(
      (message) =>
        isRecord(message) &&
        message.role === "assistant" &&
        contentText(message.content).trim() === state.parentAck,
    );
    if (ack) {
      const metadata = ack["__openclaw"];
      const runId = isRecord(metadata) ? metadata.runId : undefined;
      if (state.phase !== "ack-issued" || !childCompleted || typeof runId !== "string") {
        throw new Error("stress subagent parent acknowledgment lacks completed run evidence");
      }
      const result = await rpc(client, "agent.wait", { runId, timeoutMs: 170_000 });
      if (!isRecord(result) || result.status !== "ok") {
        throw new Error("stress subagent parent continuation did not complete successfully");
      }
      return {
        childRunId: state.accepted!.runId,
        childSessionKey: state.accepted!.childSessionKey,
        parentContinuationRunId: runId,
        parentYielded: true,
        childCompleted: true,
        parentResultObserved: true,
        parentAcknowledgmentPersisted: true,
        durationMs: performance.now() - started,
      };
    }
    await delay(250);
  }
  throw new Error(`stress subagent completion timed out in phase ${state.phase}`);
}
let completedSoakRounds = 0;
let sessionResets = 0;
let teamStressWrites = 0;
async function runRound(
  client: ReturnType<typeof createGatewayWsClient>,
  measuredRound?: number,
  roundKeys = keys,
) {
  if (values["turn-start-rich-context"]) {
    for (const key of roundKeys) {
      richContextSessionKeys.add(key);
    }
  }
  teamStressFanout?.trackForeground(roundKeys);
  const cronOperatorJob = values["cron-operator-turn"] ? cronOperatorJobs[0] : undefined;
  if (values["cron-operator-turn"] && !cronOperatorJob?.id) {
    throw new Error("Cron operator fixture is not ready");
  }
  if (
    retentionScenario ||
    (soakScenario &&
      resetEveryRounds > 0 &&
      (measuredRound ?? completedSoakRounds) % resetEveryRounds === 0)
  ) {
    // Retire each previous session generation so retained history is not the measurement.
    for (const key of keys) {
      await rpc(client, "sessions.reset", { key });
      sessionResets++;
    }
    sessionStoreValues.clear();
  }
  const child = gateway;
  if (!child) {
    throw new Error("owned Gateway is unavailable");
  }
  const profilePath =
    measuredRound !== undefined && values["cpu-profile"]
      ? path.join(output, `stream-start-${measuredRound}.cpuprofile`)
      : undefined;
  if (profilePath) {
    await controlGatewayProfile(child, "cpu", "start", profilePath);
  }
  const heapProfilePath =
    measuredRound !== undefined && values["stream-start-allocations"]
      ? path.join(output, `stream-start-${measuredRound}.heapprofile`)
      : undefined;
  const deliveredSessionEvents = () =>
    (perClientCounters[0]?.get("session.message") ?? 0) +
    (perClientCounters[0]?.get("sessions.changed") ?? 0);
  const eventsBeforeProfile = deliveredSessionEvents();
  if (heapProfilePath) {
    await controlGatewayProfile(child, "heap", "start", heapProfilePath);
  }
  let finishAdmissionDiagnostics =
    measuredRound !== undefined && values["stream-start-diagnostics"]
      ? await startGatewayDiagnostics(child, `stream-admission-${measuredRound}`)
      : undefined;
  if (finishAdmissionDiagnostics) {
    // Prime the 20 ms loop-delay timer before admitting the measured burst.
    await delay(25);
    await readGatewayCpuUsage(child);
  }
  let finishReleaseDiagnostics: typeof finishAdmissionDiagnostics;
  let admissionDiagnostics: ReturnType<ReturnType<typeof startGatewayBenchDiagnostics>> | undefined;
  let capture:
    | {
        cpuProfile?: ReturnType<typeof summarizeCpuProfile>;
        heapProfile?: ReturnType<typeof readGatewayHeapProfile>;
        observedSessionPublications?: number;
        admissionDiagnostics?: typeof admissionDiagnostics;
        releaseDiagnostics?: typeof admissionDiagnostics;
      }
    | undefined;
  let release!: () => void;
  let reject!: (error: Error) => void;
  const cohortReady = new Promise<void>((resolve, rejectReady) => {
    release = resolve;
    reject = rejectReady;
  });
  cohort = {
    id: randomUUID(),
    expectedCount: roundKeys.length,
    arrivals: new Set(),
    turns: new Map(),
    toolCallIds: new Set(),
    completedToolCallIds: new Set(),
    outputLimited: new Set(),
    requestPhases: new Map(),
    reasoningSignatures: new Map(),
    incompleteReasoningSignatures: new Map(),
    phases: { admissionStartedAtEpochMs: epochNow() },
    beforeRelease: finishAdmissionDiagnostics
      ? async () => {
          admissionDiagnostics = await finishAdmissionDiagnostics?.();
          finishAdmissionDiagnostics = undefined;
          finishReleaseDiagnostics = await startGatewayDiagnostics(
            child,
            `stream-release-${measuredRound}`,
          );
          await delay(25);
          await readGatewayCpuUsage(child);
        }
      : undefined,
    ready: cohortReady,
    release,
    reject,
  };
  const current = cohort;
  const activeInputs: {
    sessionKey: string;
    runId: string;
    message: string;
    terminal: Promise<string>;
  }[] = [];
  const createActiveInput = (sessionKey: string, message: string) => {
    const runId = randomUUID();
    const terminal = Promise.withResolvers<string>();
    terminalChatInputs.set(runId, terminal.resolve);
    const input = { sessionKey, runId, message, terminal: terminal.promise };
    activeInputs.push(input);
    return input;
  };
  const activeAckLatenciesMs: number[] = [];
  let activeAcksBeforeRelease = 0;
  let activeHoldEnded = false;
  let activeInputWork: Promise<void>[] = [];
  if (chatActiveHoldMs) {
    const beforeRelease = current.beforeRelease;
    const admitActiveInputs = async () => {
      // An older queued input must own custody before later steering attempts arrive.
      await Promise.all(
        roundKeys.map(async (sessionKey) => {
          const input = createActiveInput(
            sessionKey,
            `Synthetic queued predecessor ${randomUUID()}.`,
          );
          const queued = Promise.withResolvers<void>();
          queuedChatInputs.set(input.runId, queued.resolve);
          try {
            await rpc(client, "chat.send", {
              sessionKey,
              message: `/followup ${input.message}`,
              idempotencyKey: input.runId,
              queueMode: "followup",
              deliver: false,
            });
            if (values["chat-active-after-tool"]) {
              const queuedTimeout = setTimeout(
                () => queued.reject(new Error("active predecessor was not queued within 170s")),
                170_000,
              );
              try {
                await queued.promise;
              } finally {
                clearTimeout(queuedTimeout);
              }
            } else {
              await Promise.race([queued.promise, current.ready]);
            }
          } finally {
            queuedChatInputs.delete(input.runId);
          }
        }),
      );
      activeInputWork = roundKeys.flatMap((sessionKey) =>
        Array.from({ length: 2 }, async () => {
          const input = createActiveInput(
            sessionKey,
            `Synthetic active steering input ${randomUUID()}.`,
          );
          const started = performance.now();
          await rpc(client, "chat.send", {
            sessionKey,
            message: input.message,
            idempotencyKey: input.runId,
            queueMode: "steer",
            deliver: false,
          });
          activeAckLatenciesMs.push(performance.now() - started);
          if (!activeHoldEnded) {
            activeAcksBeforeRelease++;
          }
        }),
      );
      for (const work of activeInputWork) {
        void work.catch(current.reject);
      }
      // Release independently of ACKs: a blocked baseline reports the held-turn delay.
      await delay(chatActiveHoldMs);
      activeHoldEnded = true;
    };
    if (values["chat-active-after-tool"]) {
      current.afterToolStreamStart = admitActiveInputs;
    } else {
      current.beforeRelease = async () => {
        await beforeRelease?.();
        await admitActiveInputs();
      };
    }
  }
  if (scenario === "chat.send" && values["heap-snapshot"] && measuredRound !== undefined) {
    const beforeRelease = current.beforeRelease;
    current.beforeRelease = async () => {
      await beforeRelease?.();
      // Admission has completed; snapshot IPC owns its separate diagnostic timeout.
      clearTimeout(timeout);
      await readGatewayResources(child, {
        snapshotPath: path.join(output, `active-${measuredRound}.heapsnapshot`),
      });
    };
  }
  // Include the first response processing after the mock releases the whole cohort.
  const captureWork =
    profilePath || heapProfilePath || finishAdmissionDiagnostics
      ? (async () => {
          try {
            await cohortReady;
            await delay(500);
          } finally {
            if (finishAdmissionDiagnostics) {
              admissionDiagnostics = await finishAdmissionDiagnostics();
            }
            const releaseDiagnostics = await finishReleaseDiagnostics?.();
            capture = { admissionDiagnostics, releaseDiagnostics };
            if (heapProfilePath) {
              await controlGatewayProfile(child, "heap", "stop", heapProfilePath);
              capture.heapProfile = readGatewayHeapProfile(heapProfilePath);
              capture.observedSessionPublications = deliveredSessionEvents() - eventsBeforeProfile;
            }
            if (profilePath) {
              await controlGatewayProfile(child, "cpu", "stop", profilePath);
              capture.cpuProfile = summarizeCpuProfile(profilePath);
            }
          }
        })()
      : undefined;
  const providerTimeoutMs =
    values["attempt-setup-image"] || values["sandbox-image"] || values["stress-worktree-fanout"]
      ? 170_000
      : 45_000;
  const timeout = setTimeout(
    () =>
      current.reject(
        new Error(
          `only ${current.arrivals.size}/${current.expectedCount} primary model requests arrived in ${providerTimeoutMs}ms`,
        ),
      ),
    providerTimeoutMs,
  );
  const turnLatencies: number[] = [];
  let subagentWork: Awaited<ReturnType<typeof startStressSubagent>> | undefined;
  try {
    // Admit the parent before filling the main lane with the foreground cohort.
    if (values["stress-subagents"]) {
      subagentWork = await startStressSubagent(client, current);
    }
    const turns = Promise.all(
      roundKeys.map(async (sessionKey, index) => {
        const turnStarted = performance.now();
        let runId: string = randomUUID();
        const timing: TurnTiming = {
          runId,
          sessionKey,
          startedAt: turnStarted,
          awaitingCreatedRunId:
            values["turn-start-phases"] &&
            measuredRound !== undefined &&
            measuredRound < coldSessionRounds,
        };
        current.turns.set(index + 1, timing);
        const image = retentionScenario
          ? promptContent.update(Buffer.alloc(256 * 128 * 4))
          : undefined;
        if (image) {
          for (let alpha = 3; alpha < image.length; alpha += 4) {
            image[alpha] = 255;
          }
        }
        const message =
          `Reply with benchmark stream ${index + 1}. Transcript-broadcast cohort ${current.id}.` +
          (retentionScenario || idleScenario
            ? `\nSynthetic prompt payload: ${promptContent.update(Buffer.alloc(promptBytes / 2)).toString("hex")}`
            : "");
        if (cronOperatorJob) {
          const started = Promise.withResolvers<string>();
          const timer = setTimeout(
            () => started.reject(new Error("Cron operator turn did not start")),
            45_000,
          );
          sessionEventRuns.set(sessionKey, started);
          try {
            const [, result] = await Promise.all([
              started.promise.then((id) => {
                runId = id;
                current.turns.get(index + 1)!.runId = id;
              }),
              rpc(client, "cron.run", {
                id: cronOperatorJob.id,
                mode: "force",
                waitTimeoutMs: 170_000,
              }),
            ]);
            if (
              !isRecord(result) ||
              !isRecord(result.run) ||
              result.run.status !== "ok" ||
              result.run.sessionKey !== sessionKey
            ) {
              throw new Error(`Scheduled operator continuation failed: ${JSON.stringify(result)}`);
            }
          } finally {
            clearTimeout(timer);
            sessionEventRuns.delete(sessionKey);
          }
          turnLatencies.push(performance.now() - turnStarted);
          return;
        }
        if (values["session-event-wake"]) {
          const started = Promise.withResolvers<string>();
          const timer = setTimeout(
            () => started.reject(new Error("Session event did not start a run")),
            45_000,
          );
          sessionEventRuns.set(sessionKey, started);
          try {
            await rpc(client, "system-event", { sessionKey, text: message, wake: true });
            runId = await started.promise;
            current.turns.get(index + 1)!.runId = runId;
          } finally {
            clearTimeout(timer);
            sessionEventRuns.delete(sessionKey);
          }
        } else if (
          values["turn-start-phases"] &&
          measuredRound !== undefined &&
          measuredRound < coldSessionRounds
        ) {
          const created = await rpc(client, "sessions.create", {
            key: sessionKey,
            cwd: stressWorktree,
            worktree: true,
            message,
            fork: false,
            visibility: "shared",
            displayName: "Synthetic cold turn",
            ...(sessionEventAncestors === 0 ? {} : { parentSessionKey: parentKey, spawnDepth: 1 }),
          });
          if (!isRecord(created) || typeof created.runId !== "string" || created.runError) {
            throw new Error(`Fresh turn admission failed: ${JSON.stringify(created)}`);
          }
          runId = created.runId;
          current.turns.get(index + 1)!.runId = runId;
        } else {
          await rpc(client, scenario === "chat.send" ? "chat.send" : "agent", {
            sessionKey,
            message,
            deliver: false,
            idempotencyKey: runId,
            ...(chatAttachmentContent
              ? {
                  attachments: [
                    {
                      type: "file",
                      mimeType: "text/plain",
                      fileName: "synthetic-attachment.txt",
                      origin: "paste",
                      content: chatAttachmentContent,
                    },
                  ],
                }
              : {}),
            ...(image
              ? {
                  attachments: [
                    {
                      type: "file",
                      mimeType: "image/png",
                      fileName: "synthetic-noise.png",
                      content: encodePngRgba(image, 256, 128).toString("base64"),
                    },
                  ],
                }
              : {}),
          });
        }
        timing.acknowledgedMs = performance.now() - turnStarted;
        if (timing.receivedRunId && timing.receivedRunId !== runId) {
          throw new Error("Turn-start subscriber received a different run before acknowledgement");
        }
        timing.awaitingCreatedRunId = false;
        const result = await rpc(client, "agent.wait", { runId, timeoutMs: 170_000 });
        if (
          !result ||
          typeof result !== "object" ||
          !("status" in result) ||
          result.status !== "ok"
        ) {
          throw new Error(`agent.wait: ${JSON.stringify(result)}`);
        }
        timing.completedMs = performance.now() - turnStarted;
        turnLatencies.push(timing.completedMs);
      }),
    ).then(() => {
      current.phases.completedAtEpochMs = epochNow();
    });
    const subagentCompletion = subagentWork
      ? finishStressSubagent(client, subagentWork)
      : undefined;
    await Promise.all([cohortReady, captureWork, turns, subagentCompletion]);
    if (values["turn-start-phases"] && measuredRound !== undefined) {
      // The separate subscriber socket may drain after agent.wait on the sender.
      const deadline = performance.now() + 10_000;
      while (
        [...current.turns.values()].some(
          (turn) => turn.firstAssistantDeltaMs === undefined || turn.firstToolStartMs === undefined,
        )
      ) {
        if (performance.now() >= deadline) {
          throw new Error(
            "Turn-start subscriber did not receive assistant text and tool start for every run",
          );
        }
        await delay(10);
      }
      for (const turn of current.turns.values()) {
        if (turn.firstAssistantDeltaMs! > turn.firstToolStartMs!) {
          throw new Error("The mock preamble was not delivered before its tool start");
        }
        turnStartSamples.push({
          round: measuredRound,
          sessionKey: turn.sessionKey,
          runId: turn.runId,
          startedAtEpochMs: performance.timeOrigin + turn.startedAt,
          admissionMethod: measuredRound < coldSessionRounds ? "sessions.create" : "chat.send",
          acknowledgedMs: turn.acknowledgedMs!,
          providerRequestMs: turn.providerRequestMs!,
          firstAssistantDeltaMs: turn.firstAssistantDeltaMs!,
          firstToolStartMs: turn.firstToolStartMs!,
          completedMs: turn.completedMs!,
        });
      }
    }
    if (chatActiveHoldMs) {
      if (values["chat-active-after-tool"] && activeInputs.length !== roundKeys.length * 3) {
        throw new Error(
          "after-tool streaming did not admit the expected queued and steering inputs",
        );
      }
      await Promise.all(activeInputWork);
      // agent.wait reports queued custody immediately; wait for each public terminal event first.
      const terminalDeadline = Promise.withResolvers<never>();
      const terminalTimeout = setTimeout(
        () => terminalDeadline.reject(new Error("active inputs did not complete within 170s")),
        170_000,
      );
      try {
        await Promise.race([
          Promise.all(
            activeInputs.map(async (input) => {
              const state = await input.terminal;
              if (state !== "final") {
                throw new Error(`active input terminated with ${state}`);
              }
            }),
          ),
          terminalDeadline.promise,
        ]);
      } finally {
        clearTimeout(terminalTimeout);
      }
      await Promise.all(
        activeInputs.map(async ({ runId }) => {
          const result = await rpc(client, "agent.wait", { runId, timeoutMs: 170_000 });
          if (!isRecord(result) || result.status !== "ok") {
            throw new Error(`active input did not settle successfully: ${JSON.stringify(result)}`);
          }
        }),
      );
      for (const sessionKey of roundKeys) {
        const inputs = activeInputs.filter((input) => input.sessionKey === sessionKey);
        const history = await rpc(client, "chat.history", {
          sessionKey,
          limit: 100,
          inputRunIds: inputs.map((input) => input.runId),
        });
        if (
          !isRecord(history) ||
          !Array.isArray(history.messages) ||
          !Array.isArray(history.inputReceipts)
        ) {
          throw new Error("active input history or custody receipts are missing");
        }
        for (const input of inputs) {
          const messages = history.messages.filter(
            (message: unknown) =>
              isRecord(message) &&
              message.role === "user" &&
              isRecord(message["__openclaw"]) &&
              message["__openclaw"].idempotencyKey === `${input.runId}:user` &&
              contentText(message.content).includes(input.message),
          );
          const receipts = history.inputReceipts.filter(
            (receipt: unknown) => isRecord(receipt) && receipt.runId === input.runId,
          );
          // Standalone promotion removes its pending row; only collected inputs retain receipts.
          if (messages.length !== 1 || receipts.length !== 0) {
            throw new Error(
              `active input was not consumed exactly once: ${JSON.stringify({
                runId: input.runId,
                matchingMessages: messages.length,
                receipts,
              })}`,
            );
          }
        }
      }
    }
    const subagent = await subagentCompletion;
    if (soakScenario) {
      completedSoakRounds++;
    }
    return {
      phases: current.phases,
      ...(chatActiveHoldMs
        ? {
            activeChatSendAck: {
              ...latencySummary(activeAckLatenciesMs),
              acknowledgedBeforeRelease: activeAcksBeforeRelease,
              consumedExactlyOnce: activeInputs.length,
            },
          }
        : {}),
      turnLatencyMs: summarizeLatencies(turnLatencies),
      providerRequestMs: summarizeLatencies(
        [...current.turns.values()].flatMap((turn) => turn.providerRequestMs ?? []),
      ),
      ...(values["turn-start-phases"]
        ? {
            // Both timestamps use the controller clock. Preserve negative values
            // when the provider request arrives before the client receives its ACK.
            clientAckToProviderRequestMs: summarizeLatencies(
              [...current.turns.values()].flatMap((turn) =>
                turn.acknowledgedMs !== undefined && turn.providerRequestMs !== undefined
                  ? [turn.providerRequestMs - turn.acknowledgedMs]
                  : [],
              ),
            ),
          }
        : {}),
      providerBarrierMs: summarizeLatencies(
        [...current.turns.values()].flatMap((turn) => turn.providerBarrierMs ?? []),
      ),
      firstTextMs: summarizeLatencies(
        [...current.turns.values()].flatMap((turn) => turn.firstTextMs ?? []),
      ),
      ...(subagent ? { subagent } : {}),
      ...capture,
    };
  } finally {
    for (const input of activeInputs) {
      terminalChatInputs.delete(input.runId);
    }
    if (stressSubagent) {
      stressSubagent.cancelled = true;
      stressSubagent.releaseChild();
      stressSubagent = undefined;
    }
    clearTimeout(timeout);
    current.release();
    await captureWork;
  }
}
async function drainEvents(requireSubscriberQuiet = true) {
  const started = performance.now();
  const timeoutMs = values["stress-worktree-fanout"] ? 60_000 : 15_000;
  while (performance.now() - started < timeoutMs) {
    assertGatewayAlive();
    if (
      activeStreams === 0 &&
      (teamStressFanout
        ? teamStressFanout.isDrained(requireSubscriberQuiet)
        : !requireSubscriberQuiet || performance.now() - lastSubscriberEventAt >= 1000)
    ) {
      return;
    }
    await delay(50);
  }
  throw new Error(
    `model streams and subscriber events did not drain within ${timeoutMs}ms: activeStreams=${activeStreams}, subscriberQuietMs=${Math.round(performance.now() - lastSubscriberEventAt)}, lastEvent=${lastSubscriberEventName}, pendingInjectionReceipts=${JSON.stringify(teamStressFanout?.pendingInjections() ?? [])}`,
  );
}
async function ensureRecaps(client: ReturnType<typeof createGatewayWsClient>) {
  const states: unknown[] = [];
  for (let offset = 0; offset < keys.length; offset += 20) {
    const batch = keys.slice(offset, offset + 20);
    const result = await rpc(client, "sessions.activitySummary.ensure", {
      sessions: batch.map((key) => ({ key })),
    });
    if (
      !isRecord(result) ||
      !Array.isArray(result.sessions) ||
      result.sessions.length !== batch.length ||
      result.sessions.some(
        (row: unknown) =>
          !isRecord(row) ||
          !isRecord(row.activitySummary) ||
          row.activitySummary.state === "unavailable",
      )
    ) {
      throw new Error("sessions.activitySummary.ensure did not admit the measured sessions");
    }
    for (const row of result.sessions) {
      states.push(row.activitySummary.state);
    }
  }
  return states;
}
async function waitForCurrentRecaps(text: string, since = 0, pendingKeys: string[] = keys) {
  const started = performance.now();
  while (performance.now() - started < 15_000) {
    assertGatewayAlive();
    if (
      perClientRecaps.every((rows) =>
        keys.every((key) => {
          const row = rows.get(key);
          return (
            row?.state === "current" &&
            row.text === text &&
            (!pendingKeys.includes(key) || row.receivedAtEpochMs >= since)
          );
        }),
      )
    ) {
      return;
    }
    await delay(25);
  }
  throw new Error("latest current recap did not reach every subscriber within 15s");
}
async function runRecapBurst(
  client: ReturnType<typeof createGatewayWsClient>,
  measuredRound?: number,
) {
  const child = gateway;
  if (!child) {
    throw new Error("owned Gateway is unavailable");
  }
  const text = `Synthetic recap for cohort ${cohort?.id}.`;
  await ensureRecaps(client);
  await waitForCurrentRecaps(text);
  await drainEvents();
  const initial = sessionEventSizesSnapshot();
  const initialModelRequests = recapRequests;
  const profilePath =
    values["cpu-profile"] && measuredRound !== undefined
      ? path.join(output, `recap-ensure-${measuredRound}.cpuprofile`)
      : undefined;
  if (profilePath) {
    await controlGatewayProfile(child, "cpu", "start", profilePath);
  }
  const beforeRepeatCpu = await readGatewayCpuUsage(child);
  const startedAtEpochMs = epochNow();
  const repeats = [];
  for (let repeat = 0; repeat < recapBurstRepeats; repeat++) {
    const started = epochNow();
    const responseStates = await ensureRecaps(client);
    repeats.push({ startedAtEpochMs: started, completedAtEpochMs: epochNow(), responseStates });
    if (repeat + 1 < recapBurstRepeats) {
      await delay(Math.max(0, recapBurstIntervalMs - (epochNow() - started)));
    }
  }
  const lastRepeat = repeats.at(-1);
  await waitForCurrentRecaps(
    text,
    lastRepeat?.startedAtEpochMs,
    keys.filter((_, index) => lastRepeat?.responseStates[index] === "updating"),
  );
  await drainEvents();
  const completedAtEpochMs = epochNow();
  const repeatCpu = measureGatewayCpuUsage(beforeRepeatCpu, await readGatewayCpuUsage(child));
  if (profilePath) {
    await controlGatewayProfile(child, "cpu", "stop", profilePath);
  }
  const noopSizes = Object.fromEntries(
    [...sessionEventSizes].map(([bucket, sizes]) => [
      bucket,
      {
        frames: sizes.frames - (initial[bucket]?.frames ?? 0),
        bytes: sizes.bytes - (initial[bucket]?.bytes ?? 0),
      },
    ]),
  );
  for (const key of keys) {
    const result = await rpc(client, "sessions.describe", { key });
    const row = isRecord(result) && isRecord(result.session) ? result.session : undefined;
    const summary = row && isRecord(row.activitySummary) ? row.activitySummary : undefined;
    if (
      !summary ||
      summary.state !== "current" ||
      summary.text !== text ||
      perClientRecaps.some((rows) => rows.get(key)?.updatedAt !== summary.updatedAt)
    ) {
      throw new Error(`delivered recap differs from the final authoritative row for ${key}`);
    }
  }
  const latestValueDelivery = perClientRecaps.flatMap((_, clientIndex) =>
    keys.map((key) => {
      const receipt = recapReceipts.find(
        (candidate) =>
          candidate.client === clientIndex &&
          candidate.key === key &&
          candidate.state === "current" &&
          candidate.text === text,
      );
      if (!receipt || typeof receipt.updatedAt !== "number") {
        throw new Error(`client ${clientIndex} missed the final activity-summary event for ${key}`);
      }
      return {
        client: clientIndex,
        key,
        committedToReceivedMs: receipt.receivedAtEpochMs - receipt.updatedAt,
      };
    }),
  );
  return {
    latestValueDelivery,
    finalRecapsMatch: true,
    turnAndInitialRecap: { modelRequests: initialModelRequests, sessionEventSizes: initial },
    repeatedEnsure: {
      repeats,
      intervalMs: recapBurstIntervalMs,
      startedAtEpochMs,
      completedAtEpochMs,
      ...repeatCpu,
      ...(profilePath ? { cpuProfile: summarizeCpuProfile(profilePath) } : {}),
      modelRequests: recapRequests - initialModelRequests,
      sessionEventSizes: noopSizes,
      finalReceiptAfterLastEnsureMs: lastRepeat
        ? Math.max(
            0,
            ...perClientRecaps.flatMap((rows) =>
              keys.map((key) => rows.get(key)!.receivedAtEpochMs - lastRepeat.completedAtEpochMs),
            ),
          )
        : null,
    },
  };
}
function sessionEventSizesSnapshot() {
  return Object.fromEntries(
    [...sessionEventSizes].map(([bucket, sizes]) => [bucket, { ...sizes }]),
  );
}
function trackClientFrames(
  client: ReturnType<typeof createGatewayWsClient>,
  onFrame?: (bytes: number) => void,
) {
  const responseSizes = new Map<string, number>();
  responseFrameBytes.set(client, responseSizes);
  // The helper parses frames before onEvent; capture their exact uncompressed size first.
  client.ws.prependListener("message", (data: import("ws").RawData) => {
    const receivedFrameBytes = Array.isArray(data)
      ? data.reduce((sum, part) => sum + part.byteLength, 0)
      : data.byteLength;
    onFrame?.(receivedFrameBytes);
    if (measuring) {
      const frame = JSON.parse(rawDataToString(data));
      if (frame.type === "res" && typeof frame.id === "string") {
        responseSizes.set(frame.id, receivedFrameBytes);
      }
    }
  });
}
async function connectClient(index: number) {
  const started = performance.now();
  assertGatewayAlive();
  const clientCounters = (perClientCounters[index] ??= new Map<string, number>());
  const recapRows = new Map<string, RecapReceipt>();
  perClientRecaps[index] = recapRows;
  const rowEvents = new GatewaySessionRowEvents();
  let previousSeq: number | undefined;
  let receivedFrameBytes = 0;
  const client = createGatewayWsClient({
    ...clientConnection,
    ...(proxyViewers
      ? {
          origin: viewerOrigin,
          headers: {
            "x-forwarded-for": "203.0.113.50",
            "x-forwarded-proto": "https",
            "x-forwarded-host": "broadcast-measure.example.invalid",
            "x-forwarded-user": viewerIdentity(index),
          },
        }
      : {}),
    onEvent: (event) => {
      lastSubscriberEventAt = performance.now();
      lastSubscriberEventName = event.event;
      if (
        measuringWholeSoakAllocation &&
        (event.event === "session.message" || event.event === "sessions.changed")
      ) {
        wholeSoakDeliveredSessionEvents++;
      }
      if (event.seq !== undefined) {
        if (previousSeq !== undefined && event.seq !== previousSeq + 1) {
          subscriberFailure ??= new Error(
            `client ${index} event sequence gap: ${previousSeq} -> ${event.seq}`,
          );
        }
        previousSeq = event.seq;
      }
      const payload = isRecord(event.payload) ? event.payload : undefined;
      // Client 1 is an exact session subscriber, distinct from the RPC sender.
      if (values["turn-start-phases"] && index === 1 && payload) {
        const turn = [...(cohort?.turns.values() ?? [])].find(
          (candidate) => candidate.sessionKey === payload.sessionKey,
        );
        if (turn) {
          observeTurnStartReceipt(turn, event, performance.now() - turn.startedAt);
        }
      }
      teamStressFanout?.observe(index, event.event, payload);
      if (
        index === 0 &&
        event.event === "chat" &&
        typeof payload?.runId === "string" &&
        typeof payload.state === "string" &&
        ["final", "error", "aborted"].includes(payload.state)
      ) {
        terminalChatInputs.get(payload.runId)?.(payload.state);
      }
      if (
        index === 0 &&
        event.event === "chat" &&
        typeof payload?.runId === "string" &&
        isRecord(payload.message) &&
        contentText(payload.message.content).includes("Your message is queued for a new turn")
      ) {
        queuedChatInputs.get(payload.runId)?.();
      }
      if (
        event.event === "agent" &&
        payload?.stream === "lifecycle" &&
        isRecord(payload.data) &&
        payload.data.phase === "start" &&
        typeof payload.sessionKey === "string" &&
        typeof payload.runId === "string"
      ) {
        sessionEventRuns.get(payload.sessionKey)?.resolve(payload.runId);
      }
      if (values["activity-summaries"]) {
        const decoded = rowEvents.project(event);
        if (decoded.missingBaseline) {
          subscriberFailure ??= new Error(`client ${index} lost its session row baseline`);
        }
        const facts = isRecord(decoded.event.payload) ? decoded.event.payload : undefined;
        const row = facts && isRecord(facts.session) ? facts.session : undefined;
        const summary = row && isRecord(row.activitySummary) ? row.activitySummary : undefined;
        if (summary && typeof facts?.sessionKey === "string" && keys.includes(facts.sessionKey)) {
          const receipt = {
            client: index,
            key: facts.sessionKey,
            state: summary.state,
            text: summary.text,
            updatedAt: summary.updatedAt,
            receivedAtEpochMs: epochNow(),
          };
          recapRows.set(facts.sessionKey, receipt);
          if (facts.reason === "activity-summary") {
            recapReceipts.push(receipt);
          }
        }
      }
      if (index === 0 && !initialFullFrame && event.event === "sessions.changed" && payload) {
        const sizes = measureFrameFields(event, payload, receivedFrameBytes);
        if (sizes.duplicateEnvelopeFields !== undefined) {
          initialFullFrame = sizes;
        }
      }
      if (measuring) {
        if (
          event.event === "chat" &&
          payload?.state === "delta" &&
          isRecord(payload.message) &&
          typeof payload.message.timestamp === "number"
        ) {
          chatDeltaDeliveryMs.push(epochNow() - payload.message.timestamp);
        }
        counters.set(event.event, (counters.get(event.event) ?? 0) + 1);
        clientCounters.set(event.event, (clientCounters.get(event.event) ?? 0) + 1);
        eventBytes.set(event.event, (eventBytes.get(event.event) ?? 0) + receivedFrameBytes);
        const attribution = prepareSessionEventMetrics(event.event, payload, [], undefined)?.("");
        if (attribution) {
          const delivery =
            index < exactClients &&
            typeof payload?.sessionKey === "string" &&
            keys.includes(payload.sessionKey)
              ? "subscribed"
              : "roster";
          const bucket = `${event.event}:${attribution.reason}:${delivery}`;
          const sizes = sessionEventSizes.get(bucket) ?? { frames: 0, bytes: 0 };
          sizes.frames++;
          sizes.bytes += receivedFrameBytes;
          sessionEventSizes.set(bucket, sizes);
          if (
            index === 0 &&
            event.event === "sessions.changed" &&
            payload &&
            receivedFrameBytes > (representativeFrames.get(bucket)?.frameBytes ?? 0)
          ) {
            representativeFrames.set(
              bucket,
              measureFrameFields(event, payload, receivedFrameBytes),
            );
          }
        }
      }
    },
  });
  trackClientFrames(client, (bytes) => {
    receivedFrameBytes = bytes;
  });
  client.ws.on("close", (code) => {
    if (!closing && !expectedClosures.has(client)) {
      subscriberFailure ??= new Error(`subscriber ${index} unexpectedly closed (${code})`);
    }
  });
  client.ws.on("error", (error) => {
    if (!closing && !expectedClosures.has(client)) {
      subscriberFailure ??= new Error(`subscriber ${index}: ${error.message}`);
    }
  });
  clients[index] = client;
  await client.waitOpen();
  const hello = await rpc(client, "connect", clientConnectParams[index]);
  const handshakeElapsedMs = performance.now() - started;
  if (
    !Value.Check(HelloOkSchema, hello) ||
    hello.protocol !== PROTOCOL_VERSION ||
    !hello.features.methods.includes("sessions.list") ||
    !hello.features.methods.includes("sessions.describe") ||
    hello.auth.role !== "operator" ||
    (trustedProxyScenario && hello.auth.method !== "trusted-proxy") ||
    !hello.auth.scopes.includes("operator.admin") ||
    hello.snapshot.sessionDefaults?.defaultAgentId !== "main"
  ) {
    throw new Error("connect did not return a valid hello snapshot");
  }
  if (
    client.ws.extensions.includes("permessage-deflate") !== (proxyViewers || trustedProxyScenario)
  ) {
    throw new Error("Gateway compression negotiation did not match the requested ingress");
  }
  if (proxyViewers) {
    if (hello.auth.method !== "trusted-proxy") {
      throw new Error("Synthetic viewer did not authenticate through the trusted proxy");
    }
    const self = await rpc(client, "users.self", {});
    if (
      !isRecord(self) ||
      !isRecord(self.profile) ||
      typeof self.profile.id !== "string" ||
      !self.profile.id
    ) {
      throw new Error("Synthetic viewer did not acquire a user profile");
    }
    viewerProfiles.add(self.profile.id);
    const expectedProfiles = values["distinct-viewers"] ? index + 1 : 1;
    if (viewerProfiles.size !== expectedProfiles) {
      throw new Error(
        "Synthetic viewer profile identities did not match the requested cardinality",
      );
    }
  }
  if (measuring) {
    handshakeLatenciesMs.push(handshakeElapsedMs);
  }
  return client;
}
let cleanupPromise: Promise<void> | undefined;
function cleanup() {
  return (cleanupPromise ??= (async () => {
    closing = true;
    if (values["exec-io-storm"]) {
      writeFileSync(path.join(output, "agent-exec-io.stop"), "stop\n");
    }
    flushTeamStressRpcMinute();
    cohort?.release();
    for (const id of [
      ...(stressCronJobId ? [stressCronJobId] : []),
      ...cronOperatorJobs.flatMap((job) => (job.id ? [job.id] : [])),
    ]) {
      try {
        const result = await clients[0]?.request("cron.remove", { id }, 5000);
        if (!result?.ok) {
          throw new Error("cron.remove did not succeed");
        }
      } catch (error) {
        console.warn("Stress cron cleanup failed; discard this fixture before reuse:", error);
      }
    }
    for (const client of [...clients, ...githubOptionsClients]) {
      client.close();
    }
    policyNode?.close();
    await Promise.all(
      children.map((child) => stopChild(child, { teardownGraceMs: 10_000, killGraceMs: 2000 })),
    );
    await Promise.all(childLogs.map((log) => finished(log)));
    mock.closeAllConnections();
    if (mock.listening) {
      await new Promise<void>((resolve, reject) => {
        mock.close((error) => (error ? reject(error) : resolve()));
      });
    }
    for (const target of diffTargets) {
      writeFileSync(path.join(target.worktree, "README.md"), target.original);
    }
  })());
}
for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(exitCode));
  });
}
try {
  await assertPortAvailable(port);
  await assertPortAvailable(mockPort);
  await new Promise<void>((resolve, reject) => {
    mock.once("error", reject);
    mock.listen(mockPort, "127.0.0.1", resolve);
  });
  await ready(mockPort, "/health");
  const gatewayArgs = buildGatewayBenchChildArgs(
    values.entry,
    port,
    [
      ...(values["heap-snapshot"] ? ["--heap-snapshot-string-limit=131072"] : []),
      ...(values.allocations || values["stream-start-allocations"] || values["trace-gc"]
        ? ["--trace-gc-nvp"]
        : []),
      "--import",
      teamPluginCatalog || !/\.[cm]?ts$/.test(values.entry)
        ? new URL("./team-shape-stress-loader.mjs", import.meta.url).href
        : "./scripts/tsx.mjs",
      ...(gatewayPreload ? ["--import", gatewayPreload.path] : []),
      ...(values["exec-io-storm"]
        ? ["--import", fileURLToPath(new URL("./agent-exec-io-preload.mjs", import.meta.url))]
        : []),
      ...(configCaptureSource ? ["--import", configCaptureSourcePreload] : []),
      ...(authoritySourcePreload ? ["--import", authoritySourcePreload.path] : []),
      ...(startupSourcePreload ? ["--import", startupSourcePreload.path] : []),
      ...(scenario === "chat.startup" ? ["--import", startupObserverPreload] : []),
      ...(values["authority-counts"] ? ["--import", authorityPreload] : []),
      ...(values["config-capture-counts"] ? ["--import", configCapturePreload] : []),
      ...(values["sqlite-reply-census"]
        ? ["--import", "./scripts/perf/sqlite-reply-census-preload.mjs"]
        : []),
      ...(values["worker-creation-counts"]
        ? ["--import", "./scripts/perf/worker-creation-preload.mjs"]
        : []),
      "--import",
      "./scripts/lib/gateway-bench-profile-preload.ts",
      ...(values["team-stress"] ? ["--import", teamStressPreload] : []),
      ...(values["turn-start-phases"] ? ["--import", turnStartPreload] : []),
      ...(values["transport-counts"]
        ? ["--import", "./scripts/lib/gateway-bench-transport-preload.ts"]
        : []),
      ...(values["transcript-hydration-counts"]
        ? ["--import", "./scripts/perf/transcript-hydration-counts-preload.ts"]
        : []),
      ...(values["worker-memory"] || values["baseline-owners"]
        ? ["--import", "./scripts/perf/transcript-worker-memory-preload.ts"]
        : []),
      ...(values["worker-retained-heap"] || values["worker-baseline-dir"]
        ? ["--import", "./scripts/perf/worker-retained-heap-preload.ts"]
        : []),
      ...(values["dashboard-rpc"] ? ["--import", dashboardPreload] : []),
      ...(values["github-options-observe"]
        ? ["--import", "./scripts/perf/github-options-measure-preload.ts"]
        : []),
    ],
    proxyViewers || trustedProxyScenario ? "trusted-proxy" : "none",
  );
  const gitTraceDirectory = path.join(output, "git-trace");
  if (values["git-trace"]) {
    mkdirSync(gitTraceDirectory);
  }
  const gatewayStartedAt = performance.now();
  gateway = launch(
    gatewayArgs,
    "gateway",
    {
      ...(values["git-trace"] ? { GIT_TRACE2_EVENT: gitTraceDirectory } : {}),
      ...(process.env.DEVELOPER_DIR ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR } : {}),
      ...(values["transport-counts"]
        ? { OPENCLAW_BENCH_TRANSPORT_COUNTS_PATH: path.join(output, "transport-counts.json") }
        : {}),
      ...(values["worker-creation-counts"]
        ? { OPENCLAW_BENCH_WORKER_CREATION_FILE: path.join(output, "worker-creations.jsonl") }
        : {}),
    },
    true,
  );
  if (values["turn-start-phases"]) {
    gateway.on("message", (message: unknown) => {
      if (isRecord(message) && Array.isArray(message.turnStartTimelineBatch)) {
        for (const event of message.turnStartTimelineBatch) {
          if (isRecord(event) && turnStartTimeline.length < turnStartTimelineLimit) {
            turnStartTimeline.push(event);
          }
        }
        if (typeof message.dropped === "number") {
          turnStartTimelineDropped = message.dropped;
        }
      }
      if (
        isRecord(message) &&
        isRecord(message.turnStartPhase) &&
        measuredPhaseRound !== undefined
      ) {
        turnStartPhases.push({ round: measuredPhaseRound, ...message.turnStartPhase });
      }
    });
  }
  await ready(port, "/readyz", gateway);
  const gatewayReadyMs = performance.now() - gatewayStartedAt;
  await readGatewayCpuUsage(gateway);
  console.log("PHASE gateway-ready");
  // Startup recovery for the retained-run inventory is outside the measured workload.
  await delay(10_000);
  for (let index = 0; index < clientCount; index++) {
    const client = await connectClient(index);
    if (index === 0) {
      // Keep the full parent chain present, including the ordinary default main-session link.
      await rpc(client, "sessions.create", {
        key: "agent:main:main",
        visibility: "shared",
        displayName: "Synthetic broadcast root",
      });
      if (!historyTurns) {
        const created = await rpc(client, "sessions.create", {
          key: parentKey,
          ...(sessionEventAncestors === 2 ? { parentSessionKey: "agent:main:main" } : {}),
          ...(stressWorktree ? { cwd: stressWorktree } : {}),
          ...(values["github-options-connected"]
            ? {
                worktree: true,
                ...(values["turn-start-phases"] ? {} : { worktreeBaseRef: "refs/heads/main" }),
              }
            : {}),
          visibility: "shared",
          displayName: "Synthetic broadcast parent",
        });
        if (values["github-options-connected"]) {
          bindConnectedOptionsWorktree(diffTargets[0]!, created);
          stressWorktree = diffTargets[0]!.worktree;
          diffControlOriginal = diffTargets[0]!.original;
        }
        await rpc(client, "sessions.reset", { key: parentKey });
      }
      if (values["stress-subagents"]) {
        await rpc(client, "sessions.create", {
          key: stressParentKey,
          cwd: stressWorktree,
          visibility: "shared",
          displayName: "Synthetic native subagent parent",
        });
      }
      for (const [keyIndex, key] of keys.entries()) {
        if (historyTurns) {
          continue;
        }
        const created = await rpc(client, "sessions.create", {
          key,
          ...(stressWorktree
            ? {
                cwd: values["stress-worktree-fanout"]
                  ? worktreeToolRoots.get(keyIndex + 1)
                  : stressWorktree,
              }
            : {}),
          ...(values["activity-summaries"] ||
          values["cron-operator-turn"] ||
          sessionEventAncestors === 0
            ? {}
            : { parentSessionKey: parentKey, spawnDepth: 1 }),
          fork: false,
          ...(values["attempt-setup-image"] ||
          values["worktree-tool-churn"] ||
          values["turn-start-phases"]
            ? {
                worktree: true,
                ...(values["turn-start-phases"] ? {} : { worktreeBaseRef: "refs/heads/main" }),
              }
            : {}),
          visibility: "shared",
          displayName: "Synthetic broadcast child",
        });
        if (values["worktree-tool-churn"]) {
          const worktree = readManagedWorktree(created);
          if ([...worktreeToolRoots.values()].includes(worktree)) {
            throw new Error("Synthetic foreground sessions must own distinct worktrees");
          }
          worktreeToolRoots.set(keyIndex + 1, worktree);
        }
        await rpc(client, "sessions.reset", { key });
      }
    }
    await rpc(client, "sessions.subscribe", {});
    for (const key of index < exactClients ? keys : []) {
      await rpc(client, "sessions.messages.subscribe", { key, subscriptionId: key });
    }
  }
  const sender = clients[0];
  if (!sender) {
    throw new Error("no sender client");
  }
  if (values["node-policy-churn"]) {
    const nodeKeys = generateKeyPairSync("ed25519");
    const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
      nodeKeys.publicKey.export({ type: "spki", format: "pem" }),
    );
    policyNodeId = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
    const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
    policyNode = createGatewayWsClient({
      ...clientConnection,
      onEvent: (event) => {
        if (event.event === "connect.challenge" && isRecord(event.payload)) {
          const { nonce, ts } = event.payload;
          if (typeof nonce === "string" && typeof ts === "number") {
            challenge.resolve({ nonce, ts });
          }
        }
        if (event.event === "node.invoke.request" && isRecord(event.payload)) {
          const { id, nodeId, command } = event.payload;
          void rpc(policyNode!, "node.invoke.result", {
            id,
            nodeId,
            ok: true,
            payloadJSON: JSON.stringify({ synthetic: true, command }),
          }).catch((error: unknown) => {
            subscriberFailure ??= error instanceof Error ? error : new Error(String(error));
          });
        }
      },
    });
    trackClientFrames(policyNode);
    policyNode.ws.on("error", (error) => {
      subscriberFailure ??= error;
    });
    policyNode.ws.on("close", (code) => {
      if (!closing) {
        subscriberFailure ??= new Error(`synthetic node unexpectedly closed (${code})`);
      }
    });
    await policyNode.waitOpen();
    const { nonce, ts } = await Promise.race([
      challenge.promise,
      delay(12_000, undefined, { ref: false }).then(() => {
        throw new Error("Synthetic node challenge timed out");
      }),
    ]);
    const nodeClient = {
      id: "node-host",
      version: "1.0.0",
      platform: "linux",
      deviceFamily: "linux",
      mode: "node",
      displayName: "Synthetic policy node",
    };
    const hello = await rpc(policyNode, "connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: nodeClient,
      role: "node",
      scopes: [],
      caps: [],
      commands: policyNodeCommands,
      device: {
        id: policyNodeId,
        publicKey,
        signedAt: ts,
        nonce,
        signature: signEd25519Payload(
          nodeKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
          buildDeviceAuthPayloadV3({
            deviceId: policyNodeId,
            clientId: nodeClient.id,
            clientMode: nodeClient.mode,
            platform: nodeClient.platform,
            deviceFamily: nodeClient.deviceFamily,
            role: "node",
            scopes: [],
            signedAtMs: ts,
            nonce,
          }),
        ),
      },
    });
    if (!Value.Check(HelloOkSchema, hello) || hello.auth.role !== "node") {
      throw new Error("Synthetic node did not complete its real Gateway handshake");
    }
    let node = await rpc(sender, "node.describe", { nodeId: policyNodeId });
    if (isRecord(node) && typeof node.pendingRequestId === "string") {
      await rpc(sender, "node.pair.approve", { requestId: node.pendingRequestId });
      node = await rpc(sender, "node.describe", { nodeId: policyNodeId });
    }
    const admittedCommands = isRecord(node) && Array.isArray(node.commands) ? node.commands : [];
    if (
      !isRecord(node) ||
      !node.connected ||
      !node.paired ||
      policyNodeCommands.some((command) => !admittedCommands.includes(command))
    ) {
      throw new Error("Synthetic node policy commands were not paired and admitted");
    }
  }
  const sessionEventLineage: Array<{ key: string; parentSessionKey?: string }> = [];
  const verifySessionEventLineage = async (key: string) => {
    const described = await rpc(sender, "sessions.describe", { key });
    const expectedParent =
      sessionEventAncestors === 0 || key === "agent:main:main"
        ? undefined
        : key === parentKey
          ? "agent:main:main"
          : parentKey;
    if (
      !isRecord(described) ||
      !isRecord(described.session) ||
      described.session.key !== key ||
      described.session.parentSessionKey !== expectedParent
    ) {
      throw new Error(`sessions.describe did not verify the requested ancestor shape for ${key}`);
    }
    sessionEventLineage.push({
      key,
      ...(expectedParent ? { parentSessionKey: expectedParent } : {}),
    });
  };
  if (sessionEventAncestors !== undefined) {
    for (const key of ["agent:main:main", parentKey, ...keys]) {
      await verifySessionEventLineage(key);
    }
  }
  for (const target of diffTargets) {
    if (target.sessionKey !== parentKey) {
      const created = await rpc(sender, "sessions.create", {
        key: target.sessionKey,
        cwd: target.worktree,
        ...(values["github-options-connected"]
          ? {
              worktree: true,
              ...(values["turn-start-phases"] ? {} : { worktreeBaseRef: "refs/heads/main" }),
            }
          : {}),
        visibility: "shared",
        displayName: "Synthetic dashboard diff",
      });
      if (values["github-options-connected"]) {
        bindConnectedOptionsWorktree(target, created);
      }
      await rpc(sender, "sessions.reset", { key: target.sessionKey });
    }
  }
  if (values["github-options-connected"]) {
    // Broad dashboard grants skip target qualification. These sockets exercise
    // the session-scoped read path without changing the other widget grants.
    for (let index = 0; index < clientCount; index++) {
      const client = createGatewayWsClient({
        ...clientConnection,
        headers: { ...clientConnection.headers, "x-openclaw-scopes": "operator.sessions.read" },
      });
      githubOptionsClients.push(client);
      trackClientFrames(client);
      await client.waitOpen();
      const hello = await rpc(client, "connect", {
        ...clientConnectParams[index],
        scopes: ["operator.sessions.read"],
      });
      if (
        !Value.Check(HelloOkSchema, hello) ||
        hello.auth.method !== "trusted-proxy" ||
        hello.auth.scopes.length !== 1 ||
        hello.auth.scopes[0] !== "operator.sessions.read"
      ) {
        const auth = isRecord(hello) && isRecord(hello.auth) ? hello.auth : undefined;
        throw new Error(
          `GitHub options client did not retain its session-scoped grant: ${JSON.stringify({
            method: auth?.method,
            scopes: auth?.scopes,
          })}`,
        );
      }
    }
    await Promise.all(
      githubOptionsClients.map((client, index) =>
        rpc(client, "sessions.github.options", {
          sessionKey: diffTargets[index % diffTargets.length]!.sessionKey,
        }),
      ),
    );
  }
  if (values["dashboard-rpc"]) {
    await rpc(sender, "board.widget.put", {
      sessionKey: parentKey,
      name: "synthetic-status",
      content: { kind: "html", html: "<p>Synthetic dashboard workload</p>" },
    });
    await rpc(sender, "workboard.boards.upsert", { id: dashboardBoardId });
    const existingCardIds = new Set<string>();
    let after: unknown;
    do {
      const page = await rpc(sender, "workboard.cards.list", {
        boardId: dashboardBoardId,
        ...(after === undefined ? {} : { after }),
      });
      if (!isRecord(page) || !Array.isArray(page.cards)) {
        throw new Error("Synthetic workboard cards could not be read");
      }
      for (const card of page.cards) {
        if (
          !isRecord(card) ||
          typeof card.id !== "string" ||
          !card.id ||
          existingCardIds.has(card.id)
        ) {
          throw new Error("Synthetic workboard card pagination returned a missing or repeated ID");
        }
        existingCardIds.add(card.id);
      }
      after = page.nextCursor;
    } while (after !== undefined);
    // Reused fixtures keep exactly the requested viewer/card shape, including shrinking runs.
    for (const id of [...existingCardIds].slice(clientCount)) {
      await rpc(sender, "workboard.cards.delete", { id });
    }
    for (let index = existingCardIds.size; index < clientCount; index++) {
      await rpc(sender, "workboard.cards.create", {
        boardId: dashboardBoardId,
        title: `Synthetic dashboard card ${index}`,
      });
    }
    for (const { method, params } of dashboardRpcShapes) {
      if (values["github-options-connected"] && method === "sessions.github.options") {
        continue;
      }
      validateDashboardRpc(method, await rpc(sender, method, params));
    }
  }
  if (values["operator-model-policy"]) {
    const catalog = await rpc(sender, "models.list", { agentId: "main" });
    if (
      !isRecord(catalog) ||
      !isRecord(catalog.modelSelectionPolicy) ||
      catalog.modelSelectionPolicy.restricted !== true ||
      catalog.modelSelectionPolicy.defaultModel !== "openai/gpt-4.1"
    ) {
      throw new Error("Synthetic operator did not acquire its model policy");
    }
    writeFileSync(path.join(output, "operator-model-policy.json"), JSON.stringify(catalog));
  }
  if (reloadPluginId || scopePluginId || teamPluginCatalog) {
    const inventory = await rpc(sender, "plugins.list", {});
    writeFileSync(path.join(output, "plugin-inventory.json"), JSON.stringify(inventory, null, 2));
    if (teamPluginCatalog) {
      const plugins =
        isRecord(inventory) && Array.isArray(inventory.plugins) ? inventory.plugins : [];
      // Provider catalog entries deliberately stay lazy; workload capabilities must be live.
      const requiredActive = new Set([
        "acpx",
        "codex",
        "diagnostics-prometheus",
        "openai",
        ...(values["turn-start-rich-context"] ? ["memory-core"] : []),
      ]);
      const invalid = [...new Set([...teamStressPlugins, ...requiredActive])].filter(
        (id) =>
          !plugins.some(
            (plugin: unknown) =>
              isRecord(plugin) &&
              plugin.id === id &&
              plugin.enabled === true &&
              isRecord(plugin.runtime) &&
              !plugin.runtime.error &&
              (plugin.runtime.state === "active" ||
                (!requiredActive.has(id) && plugin.runtime.state === "unloaded")),
          ),
      );
      if (invalid.length) {
        throw new Error(
          `Team stress plugins missing, failed, or required runtime inactive: ${invalid.join(", ")}; inspect plugin-inventory.json`,
        );
      }
    }
  }
  const expectedSidebar =
    scenario === "reconnect"
      ? sidebarIdentity(await rpc(sender, "sessions.list", { limit, rowMode, archived: "all" }))
      : undefined;
  for (const target of diffTargets) {
    // First work captures the baseline; later child announcements must not capture our edit.
    const runId = randomUUID();
    await rpc(sender, "agent", {
      sessionKey: target.sessionKey,
      message: "Acknowledge this synthetic diff baseline preparation.",
      deliver: false,
      idempotencyKey: runId,
    });
    const result = await rpc(sender, "agent.wait", { runId, timeoutMs: 170_000 });
    if (!isRecord(result) || result.status !== "ok") {
      throw new Error(`diff baseline preparation failed: ${JSON.stringify(result)}`);
    }
    writeFileSync(
      path.join(target.worktree, "README.md"),
      `${target.original}Synthetic diff control.\n`,
    );
  }
  capturingColdSetup = false;
  if (soakScenario && values["stress-tools"]) {
    const job = await rpc(sender, "cron.add", {
      name: "Synthetic allocation stress cron",
      agentId: "main",
      enabled: true,
      schedule: { kind: "every", everyMs: 30_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "Acknowledge this synthetic scheduled allocation probe.",
        timeoutSeconds: 120,
      },
      delivery: { mode: "none" },
      failureAlert: false,
    });
    if (!isRecord(job) || typeof job.id !== "string") {
      throw new Error("stress cron.add did not return a job ID");
    }
    stressCronJobId = job.id;
    const run = await rpc(sender, "cron.run", {
      id: job.id,
      mode: "force",
      waitTimeoutMs: 170_000,
    });
    if (!isRecord(run) || !isRecord(run.run) || run.run.status !== "ok") {
      throw new Error(`stress cron did not complete its real agent turn: ${JSON.stringify(run)}`);
    }
  }
  if (scenario === "cron.list" && (fixture.cronJobs !== 40 || fixture.cronAnnounceLast !== true)) {
    throw new Error("cron.list requires a fixture generated with --cron 40 --cron-announce-last");
  }
  if (scenario === "board.get") {
    for (let index = 0; index < 3; index++) {
      await rpc(sender, "board.widget.put", {
        sessionKey: parentKey,
        name: `synthetic-gc-audit-${index}`,
        content: { kind: "html", html: `<p>Synthetic widget ${index}</p>` },
      });
    }
  }
  console.log("PHASE subscribed-and-reset");
  let idleTurnCohorts: Awaited<ReturnType<typeof runRound>>[] = [];
  const listFilterShapes = [
    {},
    { archived: false },
    { archived: true },
    { search: teamPluginCatalog ? "Synthetic" : "team-shape" },
    { agentId: "main" },
    {
      excludeSubagents: true,
      ...(values["team-stress"] ? { includeOwnerSessionCounts: true } : {}),
    },
    { excludeSystem: true, excludeCron: true },
  ];
  let listChurnSequence = 0;
  const listFilterCounts = listFilterShapes.map(() => 0);
  const readStartup = async (
    client: ReturnType<typeof createGatewayWsClient>,
    target: StartupTarget,
  ) => {
    const result = await rpc(client, "chat.startup", {
      ...(target.shortId ? { shortId: target.shortId } : { sessionKey: target.sessionKey }),
      agentId: "main",
      limit,
      maxBytes: 256 * 1024,
    });
    if (
      !isRecord(result) ||
      result.sessionKey !== target.sessionKey ||
      typeof result.sessionId !== "string" ||
      !Array.isArray(result.messages) ||
      result.messages.length < (target.minimumMessages ?? 0) ||
      !isRecord(result.pendingInputs) ||
      !Array.isArray(result.pendingInputs.items) ||
      result.pendingInputs.items.length < (target.minimumPendingInputs ?? 0) ||
      !isRecord(result.sessionInfo) ||
      (target.requireMetadata &&
        (!isRecord(result.metadata) || !Array.isArray(result.metadata.commands))) ||
      (target.shortId &&
        (!isRecord(result.resolution) ||
          result.resolution.ok !== true ||
          result.resolution.key !== target.sessionKey))
    ) {
      throw new Error(
        `chat.startup did not return the prepared synthetic target: ${target.sessionKey}`,
      );
    }
  };
  const runScenario = async (measuredRound?: number, operationCount = operations) => {
    if (knowledgeRoot) {
      knowledgeRevision++;
      for (let index = 0; index < 25; index++) {
        writeKnowledgeRecord((knowledgeRevision * 25 + index) % 256);
      }
      const started = performance.now();
      const response = await rpc(sender, "plugins.sessionAction", {
        pluginId: "knowledge",
        actionId: "agent_query",
        payload: { agent: "main", operation: "status", input: {} },
      });
      if (!isRecord(response) || response.ok !== true) {
        throw new Error(`Knowledge scan failed: ${JSON.stringify(response)}`);
      }
      knowledgeLatencies.push(performance.now() - started);
      writeFileSync(
        path.join(output, "knowledge-latencies.json"),
        JSON.stringify(knowledgeLatencies),
      );
    }
    if (idleScenario) {
      idleTurnCohorts = [];
      for (let offset = 0; offset < keys.length; offset += runCount) {
        idleTurnCohorts.push(
          await runRound(sender, measuredRound, keys.slice(offset, offset + runCount)),
        );
      }
      return undefined;
    }
    if (turnScenario) {
      const streamStart = await runRound(sender, measuredRound);
      if (values["activity-summaries"]) {
        recapPhase = await runRecapBurst(sender, measuredRound);
      }
      return streamStart;
    }
    for (let offset = 0; offset < operationCount; offset += clientCount) {
      const batchCount = Math.min(clientCount, operationCount - offset);
      const batchStarted = performance.now();
      const reconnectStarted: number[] = [];
      const slots = clients.slice(0, batchCount).entries();
      await Promise.all(
        clients.slice(0, Math.min(rpcConcurrency, batchCount)).map(async (workerClient) => {
          for (const [index, oldClient] of slots) {
            if (connectionScenario) {
              if (scenario === "reconnect") {
                await delay(
                  Math.max(0, batchStarted + index * reconnectStaggerMs - performance.now()),
                );
                reconnectStarted.push(performance.now() - batchStarted);
              }
              expectedClosures.add(oldClient);
              const closed = once(oldClient.ws, "close");
              oldClient.close();
              await closed;
              const client = await connectClient(index);
              if (scenario === "reconnect") {
                const subscription = await rpc(client, "sessions.subscribe", {
                  limit,
                  rowMode,
                  archived: "all",
                });
                assertListPage(
                  isRecord(subscription) && subscription.subscribed === true
                    ? subscription.list
                    : undefined,
                  "sessions.subscribe",
                );
                for (const key of index < exactClients ? keys : []) {
                  await rpc(client, "sessions.messages.subscribe", { key, subscriptionId: key });
                }
                const sidebar = await rpc(client, "sessions.list", {
                  limit,
                  rowMode,
                  archived: "all",
                });
                if (sidebarIdentity(sidebar) !== expectedSidebar) {
                  throw new Error(
                    `reconnected client ${index} did not recover the current sidebar`,
                  );
                }
              }
            } else if (scenario === "sessions.list" || scenario === "subscribe") {
              const method = scenario === "subscribe" ? "sessions.subscribe" : "sessions.list";
              if (values["list-filter-churn"] && (offset + index) % 10 === 0) {
                const params = {
                  key: parentKey,
                  label: `Synthetic list filter churn ${listChurnSequence++}`,
                };
                assertSessionPatch(params, await rpc(workerClient, "sessions.patch", params));
              }
              const result = await rpc(workerClient, method, {
                limit,
                rowMode,
                ...(values["list-filter-churn"]
                  ? listFilterShapes[(offset + index) % listFilterShapes.length]
                  : { archived: "all" }),
              });
              assertListPage(
                scenario === "subscribe"
                  ? isRecord(result) && result.subscribed === true
                    ? result.list
                    : undefined
                  : result,
                method,
              );
            } else if (scenario === "chat.startup") {
              const target =
                startupTemperature === "cold"
                  ? measuredRound === undefined
                    ? { sessionKey: parentKey }
                    : startupTargets[measuredRound * operations + offset + index]!
                  : startupTargets[(offset + index) % startupTargets.length]!;
              await readStartup(workerClient, target);
            } else if (scenario === "status" || scenario === "health") {
              const result = await rpc(
                workerClient,
                scenario,
                scenario === "health" ? { probe: true } : { includeChannelSummary: false },
              );
              const sessions = isRecord(result) ? result.sessions : undefined;
              if (
                !isRecord(sessions) ||
                typeof sessions.count !== "number" ||
                sessions.count < fixtureSessionCount ||
                !Array.isArray(sessions.recent) ||
                sessions.recent.length === 0
              ) {
                throw new Error(`${scenario} did not summarize the seeded sessions`);
              }
            } else if (scenario === "sessions.describe") {
              const result = await rpc(workerClient, "sessions.describe", {
                key: parentKey,
              });
              const row = isRecord(result) ? result.session : undefined;
              const childKeys = isRecord(row) ? row.childSessions : undefined;
              if (
                !isRecord(row) ||
                row.key !== parentKey ||
                !Array.isArray(childKeys) ||
                childKeys.length !== keys.length ||
                !keys.every((key) => childKeys.includes(key))
              ) {
                throw new Error("sessions.describe did not return the parent with seeded children");
              }
            } else if (scenario === "sessions.patch") {
              const params = sessionPatchParams(index, patchSequences[index]!++);
              assertSessionPatch(params, await rpc(workerClient, "sessions.patch", params));
            } else if (scenario === "sessions.cleanup") {
              const result = await rpc(workerClient, "sessions.cleanup", { agent: "main" });
              if (
                !isRecord(result) ||
                result.agentId !== "main" ||
                result.mode !== "warn" ||
                result.dryRun !== false ||
                result.applied !== true ||
                result.wouldMutate !== false ||
                typeof result.beforeCount !== "number" ||
                result.beforeCount <= 0 ||
                result.afterCount !== result.beforeCount
              ) {
                throw new Error("sessions.cleanup did not preserve the warning-mode fixture");
              }
            } else if (scenario === "cron.list") {
              const result = await rpc(workerClient, "cron.list", {
                includeDisabled: true,
                compact: false,
                limit: 200,
              });
              if (
                !isRecord(result) ||
                !Array.isArray(result.jobs) ||
                result.jobs.length !== 40 ||
                !isRecord(result.deliveryPreviews) ||
                Object.keys(result.deliveryPreviews).length !== 40
              ) {
                throw new Error(
                  "cron.list did not return all 40 disabled jobs with delivery previews",
                );
              }
              const jobIds = new Set<string>();
              for (const job of result.jobs) {
                if (!isRecord(job) || typeof job.id !== "string" || job.enabled !== false) {
                  throw new Error("cron.list returned an unexpected job");
                }
                jobIds.add(job.id);
                const preview = result.deliveryPreviews[job.id];
                if (
                  !isRecord(preview) ||
                  preview.label !== "announce -> last" ||
                  typeof preview.detail !== "string" ||
                  !preview.detail.startsWith("last -> no route, will be blocked:")
                ) {
                  throw new Error(
                    "cron.list omitted the synthetic job's unresolved last-route preview",
                  );
                }
              }
              if (
                !Array.from({ length: 40 }, (_, jobIndex) => `team-shape-cron-${jobIndex}`).every(
                  (id) => jobIds.has(id),
                )
              ) {
                throw new Error("cron.list changed the synthetic job inventory");
              }
            } else if (scenario === "board.get") {
              const result = await rpc(workerClient, "board.get", { sessionKey: parentKey });
              if (
                !isRecord(result) ||
                !Array.isArray(result.widgets) ||
                result.widgets.length !== 3
              ) {
                throw new Error("board.get did not return all three synthetic widgets");
              }
            } else if (scenario === "plugin.scope") {
              const sequence = offset + index;
              const result = await rpc(workerClient, "benchmark.pluginScope", { sequence });
              if (
                !isRecord(result) ||
                result.pluginId !== scopePluginId ||
                result.sequence !== sequence ||
                result.scopeVerified !== true
              ) {
                throw new Error("synthetic plugin RPC did not preserve its invocation scope");
              }
            } else {
              const updateStartedAt = performance.now();
              const expectedRevision = updateReloadPlugin?.();
              const result = await rpc(workerClient, "plugins.reload", {
                plugins: [{ pluginId: reloadPluginId }],
                waitForDrain: true,
              });
              if (!isRecord(result) || result.restartRequired !== false) {
                throw new Error("synthetic plugin reload did not apply live");
              }
              if (expectedRevision !== undefined) {
                // This verification RPC is outside the reload-only latency distribution.
                const observed = await workerClient.request("benchmark.pluginVersion", {}, 180_000);
                if (
                  !observed.ok ||
                  !isRecord(observed.payload) ||
                  observed.payload.revision !== expectedRevision
                ) {
                  throw new Error("synthetic plugin update did not publish the edited revision");
                }
                if (measuring) {
                  pluginUpdateLatenciesMs.push(performance.now() - updateStartedAt);
                }
              }
            }
          }
        }),
      );
      if (rpcIntervalMs && offset + batchCount < operationCount) {
        await delay(Math.max(0, batchStarted + rpcIntervalMs - performance.now()));
      }
      if (scenario === "reconnect") {
        const startSpreadMs = Math.max(...reconnectStarted) - Math.min(...reconnectStarted);
        if (startSpreadMs > 5000) {
          throw new Error("reconnect starts exceeded 5000 ms; increase --rpc-concurrency");
        }
        if (measuring) {
          reconnectStorms.push({
            clients: batchCount,
            startSpreadMs,
            allSidebarsCurrentMs: performance.now() - batchStarted,
          });
        }
      }
    }
    return undefined;
  };
  if (values["cron-operator-turn"]) {
    const runId = randomUUID();
    await rpc(sender, "chat.send", {
      sessionKey: keys[0],
      message: cronOperatorSetupPrompt,
      deliver: false,
      idempotencyKey: runId,
    });
    const result = await rpc(sender, "agent.wait", { runId, timeoutMs: 170_000 });
    if (!isRecord(result) || result.status !== "ok" || !cronOperatorSetupCompleted) {
      throw new Error("Scheduled operator fixture creation failed");
    }
    const listed = await rpc(sender, "cron.list", {
      includeDisabled: true,
      includeDeliveryPreviews: false,
    });
    if (!isRecord(listed) || !Array.isArray(listed.jobs)) {
      throw new Error("Scheduled operator jobs were not listed");
    }
    for (const fixtureJob of cronOperatorJobs) {
      const job = listed.jobs.find(
        (item) =>
          isRecord(item) && item.name === `Synthetic operator continuation ${fixtureJob.cohortId}`,
      );
      if (
        !isRecord(job) ||
        typeof job.id !== "string" ||
        job.sessionTarget !== `session:${keys[0]}`
      ) {
        throw new Error("Scheduled operator job did not bind its creator conversation");
      }
      fixtureJob.id = job.id;
    }
    await drainEvents();
  }
  const warmupStartedAt = performance.now();
  if (values["knowledge-worker-heap"]) {
    const response = await rpc(sender, "plugins.sessionAction", {
      pluginId: "knowledge",
      actionId: "agent_query",
      payload: { agent: "main", operation: "status", input: {} },
    });
    if (
      !isRecord(response) ||
      response.ok !== true ||
      !isRecord(response.result) ||
      response.result.records !== 256
    ) {
      throw new Error(`Knowledge worker warmup failed: ${JSON.stringify(response)}`);
    }
  }
  if (scenario === "chat.startup" && startupTemperature === "warm") {
    for (const target of startupTargets) {
      await readStartup(sender, target);
    }
  }
  // Equal warmup work keeps paired runs at the same retained-history boundary.
  const warmupRoundCount = soakScenario ? Math.max(1, Math.ceil(warmupMs / roundIntervalMs)) : 1;
  for (let round = 0; round < warmupRoundCount; round++) {
    // Warm runtime imports on the parent, leaving all measured sessions untouched.
    if (idleScenario) {
      await runRound(sender, undefined, [parentKey]);
      await drainEvents();
      break;
    }
    const started = performance.now();
    await runScenario(undefined, warmupOperations);
    // Stress background publications need not stop after the warmup turns settle.
    await drainEvents(!values["team-stress"] && !values["turn-start-phases"]);
    if (!soakScenario) {
      break;
    }
    await delay(
      Math.max(
        0,
        Math.min(
          roundIntervalMs - (performance.now() - started),
          warmupMs - (performance.now() - warmupStartedAt),
        ),
      ),
    );
  }
  // Retained-memory baselines may force GC; finish them before the shared warm-start release.
  const initialMemoryCollected = reasoningScenario && (!soakScenario || !values.allocations);
  const initialRetainedResources = reasoningScenario
    ? await readGatewayResources(gateway, {
        includeWorkers: true,
        collectGarbage: initialMemoryCollected,
        sessionCensus: values["session-census"],
        ...(idleScenario && values["heap-snapshot"]
          ? { snapshotPath: path.join(output, "initial.heapsnapshot") }
          : {}),
      })
    : undefined;
  if (values["worker-retained-heap"]) {
    const resources = await readGatewayResources(gateway, { includeWorkers: true });
    const live = [
      ...(resources.workers?.workerHeaps ?? []),
      ...(resources.workers?.workerMemoryMissing ?? []),
    ].filter((worker) => targetWorkerScript(worker.script));
    for (const worker of live) {
      const prefix = path.join(output, `worker-${gateway.pid}-${worker.threadId}`);
      if (worker.threadId === undefined || !existsSync(`${prefix}.ready.json`)) {
        workerHeapEvidence.complete = false;
        workerHeapEvidence.errors.push(
          `Missing worker heap preload: ${worker.script}/${worker.threadId}`,
        );
        continue;
      }
      const evidence: WorkerHeapEvidence = {
        prefix,
        script: worker.script,
        threadId: worker.threadId,
      };
      workerHeapEvidence.workers.push(evidence);
      evidence.before = await workerHeapCommand(evidence, "collect");
    }
    for (const script of [
      "sqlite-store.worker.js",
      "prepared-model-catalog.worker.js",
      ...(values["knowledge-worker-heap"] ? ["storage-worker.js"] : []),
    ]) {
      const workers = workerHeapEvidence.workers.filter((worker) => worker.script === script);
      if (!workers.length) {
        workerHeapEvidence.complete = false;
        workerHeapEvidence.errors.push(`No warmed target worker: ${script}`);
      }
    }
  }
  const warmReadyAtEpochMs = Date.now();
  const execIoBefore = values["exec-io-storm"] ? readExecIoProgress() : [];
  if (values["exec-io-storm"] && execIoBefore.length !== runCount) {
    throw new Error(`Expected ${runCount} synthetic IO writers before measurement`);
  }
  if (values["team-stress"]) {
    const shape: Record<string, number> = {};
    for (const archived of ["all", false, true] as const) {
      const page = await rpc(sender, "sessions.list", { agentId: "main", archived, limit: 1 });
      if (!isRecord(page) || typeof page.totalCount !== "number") {
        throw new Error("Team stress live session census did not return totalCount");
      }
      shape[String(archived)] = page.totalCount;
    }
    writeFileSync(path.join(output, "stress-shape.json"), JSON.stringify(shape, null, 2));
    if (
      shape.all! < fixtureSessionCount ||
      shape.false! < fixtureSessionCount - Number(fixture.archivedCount) ||
      shape.true! < Number(fixture.archivedCount)
    ) {
      throw new Error("Team stress session shape changed during Gateway startup maintenance");
    }
  }
  console.log("PHASE warmed");
  if (values["start-file"]) {
    while (!existsSync(values["start-file"])) {
      assertGatewayAlive();
      await delay(250);
    }
    startAt = integer(readFileSync(values["start-file"], "utf8").trim(), "--start-file epoch");
  }
  if (startAt !== undefined) {
    if (Date.now() >= startAt) {
      throw new Error("--start-at passed before fixture readiness and warmup");
    }
    await delay(startAt - Date.now());
  }
  const warmStartReleasedAtEpochMs = Date.now();
  if (values["team-stress"]) {
    await controlTeamStressTelemetry(gateway, "start");
    teamStressStartedAt = Date.now();
    teamStressTelemetryActive = true;
  }
  const soakAllocationPath =
    soakScenario && values.allocations
      ? path.join(output, "allocation-soak.heapprofile")
      : undefined;
  // A twenty-minute churn profile needs coarser sampling to bound native records and JSON export.
  const soakSamplingIntervalBytes = heapSamplingIntervalBytes ?? 512 * 1024;
  if (soakAllocationPath) {
    // Reading or stopping a V8 sampling profile forces GC; keep one window for the entire soak.
    measuringWholeSoakAllocation = true;
    await controlGatewayProfile(gateway, "heap", "start", soakAllocationPath, {
      samplingIntervalBytes: soakSamplingIntervalBytes,
      includeWorkers: values["worker-allocations"],
    });
  }
  const startedHeapWorkers: WorkerHeapEvidence[] = [];
  for (const worker of workerHeapEvidence.workers) {
    worker.start = await workerHeapCommand(worker, "start");
    if (worker.start.ok === true) {
      startedHeapWorkers.push(worker);
    }
  }
  const wholeSoakResourcesBefore =
    soakScenario || values["turn-start-phases"]
      ? await readGatewayResources(gateway, { includeWorkers: true })
      : undefined;
  const measurementStartedAt = Date.now();
  const wholeSoakCpuBefore = soakScenario ? await readGatewayCpuUsage(gateway) : undefined;
  const measuredGateway = gateway;
  const wholeChatDiagnosticsEnabled =
    scenario === "chat.send" &&
    !values["attempt-setup-image"] &&
    values.diagnostics &&
    !values.allocations &&
    !values["cpu-profile"] &&
    !values["workload-cpu-profile"] &&
    !values["stream-start-allocations"];
  const finishWholeWorkloadDiagnostics =
    (soakScenario ||
      scenario === "plugins.reload" ||
      wholeChatDiagnosticsEnabled ||
      values["attempt-setup-image"]) &&
    (values.diagnostics || values.allocations || values["trace-gc"])
      ? await startGatewayDiagnostics(
          gateway,
          soakScenario
            ? "whole-soak"
            : values["attempt-setup-image"]
              ? "whole-attempt-setup"
              : scenario === "chat.send"
                ? "whole-chat"
                : "whole-reload",
        )
      : undefined;
  const samples = [];
  const memorySamples: Array<{
    atEpochMs: number;
    elapsedMs: number;
    completedRounds: number;
    sessionResets: number;
    collectedGarbage: boolean;
    resources: Awaited<ReturnType<typeof readGatewayResources>>;
    phase?: string;
  }> = [];
  const sampleMemory = async (collectGarbage = false, phase?: string) => {
    const resources = await readGatewayResources(measuredGateway, {
      includeWorkers: true,
      collectGarbage,
      sessionCensus: collectGarbage && values["session-census"],
      ...(idleScenario && phase && values["heap-snapshot"]
        ? { snapshotPath: path.join(output, `${phase}.heapsnapshot`) }
        : {}),
    });
    const sample = {
      atEpochMs: Date.now(),
      elapsedMs: Date.now() - measurementStartedAt,
      completedRounds: samples.length,
      sessionResets,
      collectedGarbage: collectGarbage,
      resources,
      ...(phase ? { phase } : {}),
    };
    memorySamples.push(sample);
    appendFileSync(path.join(output, "memory-samples.jsonl"), `${JSON.stringify(sample)}\n`);
    console.log(
      `MEMORY ${JSON.stringify({
        elapsedMs: sample.elapsedMs,
        completedRounds: sample.completedRounds,
        collectedGarbage: collectGarbage,
        heapUsed: resources.memory.heapUsed,
        rss: resources.memory.rss,
      })}`,
    );
    return resources;
  };
  const idleHistories = new Map<string, { messages: number; digest: string }>();
  const verifyIdleHistories = async (phase: "touched" | "reopened") => {
    for (const sessionKey of keys) {
      const messages: unknown[] = [];
      let offset = 0;
      while (true) {
        const history = await rpc(sender, "chat.history", { sessionKey, limit: 100, offset });
        if (!isRecord(history) || !Array.isArray(history.messages)) {
          throw new Error(`missing idle-session history: ${sessionKey}`);
        }
        messages.unshift(...history.messages);
        if (!history.hasMore) {
          break;
        }
        if (typeof history.nextOffset !== "number" || history.nextOffset <= offset) {
          throw new Error(`idle-session history pagination did not advance: ${sessionKey}`);
        }
        offset = history.nextOffset;
      }
      if (messages.length < historyTurns * 4) {
        throw new Error(`seeded idle-session history was lost: ${sessionKey}`);
      }
      const digest = (entries: unknown[]) =>
        createHash("sha256").update(JSON.stringify(entries)).digest("hex");
      const previous = idleHistories.get(sessionKey);
      if (previous && digest(messages.slice(0, previous.messages)) !== previous.digest) {
        throw new Error(`idle-session transcript changed during ${phase}: ${sessionKey}`);
      }
      const answers = messages.filter(
        (message) =>
          isRecord(message) &&
          message.role === "assistant" &&
          contentText(message.content).trim() === chunk.repeat(chunkCount).trim(),
      );
      if (answers.length !== (phase === "reopened" ? 2 : 1)) {
        throw new Error(`idle-session answer missing or duplicated during ${phase}: ${sessionKey}`);
      }
      if (phase === "touched") {
        idleHistories.set(sessionKey, { messages: messages.length, digest: digest(messages) });
      }
    }
  };
  let postIdleResources: Awaited<ReturnType<typeof readGatewayResources>> | undefined;
  let idleDiagnostics: ReturnType<ReturnType<typeof startGatewayBenchDiagnostics>> | undefined;
  const retainedProfilePath = path.join(output, "retained.heapprofile");
  let retainedProfileStartedAt: number | undefined;
  if (soakScenario) {
    await sampleMemory();
  }
  for (
    let round = 0;
    soakScenario
      ? soakRounds === undefined
        ? Date.now() - measurementStartedAt < durationMs
        : round < soakRounds
      : round < (idleScenario ? 2 : rounds);
    round++
  ) {
    if (values["turn-start-phases"] && round < coldSessionRounds) {
      await delay(roundIntervalMs);
    }
    if (values["turn-start-advance-origin"] && round < coldSessionRounds) {
      if (
        !values["turn-start-phases"] ||
        !isRecord(project) ||
        typeof project.repoRoot !== "string"
      ) {
        throw new Error("Advancing an origin requires the turn-start fixture");
      }
      const git = (args: string[], input?: string) => {
        const result = spawnSync("git", args, {
          input,
          encoding: "utf8",
          env: {
            ...env,
            DEVELOPER_DIR: process.env.DEVELOPER_DIR,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_AUTHOR_NAME: "Synthetic fixture",
            GIT_AUTHOR_EMAIL: "fixture@example.invalid",
            GIT_COMMITTER_NAME: "Synthetic fixture",
            GIT_COMMITTER_EMAIL: "fixture@example.invalid",
          },
        });
        if (result.status !== 0) {
          throw new Error(`Synthetic origin update failed: ${result.stderr}`);
        }
        return result.stdout.trim();
      };
      const origin = realpathSync(git(["-C", project.repoRoot, "remote", "get-url", "origin"]));
      if (!origin.startsWith(`${realpathSync(root)}${path.sep}`)) {
        throw new Error("Origin must remain inside the synthetic fixture");
      }
      const atOrigin = (...args: string[]) => ["--git-dir", origin, ...args];
      git(atOrigin("read-tree", "HEAD"));
      const blob = git(
        atOrigin("hash-object", "-w", "--stdin"),
        `# Synthetic project base revision ${port}-${round}\n`,
      );
      git(atOrigin("update-index", "--add", "--cacheinfo", `100644,${blob},README.md`));
      const tree = git(atOrigin("write-tree"));
      const commit = git(
        atOrigin("commit-tree", tree, "-p", "HEAD", "-m", `Synthetic base revision ${round}`),
      );
      git(atOrigin("update-ref", "refs/heads/main", commit));
    }
    measuredPhaseRound = round;
    if (scenario === "chat.send" && round < coldSessionRounds) {
      for (const [index, previous] of keys.entries()) {
        const key = `agent:main:transcript-broadcast-cold-${port}-${round}-${index}`;
        if (!values["turn-start-phases"]) {
          await rpc(sender, "sessions.create", {
            key,
            ...(stressWorktree ? { cwd: stressWorktree } : {}),
            ...(values["attempt-setup-image"]
              ? { worktree: true, worktreeBaseRef: coldBaseRefs[round * runCount + index] }
              : {}),
            ...(sessionEventAncestors === 0 ? {} : { parentSessionKey: parentKey, spawnDepth: 1 }),
            fork: false,
            visibility: "shared",
            displayName: "Synthetic cold setup",
          });
          if (sessionEventAncestors !== undefined) {
            await verifySessionEventLineage(key);
          }
        }
        for (const client of clients.slice(0, exactClients)) {
          await rpc(client, "sessions.messages.unsubscribe", {
            key: previous,
            subscriptionId: previous,
          });
          await rpc(client, "sessions.messages.subscribe", { key, subscriptionId: key });
        }
        keys[index] = key;
      }
    }
    const roundStartedAt = Date.now();
    if (
      soakScenario &&
      retainedProfileMs > 0 &&
      retainedProfileStartedAt === undefined &&
      roundStartedAt - measurementStartedAt >= durationMs - retainedProfileMs
    ) {
      await controlGatewayProfile(gateway, "heap", "start", retainedProfilePath, {
        includeCollectedObjects: false,
      });
      retainedProfileStartedAt = Date.now();
    }
    counters.clear();
    chatDeltaDeliveryMs.length = 0;
    rpcMeasurements.clear();
    handshakeLatenciesMs.length = 0;
    reconnectStorms.length = 0;
    eventBytes.clear();
    sessionEventSizes.clear();
    representativeFrames.clear();
    for (const counts of perClientCounters) {
      counts.clear();
    }
    peakStreams = 0;
    peakPrimaryStreams = 0;
    streamRequests = 0;
    primaryStreamRequests = 0;
    toolCalls = 0;
    toolResults = 0;
    networkToolRequests = 0;
    outputLimitResponses = 0;
    recoveredResponses = 0;
    imageRequests = 0;
    reasoningResponses = 0;
    reasoningResponseSequence = 0;
    reasoningReplayRequests = 0;
    historicalReplayRequests = 0;
    recapRequests = 0;
    recapReceipts.length = 0;
    recapPhase = undefined;
    activeWorkCounts = undefined;
    const finishGatewayDiagnostics =
      values.diagnostics ||
      values["transport-counts"] ||
      values["session-projection-counts"] ||
      values["config-capture-counts"]
        ? await startGatewayDiagnostics(gateway, `round-${round}`)
        : undefined;
    const finishControllerDiagnostics = values.diagnostics
      ? startGatewayBenchDiagnostics()
      : undefined;
    const before = await readGatewayCpuUsage(gateway);
    const workloadCpuProfilePath = values["workload-cpu-profile"]
      ? path.join(output, `workload-${round}.cpuprofile`)
      : undefined;
    const rpcLatencies: Record<string, number[]> = Object.fromEntries(
      mixedRpcMethods.map((method) => [method, []]),
    );
    const listLatencies = rpcLatencies["sessions.list"]!;
    const usageCacheStatuses: Record<string, number> = {};
    const initialPollPhasesMs: number[] = [];
    let streamStart: Awaited<ReturnType<typeof runRound>> | undefined;
    const listRequests: Array<{
      method: string;
      responseId: string;
      client: number;
      round: number;
      startedAtEpochMs: number;
      endedAtEpochMs: number;
      durationMs: number;
      diffSessionKey?: string;
      githubOptionsSessionKey?: string;
    }> = [];
    const workload = async () => {
      let polling = true;
      let stopPolling!: () => void;
      const stopped = new Promise<void>((resolve) => {
        stopPolling = resolve;
      });
      // Exercise the real transcript commit/publication path independently of model turns.
      const churnWork = values["team-stress"]
        ? (async () => {
            while (true) {
              if (!polling) {
                break;
              }
              const started = performance.now();
              const target = teamStressTargets[teamStressWrites % teamStressTargets.length]!;
              const injected = await rpc(sender, "chat.inject", {
                ...target,
                message: `Synthetic Team stress timestamp churn ${teamStressWrites}.`,
              });
              if (
                !isRecord(injected) ||
                injected.ok !== true ||
                typeof injected.messageId !== "string"
              ) {
                throw new Error("Team stress timestamp write did not commit");
              }
              teamStressWrites++;
              teamStressFanout?.expectInjection(target.sessionKey, injected.messageId);
              await Promise.race([
                delay(Math.max(0, teamStressChurnMs - (performance.now() - started)), undefined, {
                  ref: false,
                }),
                stopped,
              ]);
            }
          })().catch((error: unknown) => {
            subscriberFailure ??= error instanceof Error ? error : new Error(String(error));
            polling = false;
            stopPolling();
          })
        : undefined;
      const scrapeWork = values["team-stress"]
        ? (async () => {
            while (true) {
              if (!polling) {
                break;
              }
              const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/prometheus`, {
                signal: AbortSignal.timeout(10_000),
                ...(trustedProxyScenario
                  ? { headers: { ...clientConnection.headers, origin: authorityOrigin } }
                  : {}),
              });
              if (!response.ok) {
                throw new Error(`Team stress Prometheus scrape failed: HTTP ${response.status}`);
              }
              const text = await response.text();
              if (!text.includes("openclaw_")) {
                throw new Error("Team stress Prometheus scrape contained no OpenClaw metrics");
              }
              writeFileSync(
                path.join(output, `stress-prometheus-${teamStressPrometheusScrapes++}.prom`),
                text,
              );
              await Promise.race([delay(15_000, undefined, { ref: false }), stopped]);
            }
          })().catch((error: unknown) => {
            subscriberFailure ??= error instanceof Error ? error : new Error(String(error));
            polling = false;
            stopPolling();
          })
        : undefined;
      const listWork = listIntervalMs
        ? Promise.all(
            clients
              .map(async (client, clientIndex) => {
                const random = createPollRandom(round, clientIndex);
                const initialPhaseMs = random ? random() * listIntervalMs : 0;
                initialPollPhasesMs[clientIndex] = initialPhaseMs;
                if (random) {
                  await Promise.race([delay(initialPhaseMs, undefined, { ref: false }), stopped]);
                }
                let poll = clientIndex;
                let listPoll = round * clientCount + clientIndex;
                while (true) {
                  if (!polling) {
                    break;
                  }
                  const started = performance.now();
                  let requestStarted = started;
                  let responseId = "";
                  let diffSessionKey: string | undefined;
                  let githubOptionsSessionKey: string | undefined;
                  const method = values["mixed-rpc"]
                    ? mixedRpcMethods[poll++ % mixedRpcMethods.length]!
                    : "sessions.list";
                  const dashboardShape = dashboardRpcShapes.find(
                    (shape) => shape.method === method,
                  );
                  const onResponse = recordListRequests
                    ? (id: string) => {
                        responseId = id;
                      }
                    : undefined;
                  if (dashboardShape) {
                    const optionsClient =
                      method === "sessions.github.options"
                        ? githubOptionsClients[clientIndex]
                        : undefined;
                    if (optionsClient) {
                      githubOptionsSessionKey =
                        diffTargets[
                          (round + clientIndex + Math.floor(poll / mixedRpcMethods.length)) %
                            diffTargets.length
                        ]!.sessionKey;
                    }
                    validateDashboardRpc(
                      method,
                      await rpc(
                        optionsClient ?? client,
                        method,
                        githubOptionsSessionKey
                          ? { sessionKey: githubOptionsSessionKey }
                          : dashboardShape.params,
                        onResponse,
                      ),
                    );
                  } else if (method === "usage.cost" || method === "sessions.usage") {
                    const usage = await rpc(
                      client,
                      method,
                      {
                        agentId: "main",
                        range: "all",
                        ...(method === "sessions.usage" ? { projection: "overview", limit } : {}),
                      },
                      onResponse,
                    );
                    if (
                      !isRecord(usage) ||
                      !isRecord(usage.totals) ||
                      typeof usage.totals.totalTokens !== "number" ||
                      typeof usage.totals.totalCost !== "number" ||
                      !Array.isArray(method === "usage.cost" ? usage.daily : usage.sessions)
                    ) {
                      throw new Error(`${method} did not return a usage report`);
                    }
                    const cacheStatus = isRecord(usage.cacheStatus)
                      ? String(usage.cacheStatus.status)
                      : "unspecified";
                    const statusKey = `${method}:${cacheStatus}`;
                    usageCacheStatuses[statusKey] = (usageCacheStatuses[statusKey] ?? 0) + 1;
                  } else if (method === "connect") {
                    const peer = createGatewayWsClient(clientConnection);
                    trackClientFrames(peer);
                    try {
                      await peer.waitOpen();
                      const hello = await rpc(
                        peer,
                        "connect",
                        clientConnectParams[clientIndex],
                        onResponse,
                      );
                      if (!Value.Check(HelloOkSchema, hello)) {
                        throw new Error("fresh connect did not return hello-ok");
                      }
                    } finally {
                      peer.close();
                    }
                  } else if (method === "node.list" || method === "node.describe") {
                    const payload = await rpc(
                      client,
                      method,
                      method === "node.list" ? {} : { nodeId: policyNodeId },
                      onResponse,
                    );
                    const node =
                      method === "node.list" && isRecord(payload) && Array.isArray(payload.nodes)
                        ? payload.nodes.find(
                            (entry: unknown) => isRecord(entry) && entry.nodeId === policyNodeId,
                          )
                        : payload;
                    const admittedCommands =
                      isRecord(node) && Array.isArray(node.commands) ? node.commands : [];
                    if (
                      !isRecord(node) ||
                      !node.connected ||
                      !node.paired ||
                      policyNodeCommands.some((command) => !admittedCommands.includes(command))
                    ) {
                      throw new Error(`${method} lost the synthetic node's admitted commands`);
                    }
                  } else if (method === "node.invoke") {
                    const command =
                      policyNodeCommands[(round + clientIndex) % policyNodeCommands.length]!;
                    const result = await rpc(
                      client,
                      method,
                      {
                        nodeId: policyNodeId,
                        command,
                        params: {},
                        idempotencyKey: randomUUID(),
                      },
                      onResponse,
                    );
                    if (
                      !isRecord(result) ||
                      !isRecord(result.payload) ||
                      result.payload.synthetic !== true ||
                      result.payload.command !== command
                    ) {
                      throw new Error("node.invoke did not return the synthetic node's echo");
                    }
                  } else if (method === "chat.history" || method === "chat.startup") {
                    const stressTarget = teamPluginCatalog
                      ? teamStressTargets[(clientIndex + round) % teamStressTargets.length]
                      : undefined;
                    const history = await rpc(
                      client,
                      method,
                      {
                        ...(stressTarget ?? {
                          sessionKey: historyTurns
                            ? keys[clientIndex % keys.length]
                            : coldHistoryKeys.length
                              ? coldHistoryKeys[coldHistorySequence++ % coldHistoryKeys.length]
                              : `agent:main:team-shape-session-${clientIndex % fixtureSessionCount}`,
                        }),
                        limit: 50,
                      },
                      onResponse,
                    );
                    if (
                      !isRecord(history) ||
                      !Array.isArray(history.messages) ||
                      !history.messages.length
                    ) {
                      throw new Error(`${method} did not return the retained fixture transcript`);
                    }
                  } else if (method === "sessions.diff") {
                    const target =
                      diffTargets[
                        (round + clientIndex + Math.floor(poll / mixedRpcMethods.length)) %
                          diffTargets.length
                      ]!;
                    diffSessionKey = target.sessionKey;
                    validateDiff(
                      await rpc(
                        client,
                        method,
                        {
                          sessionKey: target.sessionKey,
                          scope: "all",
                          summaryOnly: true,
                        },
                        onResponse,
                      ),
                      1,
                      target.worktree,
                    );
                  } else {
                    const listSequence = listPoll;
                    listPoll += clientCount;
                    if (values["list-filter-churn"] && listSequence % 10 === 0) {
                      const params = {
                        key: parentKey,
                        label: `Synthetic list filter churn ${listChurnSequence++}`,
                      };
                      assertSessionPatch(params, await rpc(client, "sessions.patch", params));
                    }
                    const search = values["worktree-tool-churn"]
                      ? Math.floor(poll / mixedRpcMethods.length) % 2 === 0
                        ? "Synthetic"
                        : "investigation"
                      : undefined;
                    // Worktree churn keeps its fixed search fixtures when both presets are selected.
                    const listFilter = search
                      ? { archived: "all", search }
                      : values["list-filter-churn"]
                        ? listFilterShapes[listSequence % listFilterShapes.length]
                        : values["team-stress"]
                          ? listFilterShapes[
                              (round + clientIndex + Math.floor(poll / mixedRpcMethods.length)) %
                                listFilterShapes.length
                            ]
                          : undefined;
                    requestStarted = performance.now();
                    const page = await rpc(
                      client,
                      method,
                      {
                        rowMode,
                        limit,
                        ...(values["team-stress"] ? { archived: "all" } : {}),
                        ...(listFilter ?? { archived: "all" }),
                        ...(values["list-profile-reference"]
                          ? { involvingProfileId: values["list-profile-reference"] }
                          : {}),
                      },
                      onResponse,
                    );
                    if (
                      !isRecord(page) ||
                      typeof page.totalCount !== "number" ||
                      page.count !== Math.min(limit, page.totalCount) ||
                      !Array.isArray(page.sessions) ||
                      page.sessions.length !== page.count ||
                      (page.count === 0 &&
                        !values["list-profile-reference"] &&
                        (search !== undefined ||
                          !listFilter ||
                          Object.keys(listFilter).length === 0))
                    ) {
                      throw new Error("concurrent sessions.list did not return the requested page");
                    }
                    if (values["list-filter-churn"] && search === undefined) {
                      const filterIndex = listSequence % listFilterShapes.length;
                      listFilterCounts[filterIndex] = listFilterCounts[filterIndex]! + 1;
                    }
                    if (search) {
                      worktreeToolSearches.set(search, (worktreeToolSearches.get(search) ?? 0) + 1);
                    }
                  }
                  const ended = performance.now();
                  const requestDurationMs = ended - requestStarted;
                  rpcLatencies[method]!.push(requestDurationMs);
                  if (recordListRequests) {
                    listRequests.push({
                      method,
                      responseId,
                      client: clientIndex,
                      round,
                      startedAtEpochMs: performance.timeOrigin + requestStarted,
                      endedAtEpochMs: performance.timeOrigin + ended,
                      durationMs: requestDurationMs,
                      ...(diffSessionKey ? { diffSessionKey } : {}),
                      ...(githubOptionsSessionKey ? { githubOptionsSessionKey } : {}),
                    });
                  }
                  const intervalMs = random ? listIntervalMs * (0.5 + random()) : listIntervalMs;
                  await Promise.race([
                    delay(Math.max(0, intervalMs - (performance.now() - started)), undefined, {
                      ref: false,
                    }),
                    stopped,
                  ]);
                }
              })
              .map((work) =>
                work.catch((error: unknown) => {
                  subscriberFailure ??= error instanceof Error ? error : new Error(String(error));
                  polling = false;
                  stopPolling();
                }),
              ),
          )
        : undefined;
      try {
        streamStart = await runScenario(round);
        if ((values["dashboard-rpc"] || pollBetweenRounds) && !values["turn-start-phases"]) {
          // Keep polling between bursts of agent work.
          const pacedUntil = Math.min(
            roundStartedAt + roundIntervalMs,
            measurementStartedAt + durationMs,
          );
          while (Date.now() < pacedUntil) {
            assertGatewayAlive();
            if (subscriberFailure) {
              throw subscriberFailure;
            }
            await delay(Math.min(memoryIntervalMs, pacedUntil - Date.now()));
            await sampleMemory();
          }
        }
      } finally {
        polling = false;
        stopPolling();
        await listWork;
        await churnWork;
        await scrapeWork;
      }
    };
    const measuredWorkload = async () => {
      if (workloadCpuProfilePath) {
        await controlGatewayProfile(measuredGateway, "cpu", "start", workloadCpuProfilePath);
      }
      try {
        if (turnScenario) {
          await drainEvents(!values["team-stress"] && !values["turn-start-phases"]);
        }
        measuring = true;
        await workload();
        // Polling has stopped and in-flight RPCs have completed. Team receipts
        // drain their workload while unrelated background metadata stays active.
        if (turnScenario || !values["dashboard-rpc"]) {
          const beforeDrain = perClientCounters.map((counts) => Object.fromEntries(counts));
          const drainStarted = performance.now();
          // Turn-start proof owns exact receipts; busy fixture metadata need not become quiet.
          await drainEvents(!values["turn-start-phases"]);
          console.log(
            `FANOUT_BOUNDARY ${JSON.stringify({
              round,
              waitMs: performance.now() - drainStarted,
              before: beforeDrain,
              after: perClientCounters.map((counts) => Object.fromEntries(counts)),
            })}`,
          );
        }
      } finally {
        measuring = false;
        if (workloadCpuProfilePath) {
          await controlGatewayProfile(measuredGateway, "cpu", "stop", workloadCpuProfilePath);
        }
      }
    };
    if (values["operator-access-policy"]) {
      await controlAuthorityCounters(gateway, "start");
    }
    const allocation =
      values.allocations && !soakScenario
        ? await measureGatewayAllocations(
            gateway,
            path.join(output, `allocation-${round}.heapprofile`),
            turnScenario ? sessionCount : operations,
            measuredWorkload,
            { samplingIntervalBytes: heapSamplingIntervalBytes },
          )
        : undefined;
    if (!values.allocations || soakScenario) {
      await measuredWorkload();
    }
    const authorityCounts = values["operator-access-policy"]
      ? await controlAuthorityCounters(gateway, "stop")
      : undefined;
    if (
      values["cron-operator-turn"] &&
      (!authorityCounts?.resume ||
        (values["authority-counts"] &&
          (!authorityCounts.host?.counts["cron-operator-source.assertCurrent"] ||
            !authorityCounts.host?.counts["server-cron.isAgentAvailable"])))
    ) {
      throw new Error(
        `Scheduled turn did not restore its captured operator source: ${JSON.stringify({
          round,
          resumes: authorityCounts?.resume,
          sourceAssertions: authorityCounts?.host?.counts["cron-operator-source.assertCurrent"],
          availabilityChecks: authorityCounts?.host?.counts["server-cron.isAgentAvailable"],
        })}`,
      );
    }
    if (
      authorityCounts &&
      (!authorityCounts.assert || !authorityCounts.tools || !authorityCounts.messageAppends)
    ) {
      throw new Error(
        "Authority probe must observe policy assertions, real tools, and committed message updates",
      );
    }
    if (
      values["session-event-wake"] &&
      values["authority-counts"] &&
      !authorityCounts?.host?.counts["session-event-handoff.assertEffectCurrent"]
    ) {
      throw new Error("Session-event probe did not exercise its handoff effect authority");
    }
    if (values["mixed-rpc"] && Object.values(rpcLatencies).some((latencies) => !latencies.length)) {
      throw new Error("mixed RPC workload must observe every method; increase cohort duration");
    }
    if (listIntervalMs && listLatencies.length === 0) {
      throw new Error("No sessions.list samples collected; shorten --list-interval-ms");
    }
    const diagnostics = finishGatewayDiagnostics
      ? { gateway: await finishGatewayDiagnostics(), controller: finishControllerDiagnostics?.() }
      : undefined;
    const broadcastTimings = (allocation?.diagnostics ?? diagnostics?.gateway)?.groups.filter(
      (group) => group.channel === "openclaw.benchmark.broadcast",
    );
    if (values["broadcast-timing"] && !broadcastTimings?.length) {
      throw new Error("Broadcast timing observed no calls in the measured window");
    }
    const projectionCounts = diagnostics?.gateway.groups.filter(
      (group) => group.channel === "openclaw.benchmark.session-projection",
    );
    if (values["session-projection-counts"] && !projectionCounts?.length) {
      throw new Error("Session projection counts observed no publications in the measured window");
    }
    assertGatewayAlive();
    if (clients.some((client) => client.ws.readyState !== client.ws.OPEN)) {
      throw new Error("a subscriber was lost during the measured round");
    }
    if (
      turnScenario &&
      ((!values["turn-start-phases"] && peakPrimaryStreams !== Math.min(runCount, sessionCount)) ||
        primaryStreamRequests !== sessionCount)
    ) {
      throw new Error(
        `expected ${sessionCount} primary streams with ${Math.min(runCount, sessionCount)} concurrent: peak=${peakPrimaryStreams}, requests=${primaryStreamRequests}`,
      );
    }
    if (
      (scenario === "chat.send" || soakScenario || idleScenario) &&
      (toolCalls !== sessionCount || toolResults !== sessionCount)
    ) {
      throw new Error(
        `expected ${sessionCount} completed tool calls, calls=${toolCalls}, results=${toolResults}`,
      );
    }
    if (
      retentionScenario &&
      (toolCalls !== runCount * toolPaths.length ||
        toolResults !== toolCalls ||
        outputLimitResponses !== runCount ||
        recoveredResponses !== runCount ||
        imageRequests !== runCount * 3)
    ) {
      throw new Error(
        `expected ${runCount} image/tool/recovery cycles: ${JSON.stringify({ toolCalls, toolResults, outputLimitResponses, recoveredResponses, imageRequests })}`,
      );
    }
    if (
      reasoningScenario &&
      (reasoningResponses !== sessionCount * (retentionScenario ? 3 : 2) ||
        reasoningReplayRequests !== sessionCount * (retentionScenario ? 2 : 1))
    ) {
      throw new Error(
        `incomplete synthetic reasoning replay: ${JSON.stringify({ reasoningResponses, reasoningReplayRequests })}`,
      );
    }
    if (values["stress-network-tool"] && networkToolRequests !== toolCalls) {
      throw new Error(
        `expected one HTTP request per Code Mode cell: ${networkToolRequests}/${toolCalls}`,
      );
    }
    if (verifyHistoryReplay && historicalReplayRequests !== sessionCount) {
      throw new Error(
        `Deep history reached only ${historicalReplayRequests}/${sessionCount} foreground turns`,
      );
    }
    teamStressFanout?.assertComplete();
    // Exact turn-start receipts replace window-wide fanout equality under background churn.
    for (const event of turnScenario && !teamStressFanout && !values["turn-start-phases"]
      ? ["session.message", "sessions.changed"]
      : []) {
      const expected = perClientCounters[0]?.get(event) ?? 0;
      if (!expected || perClientCounters.some((counts) => counts.get(event) !== expected)) {
        throw new Error(
          `incomplete ${event} fanout: ${JSON.stringify(perClientCounters.map((counts) => counts.get(event) ?? 0))}`,
        );
      }
    }
    if (
      values["activity-summaries"] &&
      (!recapRequests ||
        ![...sessionEventSizes].some(
          ([bucket, counts]) =>
            bucket.startsWith("sessions.changed:activity-summary:") && counts.frames > 0,
        ))
    ) {
      throw new Error(
        "activity recap model requests and sessions.changed events were not observed",
      );
    }
    const cpu = measureGatewayCpuUsage(before, await readGatewayCpuUsage(gateway));
    const retainedResources =
      retentionScenario || idleScenario
        ? await readGatewayResources(gateway, {
            includeWorkers: true,
            collectGarbage: true,
            sessionCensus: values["session-census"],
            ...(idleScenario && values["heap-snapshot"]
              ? {
                  snapshotPath: path.join(
                    output,
                    round === 0 ? "post-work.heapsnapshot" : "post-reopen.heapsnapshot",
                  ),
                }
              : {}),
            ...(retentionScenario && values["heap-snapshot"] && round === rounds - 1
              ? { snapshotPath: path.join(output, "settled.heapsnapshot") }
              : {}),
          })
        : undefined;
    const deliveredEvents = [...counters.values()].reduce((sum, count) => sum + count, 0);
    const deliveredSessionEvents =
      (counters.get("session.message") ?? 0) + (counters.get("sessions.changed") ?? 0);
    const sourceEvents = deliveredSessionEvents / clientCount;
    const sortedListLatencies = listLatencies.toSorted((a, b) => a - b);
    const sample = {
      round,
      scenario,
      ...(values["stress-network-tool"] ? { networkToolRequests } : {}),
      allocation,
      ...(values["config-capture-counts"]
        ? {
            configCaptureCounts: {
              ...JSON.parse(readFileSync(configCaptureCountsPath, "utf8")),
              primaryTurns: sessionCount,
            },
          }
        : {}),
      ...(authorityCounts
        ? {
            operatorAccessPolicy: {
              ...authorityCounts,
              scope:
                "plugin callbacks in the measured turn window; not all host authority invocations",
              primaryTurns: sessionCount,
              sourceEvents,
              policyCount: operatorAccessPolicyCount,
              assertionsPerTurn: authorityCounts.assert / sessionCount,
              assertionsPerSourceEvent: sourceEvents
                ? authorityCounts.assert / sourceEvents
                : undefined,
              assertionsPerToolCompletion: authorityCounts.assert / authorityCounts.tools,
              assertionsPerMessageAppend: authorityCounts.assert / authorityCounts.messageAppends,
              workloadAllocatedBytesPerAssertion: allocation
                ? allocation.sampledAllocatedBytes / authorityCounts.assert
                : undefined,
            },
          }
        : {}),
      ...(workloadCpuProfilePath
        ? { workloadCpuProfile: summarizeCpuProfile(workloadCpuProfilePath) }
        : {}),
      rpc: Object.fromEntries(
        [...rpcMeasurements].map(([method, measurements]) => [
          method,
          {
            ...latencySummary(measurements.latenciesMs),
            latenciesMs: measurements.latenciesMs,
            callsPerMinute: (measurements.latenciesMs.length / cpu.wallMs) * 60_000,
            responseBytes: measurements.responseBytes,
            responseBytesPerCall: measurements.responseBytes / measurements.latenciesMs.length,
            ...(measurements.representativeResponse
              ? { representativeResponse: measurements.representativeResponse }
              : {}),
          },
        ]),
      ),
      ...(values["dashboard-rpc"] ? { rpcRequests: listRequests } : {}),
      ...(connectionScenario
        ? {
            handshake: latencySummary(handshakeLatenciesMs),
            reconnectStorms: [...reconnectStorms],
          }
        : {}),
      ...(turnScenario && allocation
        ? { allocatedMbPerTurn: allocation.estimatedAllocatedBytesPerOperation / 1_000_000 }
        : {}),
      diagnostics,
      ...(values["session-projection-counts"]
        ? {
            sessionProjectionCounts: Object.fromEntries(
              (projectionCounts ?? []).map((group) => {
                const publications = group.metrics.publications?.total ?? 0;
                const audienceCacheMisses = group.metrics.audienceCacheMisses?.total ?? 0;
                const payloadCacheMisses = group.metrics.payloadCacheMisses?.total ?? 0;
                const projectedRecipients = group.metrics.projectedRecipients?.total ?? 0;
                const wirePayloads = group.metrics.wirePayloads?.total ?? 0;
                return [
                  group.operation,
                  {
                    publications,
                    audienceCacheMisses,
                    payloadCacheMisses,
                    projectedRecipients,
                    wirePayloads,
                    audienceCacheMissesPerPublication: publications
                      ? audienceCacheMisses / publications
                      : null,
                    payloadCacheMissesPerPublication: publications
                      ? payloadCacheMisses / publications
                      : null,
                    projectedRecipientsPerPublication: publications
                      ? projectedRecipients / publications
                      : null,
                    wirePayloadsPerPublication: publications ? wirePayloads / publications : null,
                  },
                ];
              }),
            ),
          }
        : {}),
      ...(values["broadcast-timing"]
        ? {
            broadcastLatencyMs: Object.fromEntries(
              (broadcastTimings ?? []).map((group) => [group.operation, group.metrics.durationMs]),
            ),
          }
        : {}),
      streamStart,
      ...(values["mixed-rpc"]
        ? {
            ...(recordListRequests ? { rpcRequests: listRequests } : {}),
            rpcLatencyMs: Object.fromEntries(
              Object.entries(rpcLatencies).map(([method, latencies]) => [
                method,
                summarizeLatencies(latencies),
              ]),
            ),
          }
        : {}),
      activeWorkCounts,
      toolCalls,
      toolResults,
      ...(values["usage-rpc"] ? { usageCacheStatuses } : {}),
      ...(reasoningScenario && { reasoningResponses, reasoningReplayRequests }),
      verifyHistoryReplay,
      ...(verifyHistoryReplay ? { historicalReplayRequests } : {}),
      recapRequests,
      ...(values["activity-summaries"] ? { recapPhase, recapReceipts: [...recapReceipts] } : {}),
      ...(retentionScenario
        ? { outputLimitResponses, recoveredResponses, imageRequests, retainedResources }
        : {}),
      ...(idleScenario
        ? {
            phase: round === 0 ? "touch" : "reopen",
            retainedResources,
            turnCohorts: idleTurnCohorts,
          }
        : {}),
      ...cpu,
      chatDeltaDeliveryMs: summarizeLatencies([...chatDeltaDeliveryMs]),
      ...(values["transport-counts"]
        ? {
            transportCounts: JSON.parse(
              readFileSync(path.join(output, "transport-counts.json"), "utf8"),
            ),
          }
        : {}),
      eventCounts: Object.fromEntries(counters),
      eventBytes: Object.fromEntries(eventBytes),
      sessionEventSizes: Object.fromEntries(sessionEventSizes),
      representativeFrames: Object.fromEntries(representativeFrames),
      ...(listIntervalMs
        ? {
            sessionsList: {
              count: listLatencies.length,
              p50: sortedListLatencies[Math.ceil(listLatencies.length * 0.5) - 1],
              p95: sortedListLatencies[Math.ceil(listLatencies.length * 0.95) - 1],
              p99: sortedListLatencies[Math.ceil(listLatencies.length * 0.99) - 1],
              latencies: listLatencies,
              ...(values["poll-seed"] !== undefined ? { initialPollPhasesMs } : {}),
              ...(recordListRequests
                ? {
                    requests: listRequests.filter((request) => request.method === "sessions.list"),
                    p99Request: listRequests
                      .filter((request) => request.method === "sessions.list")
                      .toSorted((a, b) => a.durationMs - b.durationMs)[
                      Math.ceil(listLatencies.length * 0.99) - 1
                    ],
                  }
                : {}),
            },
          }
        : {}),
      perClientEventCounts: perClientCounters.map((counts) => Object.fromEntries(counts)),
      peakStreams,
      peakPrimaryStreams,
      primaryStreamRequests,
      utilityStreamRequests:
        streamRequests -
        primaryStreamRequests -
        (retentionScenario ? outputLimitResponses + recoveredResponses : toolResults),
      streamRequests,
      deliveredEvents,
      deliveredSessionEvents,
      sourceEvents,
      mainThreadMsPerSessionEvent: sourceEvents ? cpu.mainThread.totalMs / sourceEvents : null,
      mainThreadMsPerSessionEventDelivery: deliveredSessionEvents
        ? cpu.mainThread.totalMs / deliveredSessionEvents
        : null,
      estimatedAllocatedBytesPerSessionEvent:
        allocation && sourceEvents ? allocation.sampledAllocatedBytes / sourceEvents : null,
      broadcastAllocatedBytesPerSessionEvent:
        allocation && sourceEvents
          ? allocation.broadcastAllocation.sampledBytes / sourceEvents
          : null,
      broadcastAllocatedBytesPerTurn:
        allocation && turnScenario
          ? allocation.broadcastAllocation.sampledBytes / sessionCount
          : null,
      mainThreadMsPerSecond: (cpu.mainThread.totalMs / cpu.wallMs) * 1000,
      sessionEventsPerSecond: (sourceEvents / cpu.wallMs) * 1000,
    };
    samples.push(sample);
    const samplePath = path.join(output, `round-${round}.json`);
    writeFileSync(samplePath, JSON.stringify(sample));
    console.log(
      `ROUND ${JSON.stringify({
        round,
        scenario,
        samplePath,
        deliveredSessionEvents,
        primaryStreamRequests,
        sessionResets,
      })}`,
    );
    if (idleScenario) {
      await verifyIdleHistories(round === 0 ? "touched" : "reopened");
      if (round === 0) {
        const finishIdleDiagnostics = await startGatewayDiagnostics(gateway, "session-idle");
        const idleStartedAt = Date.now();
        while (Date.now() - idleStartedAt < durationMs) {
          await delay(Math.min(memoryIntervalMs, durationMs - (Date.now() - idleStartedAt)));
          assertGatewayAlive();
          await sampleMemory();
        }
        idleDiagnostics = await finishIdleDiagnostics();
        postIdleResources = await sampleMemory(true, "post-idle");
        // Verify the retained prefix after reopening; reading it now warms idle workers.
      }
    }
    if (soakScenario || scenario === "plugins.reload") {
      if (soakScenario && Date.now() - (memorySamples.at(-1)?.atEpochMs ?? 0) >= memoryIntervalMs) {
        await sampleMemory();
      }
      const remainingMs = roundIntervalMs - (Date.now() - roundStartedAt);
      await delay(
        Math.max(
          0,
          soakScenario
            ? Math.min(remainingMs, durationMs - (Date.now() - measurementStartedAt))
            : remainingMs,
        ),
      );
    }
    if (allocation) {
      console.table([
        {
          scenario,
          round,
          operations: allocation.operationCount,
          "estimated bytes/op": Math.round(allocation.estimatedAllocatedBytesPerOperation),
          "GC ms": allocation.gcMs.toFixed(2),
          "GC ms/op": allocation.gcMsPerOperation.toFixed(3),
          "GC count": allocation.gcCount,
        },
      ]);
    }
  }
  for (const worker of startedHeapWorkers) {
    worker.stop = await workerHeapCommand(worker, "stop");
  }
  if (values["worker-retained-heap"]) {
    const resources = await readGatewayResources(gateway, { includeWorkers: true });
    const late = [
      ...(resources.workers?.workerHeaps ?? []),
      ...(resources.workers?.workerMemoryMissing ?? []),
    ].filter(
      (worker) =>
        targetWorkerScript(worker.script) &&
        !startedHeapWorkers.some((started) => started.threadId === worker.threadId),
    );
    if (late.length) {
      workerHeapEvidence.complete = false;
      workerHeapEvidence.errors.push(
        `Workers outside measured census: ${JSON.stringify(late.map(({ script, threadId }) => ({ script, threadId })))}`,
      );
    }
  }
  if (
    soakScenario &&
    (completedSoakRounds !== warmupRoundCount + samples.length ||
      (soakRounds !== undefined && samples.length !== soakRounds))
  ) {
    throw new Error("Memory-soak completion did not match the declared warmup and measured work");
  }
  let fingerprintRetention;
  if (values["fingerprint-retention"]) {
    // Keep the diagnostic baseline through reopening. Attribute retention only
    // after another disposal interval, outside the measured latency/GC windows.
    console.log("PHASE fingerprint-retention-idle");
    await delay(durationMs);
    assertGatewayAlive();
    const censusResources = await readGatewayResources(gateway, {
      collectGarbage: true,
      sessionCensus: true,
    });
    console.log(`FINGERPRINT_RETENTION_CENSUS ${JSON.stringify(censusResources)}`);
    const census = censusResources.sessionCensus;
    if (!census || census.SessionManager || census.AgentSession || census.Agent) {
      throw new Error("Fingerprint retention requires all session runtime objects to be disposed");
    }
    // Keep census allocations out of the like-for-like forced-GC memory samples.
    const before = await readGatewayResources(gateway, { collectGarbage: true });
    const after = await readGatewayResources(gateway, {
      collectGarbage: true,
      clearPromptCacheObservations: true,
    });
    fingerprintRetention = {
      censusResources,
      before,
      after,
      heapBytes: before.memory.heapUsed - after.memory.heapUsed,
      externalBytes: before.memory.external - after.memory.external,
      arrayBufferBytes: before.memory.arrayBuffers - after.memory.arrayBuffers,
    };
    console.log(`FINGERPRINT_RETENTION ${JSON.stringify(fingerprintRetention)}`);
  }
  if (soakScenario && soakRounds !== undefined) {
    // Keep equal work counts without shortening the continuous GC/allocation window.
    await delay(Math.max(0, durationMs - (Date.now() - measurementStartedAt)));
  }
  const wholeSoakResourcesAfter =
    soakScenario || values["turn-start-phases"]
      ? await readGatewayResources(gateway, { includeWorkers: true })
      : undefined;
  const wholeWorkloadDiagnostics = await finishWholeWorkloadDiagnostics?.();
  if (values["turn-start-phases"]) {
    const child = gateway;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("exit", onExit);
        child.off("error", finish);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const onMessage = (message: unknown) => {
        if (isRecord(message) && message.turnStartTimelineFlushed === true) {
          if (typeof message.dropped === "number") {
            turnStartTimelineDropped = message.dropped;
          }
          finish();
        }
      };
      const onExit = () => finish(new Error("Gateway exited before turn-start timeline flush"));
      const timeout = setTimeout(
        () => finish(new Error("Turn-start timeline flush timed out")),
        60_000,
      );
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.once("error", finish);
      child.send({ turnStartTimelineFlush: true }, (error) => {
        if (error) {
          finish(error);
        }
      });
    });
    writeFileSync(
      path.join(output, "turn-start-timeline.json"),
      JSON.stringify(
        {
          limit: turnStartTimelineLimit,
          dropped: turnStartTimelineDropped,
          events: turnStartTimeline,
        },
        null,
        2,
      ),
    );
  }
  const wholeSoakCpu = wholeSoakCpuBefore
    ? measureGatewayCpuUsage(wholeSoakCpuBefore, await readGatewayCpuUsage(gateway))
    : undefined;
  if (values["team-stress"]) {
    teamStressTelemetryActive = false;
    flushTeamStressRpcMinute();
    await controlTeamStressTelemetry(gateway, "stop");
  }
  const execIoAfter = values["exec-io-storm"] ? readExecIoProgress() : [];
  if (
    values["exec-io-storm"] &&
    execIoAfter.some((writer, index) => writer.bytesWritten <= execIoBefore[index]!.bytesWritten)
  ) {
    throw new Error("Synthetic IO writers did not make progress during measurement");
  }
  if (workerHeapDoneFile && workerHeapPeerDoneFile) {
    writeFileSync(workerHeapDoneFile, String(Date.now()));
    // Long captures need room for a slower peer before either side forces GC.
    const deadline = Date.now() + Math.max(120_000, Date.now() - measurementStartedAt);
    while (!existsSync(workerHeapPeerDoneFile)) {
      if (Date.now() >= deadline) {
        throw new Error("Measurement peer did not finish its timing window");
      }
      await delay(100);
    }
  }
  if (values["dashboard-rpc"] && dashboardFixtureRequests === 0) {
    throw new Error("Dashboard GitHub preview never reached the synthetic transport");
  }
  if (
    values["github-options-observe"] &&
    (!githubObservationOwner ||
      !githubAvailabilityOwner ||
      !githubStages.some(({ phase }) => phase === "handler"))
  ) {
    throw new Error(
      "GitHub options source observation requires both owners loaded and a measured handler",
    );
  }
  let wholeSoakAllocation;
  if (soakAllocationPath) {
    // Stop after the GC/loop window so the profiler's forced collection cannot affect acceptance.
    await controlGatewayProfile(gateway, "heap", "stop", soakAllocationPath);
    measuringWholeSoakAllocation = false;
    const profile = readGatewayHeapProfile(soakAllocationPath, {
      samplingIntervalBytes: soakSamplingIntervalBytes,
    });
    const completedTurns = samples.length * runCount;
    wholeSoakAllocation = {
      ...profile,
      completedTurns,
      deliveredSessionEvents: wholeSoakDeliveredSessionEvents,
      deliveryCountScope:
        "controller session-event receipts from allocation-start request through allocation-stop acknowledgment, including idle gaps and control edges",
      allocatedMbPerTurn: profile.sampledAllocatedBytes / 1_000_000 / completedTurns,
      ...(values["worker-allocations"]
        ? { workerManifestPath: `${soakAllocationPath}.workers.json` }
        : {}),
    };
  }
  // Both worker and whole-workload timing windows have ended before forced collections.
  for (const worker of startedHeapWorkers) {
    if (worker.stop?.ok === true) {
      worker.after = await workerHeapCommand(worker, "collect");
    }
  }
  let retainedProfile;
  if (soakScenario) {
    await sampleMemory();
    await sampleMemory(true);
    if (retainedProfileStartedAt !== undefined) {
      await controlGatewayProfile(gateway, "heap", "stop", retainedProfilePath);
      const { sampledAllocatedBytes, topAllocationSites, ...profile } = readGatewayHeapProfile(
        retainedProfilePath,
        { includeCollectedObjects: false },
      );
      retainedProfile = {
        ...profile,
        startedAtEpochMs: retainedProfileStartedAt,
        stoppedAtEpochMs: Date.now(),
        sampledRetainedBytes: sampledAllocatedBytes,
        topRetainedSites: topAllocationSites,
      };
    } else if (retainedProfileMs > 0) {
      throw new Error("no retained profile window captured; shorten the round duration");
    }
    if (values["heap-snapshot"]) {
      await readGatewayResources(gateway, {
        snapshotPath: path.join(output, "settled.heapsnapshot"),
      });
    }
  }
  let diffEditVisibilityMs: number | undefined;
  if (values["mixed-rpc"] && stressWorktree && diffControlOriginal !== undefined) {
    writeFileSync(
      path.join(stressWorktree, "README.md"),
      `${diffControlOriginal}Synthetic diff control.\nSynthetic edit control.\n`,
    );
    const editStarted = performance.now();
    let diff;
    do {
      diff = await rpc(sender, "sessions.diff", {
        sessionKey: parentKey,
        scope: "all",
        summaryOnly: true,
      });
      if (isRecord(diff) && diff.additions === 2) {
        break;
      }
      await delay(100);
    } while (performance.now() - editStarted < 12_000);
    validateDiff(diff, 2);
    diffEditVisibilityMs = performance.now() - editStarted;
  }
  let cronRuns;
  if (stressCronJobId) {
    // Snapshot completed runs before disabling can cancel an in-flight scheduled turn.
    const history = await rpc(sender, "cron.runs", { id: stressCronJobId, limit: 200 });
    await rpc(sender, "cron.update", { id: stressCronJobId, patch: { enabled: false } });
    if (
      !isRecord(history) ||
      !Array.isArray(history.entries) ||
      !history.entries.length ||
      history.entries.some((entry: unknown) => !isRecord(entry) || entry.status !== "ok")
    ) {
      throw new Error("stress cron history is missing or contains a failed run");
    }
    cronRuns = history.entries.filter(
      (entry: { runAtMs?: number }) => (entry.runAtMs ?? 0) >= measurementStartedAt,
    );
    if (durationMs >= 60_000 && !cronRuns.length) {
      throw new Error("stress cron did not complete during the measured soak");
    }
  }
  // Capture filter/paging equivalence after the measured window, without warming its caches.
  const listResponses: Array<{ params: unknown; payload: unknown }> = [];
  if (values["capture-responses"] && scenario === "sessions.patch") {
    const responses: Array<{ params: SessionsPatchParams; payload: unknown }> = [];
    for (let sequence = 0; sequence < 6; sequence++) {
      const params = sessionPatchParams(0, sequence);
      const payload = await rpc(sender, "sessions.patch", params);
      assertSessionPatch(params, payload);
      responses.push({ params, payload });
    }
    writeFileSync(path.join(output, "patch-responses.json"), JSON.stringify(responses));
  }
  if (values["capture-responses"] && (scenario === "sessions.list" || soakScenario)) {
    // Fresh harness sessions contain random IDs and current clocks; compare the seeded roster.
    if (!historyTurns) {
      for (const key of [...keys, parentKey]) {
        await rpc(sender, "sessions.delete", { key, deleteTranscript: true });
      }
    }
    for (const request of [
      {},
      { limit: 1 },
      { offset: 1 },
      { offset: 199 },
      { offset: fixtureSessionCount },
      { archived: false },
      { archived: true },
      { sortBy: "updatedAt" },
      { sortBy: "lastInteractionAt" },
      { sortBy: "activity" },
      { pinned: true },
      { pinned: false },
      { search: "team" },
      { search: "no-such-synthetic-session" },
      { agentId: "main" },
      { excludeSubagents: true },
      { excludeSystem: true, excludeCron: true },
      { requireLastInteraction: true },
      { includeGlobal: true, includeUnknown: true },
      { ownerFirst: true },
      ...(values["list-profile-reference"]
        ? [
            { involvingProfileId: values["list-profile-reference"] },
            { involvingProfileId: "team-shape-profile-0", includePeople: true },
            { involvingProfileId: "team-shape-profile-0", archived: true },
            { involvingProfileId: "team-shape-profile-0", search: "no-such-synthetic-session" },
          ]
        : []),
    ]) {
      const params = { limit, rowMode, archived: "all", ...request };
      listResponses.push({ params, payload: await rpc(sender, "sessions.list", params) });
    }
    writeFileSync(path.join(output, "list-responses.json"), JSON.stringify(listResponses));
  }
  if (values["worker-heap-snapshot"]) {
    // Capture serially after every metric/profile window; snapshots cannot alter recorded timings.
    const heapBytes = (worker: WorkerHeapEvidence) =>
      isRecord(worker.after?.memory) && typeof worker.after.memory.heapUsed === "number"
        ? worker.after.memory.heapUsed
        : -1;
    for (const script of [
      "sqlite-store.worker.js",
      "prepared-model-catalog.worker.js",
      "git-operation.worker.js",
      "openclaw-state-read.worker.js",
      "session-accessor.sqlite-archive.worker.js",
      ...(values["knowledge-worker-heap"] ? ["storage-worker.js"] : []),
    ]) {
      const largest = startedHeapWorkers
        .filter((worker) => worker.script === script && worker.after?.ok === true)
        .toSorted((a, b) => heapBytes(b) - heapBytes(a))[0];
      if (largest) {
        largest.snapshot = await workerHeapCommand(largest, "snapshot");
      }
    }
  }
  let coldIdle;
  if (coldIdleMs !== undefined && coldIdleKey !== undefined) {
    // All polling has stopped and the synthetic stress cron is disabled above.
    // Keep ordinary Gateway maintenance enabled; issue no workload requests during quiet.
    await drainEvents();
    const before = await readGatewayResources(gateway, { includeWorkers: true });
    const startedAtEpochMs = Date.now();
    console.log(
      `PHASE cold-idle ${JSON.stringify({ startedAtEpochMs, durationMs: coldIdleMs, sessionKey: coldIdleKey })}`,
    );
    while (Date.now() - startedAtEpochMs < coldIdleMs) {
      await delay(Math.min(30_000, coldIdleMs - (Date.now() - startedAtEpochMs)));
      assertGatewayAlive();
    }
    const elapsedMs = Date.now() - startedAtEpochMs;
    const after = await readGatewayResources(gateway, { includeWorkers: true });
    const historyReadStartedAt = performance.now();
    const history = await rpc(sender, "chat.history", { sessionKey: coldIdleKey, limit: 50 });
    const historyReadMs = performance.now() - historyReadStartedAt;
    if (
      !isRecord(history) ||
      !Array.isArray(history.messages) ||
      !history.messages.length ||
      !history.messages.some(
        (message: unknown) => isRecord(message) && contentText(message.content).length > 0,
      )
    ) {
      throw new Error("Post-idle chat.history did not return the reserved fixture transcript");
    }
    const responsePath = path.join(output, "cold-idle-history.json");
    const response = JSON.stringify(history);
    writeFileSync(responsePath, `${response}\n`);
    const afterHistoryRead = await readGatewayResources(gateway, { includeWorkers: true });
    const archiveStarts = (resources: typeof before) =>
      resources.workers?.workerLifecycle
        .filter((worker) =>
          /^session-accessor\.sqlite-archive\.worker\.[cm]?[jt]s$/.test(worker.script),
        )
        .reduce((sum, worker) => sum + worker.started, 0) ?? 0;
    coldIdle = {
      requestedMs: coldIdleMs,
      startedAtEpochMs,
      elapsedMs,
      sessionKey: coldIdleKey,
      before,
      after,
      afterHistoryRead,
      quietArchiveWorkerStarts: archiveStarts(after) - archiveStarts(before),
      archiveWorkerStartsDuringHistoryRead: archiveStarts(afterHistoryRead) - archiveStarts(after),
      historyReadMs,
      messageCount: history.messages.length,
      responsePath,
      responseSha256: createHash("sha256").update(response).digest("hex"),
    };
  }
  const consumedMcpCatalogs = [];
  if (values["turn-start-rich-context"]) {
    for (const key of richContextSessionKeys) {
      const usage = await rpc(sender, "sessions.usage", {
        range: "all",
        key,
        includeContextWeight: true,
      });
      const session =
        isRecord(usage) && Array.isArray(usage.sessions)
          ? usage.sessions.find((row: unknown) => isRecord(row) && row.key === key)
          : undefined;
      const report = isRecord(session) ? session.contextWeight : undefined;
      const tools = isRecord(report) && isRecord(report.tools) ? report.tools : undefined;
      const deferred = tools && isRecord(tools.deferred) ? tools.deferred : undefined;
      const entries: unknown[] = [
        ...(Array.isArray(tools?.entries) ? tools.entries : []),
        ...(Array.isArray(deferred?.entries) ? deferred.entries : []),
      ];
      const servers = Object.fromEntries(
        ["context_a", "context_b"].map((serverName) => {
          const names = entries.flatMap((entry) =>
            isRecord(entry) &&
            entry.source === "mcp" &&
            entry.serverName === serverName &&
            typeof entry.name === "string"
              ? [entry.name]
              : [],
          );
          if (names.length !== 40 || new Set(names).size !== 40) {
            throw new Error(
              `Consumed MCP catalog for ${key}/${serverName} has ${names.length} entries and ${new Set(names).size} unique names; expected 40`,
            );
          }
          return [serverName, { count: names.length, names: names.toSorted() }];
        }),
      );
      consumedMcpCatalogs.push({ sessionKey: key, servers });
    }
    if (!consumedMcpCatalogs.length) {
      throw new Error("No rich-context sessions were verified through their prompt reports");
    }
  }
  // Process exit plus drained log streams makes promotion accounting independent of pipe buffering.
  await cleanup();
  const wholeChatGc =
    wholeChatDiagnosticsEnabled && wholeWorkloadDiagnostics && values["trace-gc"]
      ? readGatewayGcTrace(path.join(output, "gateway.stdout.log"), "whole-chat", "diagnostics")
      : undefined;
  let wholeSoakGc;
  if (soakScenario && wholeWorkloadDiagnostics && (values.allocations || values["trace-gc"])) {
    const trace = readGatewayGcTrace(
      path.join(output, "gateway.stdout.log"),
      "whole-soak",
      "diagnostics",
    );
    const completedTurns = samples.length * runCount;
    const wallMs = wholeWorkloadDiagnostics.durationMs;
    wholeSoakGc = {
      ...trace,
      completedTurns,
      wallMs,
      promotedMbPerTurn: trace.promotedBytes / 1_000_000 / completedTurns,
      scavengeSecondsPerMinute:
        ((wholeWorkloadDiagnostics.gc.minorDurationMs?.total ?? 0) * 60) / wallMs,
      majorSecondsPerMinute:
        ((wholeWorkloadDiagnostics.gc.majorDurationMs?.total ?? 0) * 60) / wallMs,
    };
  }
  const expectedTurnStartHistoryReplays = (warmupRoundCount + samples.length) * sessionCount;
  if (
    values["turn-start-phases"] &&
    historyTurns &&
    turnStartHistoryReplayCounts.length !== expectedTurnStartHistoryReplays
  ) {
    throw new Error(
      `Turn-start history verification missed provider requests: ${turnStartHistoryReplayCounts.length}/${expectedTurnStartHistoryReplays}`,
    );
  }
  if (
    values["turn-start-rich-context"] &&
    ["context_a", "context_b"].some((name) => !richContextMcpLists[name])
  ) {
    throw new Error("Rich turn-start context did not list both synthetic MCP servers");
  }

  const result = {
    output,
    ...(coldIdle ? { coldIdle } : {}),
    gatewayPreload,
    gatewayReadyMs,
    syntheticPlugins: Math.max(syntheticPluginCount, reloadPluginId || scopePluginId ? 1 : 0),
    ...(values["plugin-update"]
      ? {
          pluginUpdate: {
            scope: "source edit through successful RPC verification of the new revision",
            latency: latencySummary(pluginUpdateLatenciesMs),
          },
        }
      : {}),
    ...(values["worker-retained-heap"] ? { workerHeapEvidence } : {}),
    scenario,
    ...(scenario === "chat.startup"
      ? {
          startup: {
            temperature: startupTemperature,
            targets: startupTargets,
            sourcePreload: startupSourcePreload,
            scope:
              "cold means first chat.startup for each retained session in this Gateway; filesystem and agent database may already be warm",
          },
        }
      : {}),
    defaultStateDir: values["default-state-dir"],
    verifyHistoryReplay,
    revision: values.revision ?? null,
    operationsPerRound: turnScenario ? sessionCount : operations,
    completedRounds: samples.length,
    sessionResets,
    warmupOperations: turnScenario ? undefined : warmupOperations,
    scheduledStartAtEpochMs: startAt,
    warmReadyAtEpochMs,
    warmStartReleasedAtEpochMs,
    rpcConcurrency,
    rpcIntervalMs,
    reconnectStaggerMs,
    rpcLatencyScope:
      "client request-to-response; handler and queue timings are in Gateway diagnostics",
    perEventResourceScope:
      "whole measured workload main-isolate CPU and sampled allocations divided by session publications or deliveries; not encode/send-only cost",
    broadcastLatencyScope: values["broadcast-timing"]
      ? "broadcastLatencyMs times synchronous broadcastInternal calls by event, including targeted and retained sends; chatDeltaDeliveryMs times Gateway chat timestamp to subscriber receipt"
      : "chatDeltaDeliveryMs measures Gateway chat timestamp to subscriber receipt; no broadcastInternal duration timer is installed",
    connectionMeasurementScope: connectionScenario
      ? "owned socket replacement; handshake includes WebSocket open and connect; reconnect adds subscribe and list; events during intentional disconnection are not replayed"
      : undefined,
    limit,
    rowMode,
    sessionRowDeltas: values["session-row-deltas"],
    sessionCapabilityCohorts: sessionCapabilityCohorts.filter((value) => value.clients > 0),
    presenceDeltas: values["presence-deltas"],
    sessionEnvelopeRefs: values["session-envelope-refs"],
    listIntervalMs,
    pollBetweenRounds,
    mixedRpc: values["mixed-rpc"],
    usageRpc: values["usage-rpc"],
    ...(values["exec-io-storm"]
      ? {
          execIoStorm: {
            writers: execIoStarted.size,
            before: execIoBefore,
            after: execIoAfter,
            writerArtifacts: [...execIoStarted].map((index) =>
              path.join(output, `agent-exec-io-${index}.jsonl`),
            ),
            commits: JSON.parse(
              readFileSync(path.join(output, "agent-exec-io-commits.json"), "utf8"),
            ),
          },
        }
      : {}),
    ...(values["team-stress"]
      ? {
          teamStress: {
            churnIntervalMs: teamStressChurnMs,
            committedWrites: teamStressWrites,
            targets: teamStressTargets.length,
            prometheusScrapes: teamStressPrometheusScrapes,
            rpcMinutes: teamStressRpcMinutes,
            telemetry: JSON.parse(readFileSync(path.join(output, "stress-telemetry.json"), "utf8")),
          },
        }
      : {}),
    ...(values["dashboard-rpc"]
      ? {
          dashboardRpc: {
            methods: dashboardRpcShapes.map(({ method }) => method),
            dashboardFixtureRequests,
            ...(values["github-options-observe"]
              ? {
                  githubObservation: {
                    owner: githubObservationOwner,
                    availabilityOwner: githubAvailabilityOwner,
                    stages: githubStages,
                  },
                }
              : {}),
            ...(values["github-options-connected"]
              ? {
                  githubOptionsConnected: {
                    additionalScopedSockets: githubOptionsClients.length,
                    accountId: 1516,
                    accountVerificationDelayMs: [300, 600, 900],
                    accountRenameAfterMs: 60_000,
                    upstreamRequests: githubFixtureRequests,
                    upstreamByRoute: Object.fromEntries(
                      [...new Set(githubFixtureRequests.map((request) => request.route))].map(
                        (route) => {
                          const requests = githubFixtureRequests.filter(
                            (request) => request.route === route,
                          );
                          return [
                            route,
                            {
                              count: requests.length,
                              totalMs: requests.reduce(
                                (sum, request) => sum + request.durationMs,
                                0,
                              ),
                              latencyMs: latencySummary(
                                requests.map((request) => request.durationMs),
                              ),
                            },
                          ];
                        },
                      ),
                    ),
                    observations: githubOptionsObservations,
                    accountRenameObserved: githubOptionsObservations.some(
                      (observation) => observation.login === "synthetic-shared-updated",
                    ),
                  },
                }
              : {}),
            diffWorktrees: diffTargets.map(({ sessionKey, worktree }) => ({
              sessionKey,
              worktree,
            })),
          },
          coldSetupRpc,
        }
      : {}),
    stressTools: values["stress-tools"],
    worktreeToolChurn: values["worktree-tool-churn"],
    ...(values["worktree-tool-churn"]
      ? {
          worktreeTools: {
            sessions: [...worktreeToolRoots].map(([index, worktree]) => ({
              sessionKey: keys[index - 1],
              worktree,
            })),
            successfulListSearches: Object.fromEntries(worktreeToolSearches),
          },
        }
      : {}),
    stressShellWords,
    stressWorktreeFanout: values["stress-worktree-fanout"],
    stressWorktrees: values["stress-worktree-fanout"] ? [...worktreeToolRoots.values()] : [],
    workerCreationCounts: values["worker-creation-counts"],
    coldHistorySessions: coldHistoryKeys.length,
    coldHistoryRequests: coldHistorySequence,
    nodePolicyChurn: values["node-policy-churn"],
    ...(values["node-policy-churn"]
      ? { policyNodeId, policyNodeCommandCount: policyNodeCommands.length }
      : {}),
    stressSessionStore: values["stress-session-store"],
    stressToolSearch: values["stress-tool-search"],
    stressNetworkTool: values["stress-network-tool"],
    transcriptHydrationCounts: values["transcript-hydration-counts"],
    operatorAccessPolicy: values["operator-access-policy"],
    operatorAccessPolicyCount,
    cronOperatorTurn: values["cron-operator-turn"],
    sessionEventWake: values["session-event-wake"],
    authorityCounts: values["authority-counts"],
    configCaptureCounts: values["config-capture-counts"],
    configCaptureSource: configCaptureSource
      ? Object.fromEntries(
          Object.entries(configCaptureSource).map(([file, value]) => [file, value.sha256]),
        )
      : undefined,
    configShape: {
      serializedBytes: Buffer.byteLength(JSON.stringify(cfg)),
      agents: Object.keys(cfg.agents?.entries ?? {}).length,
      pluginEntries: Object.keys(cfg.plugins?.entries ?? {}).length,
    },
    authoritySourcePreload,
    node: process.version,
    stressSubagents: values["stress-subagents"],
    cronRuns,
    ...(values["mixed-rpc"] ? { diffEditControlVerified: true, diffEditVisibilityMs } : {}),
    pollSeed: values["poll-seed"] ?? null,
    diagnostics: values.diagnostics,
    broadcastTiming: values["broadcast-timing"],
    workerAttribution: process.env.OPENCLAW_BENCH_WORKER_ATTRIBUTION === "1",
    sessionProjectionCounts: values["session-projection-counts"],
    sessionProjectionSource,
    inliningDisabled: values["disable-inlining"],
    transportCounts: values["transport-counts"],
    compressed: proxyViewers,
    distinctViewers: values["distinct-viewers"],
    viewerProfileCount: viewerProfiles.size,
    cpuProfile: values["cpu-profile"],
    workloadCpuProfile: values["workload-cpu-profile"],
    captureResponses: values["capture-responses"],
    listFilterChurn: values["list-filter-churn"],
    traceGc: values["trace-gc"] || values.allocations || values["stream-start-allocations"],
    streamStartDiagnostics: values["stream-start-diagnostics"],
    streamStartAllocations: values["stream-start-allocations"],
    activeWorkDiagnostics: values["active-work-diagnostics"],
    measurementStartedAt,
    ...(env.OPENCLAW_PERF_MEDIA_IO || env.OPENCLAW_PERF_FSYNC_DELAY_MS
      ? {
          fsyncProbe: {
            mediaIo: env.OPENCLAW_PERF_MEDIA_IO === "1",
            delayMs: Number(env.OPENCLAW_PERF_FSYNC_DELAY_MS ?? 0),
          },
        }
      : {}),
    ...(scenario === "plugins.reload" ? { wholeReloadDiagnostics: wholeWorkloadDiagnostics } : {}),
    ...(wholeChatDiagnosticsEnabled
      ? { wholeChatDiagnostics: wholeWorkloadDiagnostics, wholeChatGc }
      : {}),
    ...(values["turn-start-phases"]
      ? { turnStartResources: { before: wholeSoakResourcesBefore, after: wholeSoakResourcesAfter } }
      : {}),
    initialFullFrame,
    clientCount,
    exactClients,
    ...(sessionEventAncestors !== undefined ? { sessionEventAncestors, sessionEventLineage } : {}),
    activitySummaries: values["activity-summaries"],
    recapBurstRepeats,
    recapBurstIntervalMs,
    runCount,
    ...(scenario === "chat.send" && !values["session-event-wake"]
      ? {
          chatSendAck: latencySummary(
            samples.flatMap((sample) => sample.rpc["chat.send"]?.latenciesMs ?? []),
          ),
          chatAttachmentBytes,
          ...(chatActiveHoldMs
            ? {
                chatActiveHoldMs,
                chatActiveAfterTool: values["chat-active-after-tool"],
                activeChatSendAck: {
                  ...latencySummary(
                    samples.flatMap(
                      (sample) => sample.streamStart?.activeChatSendAck?.latenciesMs ?? [],
                    ),
                  ),
                  acknowledgedBeforeRelease: samples.reduce(
                    (sum, sample) =>
                      sum + (sample.streamStart?.activeChatSendAck?.acknowledgedBeforeRelease ?? 0),
                    0,
                  ),
                  consumedExactlyOnce: samples.reduce(
                    (sum, sample) =>
                      sum + (sample.streamStart?.activeChatSendAck?.consumedExactlyOnce ?? 0),
                    0,
                  ),
                },
              }
            : {}),
          attemptSetupImage: values["attempt-setup-image"],
          attemptSetupCatalog: [...attemptSetupCatalog].toSorted(),
          ...(values["turn-start-phases"]
            ? {
                seededHistory: {
                  turnsPerSession: historyTurns,
                  sessions: sessionCount,
                  providerReplayCounts: turnStartHistoryReplayCounts,
                  expectedProviderRequests: expectedTurnStartHistoryReplays,
                },
                ...(values["turn-start-rich-context"]
                  ? {
                      richContext: {
                        plugins: teamStressPlugins,
                        mcpServers: 2,
                        mcpToolsPerServer: 40,
                        mcpListRequests: richContextMcpLists,
                        consumedMcpCatalogs,
                        memoryPlugin: "memory-core",
                        memorySearchEnabled: false,
                      },
                    }
                  : {}),
              }
            : {}),
          coldSessionRounds,
          firstModelRequest: {
            "cold-session": latencySummary(
              samples
                .filter((sample) => sample.round < coldSessionRounds)
                .flatMap((sample) => sample.streamStart?.providerRequestMs.latencies ?? []),
            ),
            "warm-session": latencySummary(
              samples
                .filter((sample) => sample.round >= coldSessionRounds)
                .flatMap((sample) => sample.streamStart?.providerRequestMs.latencies ?? []),
            ),
          },
          ...(values["turn-start-phases"]
            ? {
                clientAckToFirstModelRequest: {
                  scope: "client ACK received to mock provider request received; paired per turn",
                  "warm-session": latencySummary(
                    samples
                      .filter((sample) => sample.round >= coldSessionRounds)
                      .flatMap(
                        (sample) =>
                          sample.streamStart?.clientAckToProviderRequestMs?.latencies ?? [],
                      ),
                  ),
                },
              }
            : {}),
          ...(values["attempt-setup-image"]
            ? { wholeAttemptSetupDiagnostics: wholeWorkloadDiagnostics }
            : {}),
        }
      : {}),
    ...(scenario === "sessions.cleanup" ? { sessionMaintenanceMode: "warn" } : {}),
    chunks: chunkCount,
    answerChunk: chunk,
    finalAnswerPhase: values["final-answer-phase"],
    chunkIntervalMs,
    peakStreams,
    streamRequests,
    fixture,
    ...(retentionScenario ? { promptBytes, initialRetainedResources } : {}),
    ...(idleScenario
      ? {
          sessionCount,
          historyTurns,
          idleDurationMs: durationMs,
          promptBytes,
          initialRetainedResources,
          postIdleResources,
          fingerprintRetention,
          heapGrowthAfterIdleBytes:
            postIdleResources && initialRetainedResources
              ? postIdleResources.memory.heapUsed - initialRetainedResources.memory.heapUsed
              : undefined,
          memorySamples,
          idleDiagnostics,
          idleGc:
            values["trace-gc"] || values.allocations
              ? readGatewayGcTrace(
                  path.join(output, "gateway.stdout.log"),
                  "session-idle",
                  "diagnostics",
                )
              : undefined,
          transcriptChecks: {
            appendOnlyAfterReopen: idleHistories.size,
          },
        }
      : {}),
    ...(soakScenario
      ? {
          durationMs,
          warmupMs,
          roundIntervalMs,
          soakRounds,
          memoryIntervalMs,
          retainedProfileMs,
          resetEveryRounds,
          historyTurns,
          historyLastTurns,
          historyPayloadBytes,
          completedSoakRounds,
          warmupCompletedRounds: warmupRoundCount,
          completedTurns: samples.length * runCount,
          initialRetainedResources,
          initialMemoryCollected,
          memorySamples,
          ...(wholeSoakResourcesBefore && wholeSoakResourcesAfter
            ? {
                wholeSoakResources: {
                  before: wholeSoakResourcesBefore,
                  after: wholeSoakResourcesAfter,
                  cpuUsage: measureGatewayCpuUsage(
                    wholeSoakResourcesBefore,
                    wholeSoakResourcesAfter,
                  ),
                },
              }
            : {}),
          retainedProfile,
          wholeSoakAllocation,
          wholeSoakDiagnostics: wholeWorkloadDiagnostics,
          wholeSoakCpu,
          ...(values["list-filter-churn"]
            ? { listFilterCounts, listFilterShapes, listChurnPatches: listChurnSequence }
            : {}),
          wholeSoakGc,
        }
      : {}),
    samples: samples.map((sample) =>
      Object.assign(sample, {
        ...(!turnScenario &&
        !connectionScenario &&
        listIntervalMs === 0 &&
        values.diagnostics &&
        !values.allocations &&
        !values["workload-cpu-profile"]
          ? {
              naturalGc: (() => {
                const operationCount = Object.values(sample.rpc).reduce(
                  (sum, measurement) => sum + measurement.count,
                  0,
                );
                if (operationCount !== operations || !sample.diagnostics) {
                  throw new Error(
                    "Natural GC capture must contain the declared completed RPC count",
                  );
                }
                const gcTrace = values["trace-gc"]
                  ? readGatewayGcTrace(
                      path.join(output, "gateway.stdout.log"),
                      `round-${sample.round}`,
                      "diagnostics",
                    )
                  : undefined;
                return {
                  operationCount,
                  timingGateEligible: !values["trace-gc"],
                  ...(gcTrace
                    ? { gcTrace, promotedBytesPerOperation: gcTrace.promotedBytes / operationCount }
                    : {}),
                  millisecondsPerOperation: Object.fromEntries(
                    Object.entries(sample.diagnostics.gateway.gc).map(([kind, metric]) => [
                      kind,
                      metric.total / operationCount,
                    ]),
                  ),
                };
              })(),
            }
          : {}),
        ...(sample.allocation
          ? {
              allocation: {
                ...sample.allocation,
                ...readPromotion(sample.allocation.profilePath, sample.allocation.operationCount),
                ...(values["operator-access-policy"]
                  ? {
                      authority: readAuthorityAllocation(
                        sample.allocation.profilePath,
                        sample.allocation.operationCount,
                      ),
                    }
                  : {}),
              },
            }
          : {}),
        ...(sample.streamStart?.heapProfile
          ? {
              streamStart: {
                ...sample.streamStart,
                heapProfile: {
                  ...sample.streamStart.heapProfile,
                  ...readPromotion(sample.streamStart.heapProfile.profilePath, runCount),
                },
              },
            }
          : {}),
      }),
    ),
  };
  if (values["turn-start-phases"]) {
    writeFileSync(
      path.join(output, "turn-start-phases.json"),
      JSON.stringify(
        { providerDelayMs, coldSessionRounds, phases: turnStartPhases, turns: turnStartSamples },
        null,
        2,
      ),
    );
  }
  writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(`RESULT ${path.join(output, "result.json")}`);
} catch (error) {
  if (values["github-options-observe"]) {
    writeFileSync(
      path.join(output, "github-options-failure.json"),
      JSON.stringify({
        stages: githubStages,
        upstreamRequests: githubFixtureRequests,
        observations: githubOptionsObservations,
      }),
    );
  }
  throw error;
} finally {
  if (values["auth-availability-storm"]) {
    writeFileSync(
      path.join(output, "auth-availability-mock.json"),
      JSON.stringify(
        {
          ...authAvailabilityMock,
          startedAt: authAvailabilityStartedAt,
          minutes: [...authAvailabilityMinutes].map(([minute, counts]) => ({
            minute,
            requests: counts.requests,
            rateLimits: counts.rateLimits,
            successes: counts.successes,
          })),
        },
        null,
        2,
      ),
    );
  }
  await cleanup();
}
