import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createCipheriv } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROTOCOL_VERSION } from "../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../packages/normalization-core/src/record-coerce.ts";
import type { SubagentRunRecord } from "../src/agents/subagents/registry/subagent-registry.types.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { validateConfigObjectRaw } from "../src/config/validation-core.js";
import { writeBenchmarkJson } from "./lib/benchmark-harness.mts";
import { listBundledPluginPackArtifacts } from "./lib/bundled-plugin-build-entries.mjs";
import { delay, stopChild } from "./lib/gateway-bench-child.ts";
import {
  getFreePort,
  readProcessTreeCpuMs,
  startGatewayRssSampling,
} from "./lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  buildGatewayBenchCommand,
  classifyGatewayReadyLog,
  CliArgumentError,
  collectOutputLines,
  collectTraceLine,
  createGatewayBenchEnv,
  flushOutputLineBuffers,
  formatMb,
  formatMs,
  formatStats,
  hasHelpFlag,
  parseGatewayBenchRuntimeOptions,
  parseNonNegativeInt,
  parsePositiveInt,
  resolveCases as resolveGatewayBenchCases,
  resolveEntry as resolveGatewayBenchEntry,
  resolveOutputPath,
  STALLED_CATALOG_MODEL_ID,
  STALLED_CATALOG_PROVIDER_ID,
  summarizeNumbers,
  summarizeTraceStats,
  type InitialProbeResult,
  type GatewayBenchRuntimeOptions,
  parseCliArgs,
  writeGatewayBenchConfig,
  writePluginFixtures,
  waitForInitialProbe as waitForProbe,
} from "./lib/gateway-bench-runtime.ts";
import { selectSlowStartupTraceDurations } from "./lib/gateway-startup-trace-ranking.js";
import { createGatewayWsClient } from "./lib/gateway-ws-client.ts";

type GatewayBenchCase = {
  agentTopology?: "incident-scale" | "single" | "shared-eleven-plus-distinct-one";
  bundledPluginFixture?: OpenClawConfig;
  completionTracePhase?: string;
  config: Record<string, unknown>;
  env?: Record<string, string>;
  id: string;
  incidentFixture?: "combined" | "database" | "null-metadata" | "packaged-plugins" | "workspace";
  name: string;
  pluginActivationOnStartup?: boolean;
  pluginCount?: number;
  providerCatalogStallMs?: number;
  providerStaticCatalogModelCount?: number;
  providerStaticCatalogStallMs?: number;
  runByDefault?: boolean;
};

type GatewaySample = {
  agentRecoveryMs?: Record<string, number>;
  registryRecovery?: {
    events: Record<string, number>;
    retainedRuns: number;
    recoveredRuns: number;
    preservedTerminalRuns: number;
  };
  integrityGateMs?: Record<string, number>;
  agentDatabaseAdmissionErrors?: number;
  completionMs: number | null;
  cpuCoreRatio: number | null;
  cpuMs: number | null;
  exitedBeforeTeardown?: boolean;
  exitCode: number | null;
  firstOutputMs: number | null;
  firstSessionRpc: { ms: number | null; attempts: number; lastError: string | null };
  gatewayReadyLogLine: string | null;
  gatewayReadyLogMs: number | null;
  healthz: InitialProbeResult;
  httpListenLogLine: string | null;
  httpListenLogMs: number | null;
  maxRssMb: number | null;
  outputTail: string;
  readyz: InitialProbeResult;
  shutdownForced: boolean;
  shutdownMs: number;
  signal: string | null;
  startupTrace: Record<string, number>;
  startupTraceLines: string[];
};

type CaseResult = ReturnType<typeof summarizeCase>;

type BenchmarkFailure = {
  id: string;
  reason: string;
  sampleIndex: number;
};

type CliOptions = GatewayBenchRuntimeOptions & {
  cases: GatewayBenchCase[];
  cpuProfDir?: string;
  entry: string;
  heapProfDir?: string;
  installedCohort?: string;
  installedChild: boolean;
  installedCpuDiagnostic: boolean;
  json: boolean;
  output?: string;
  runs: number;
  timeoutMs: number;
  warmup: number;
  fixtureRoot?: string;
  seedOnly: boolean;
  agentDatabaseMib: number;
  agentGateDelayMs: number;
  startAt?: number;
};

const DEFAULT_RUNS = 5;
const DEFAULT_WARMUP = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ENTRY = "dist/entry.js";
const TEAM_BOOT_AUTH_TOKEN = "synthetic-startup-benchmark-token";
const INCIDENT_COMBINED_HEALTHZ_P95_MAX_MS = 30_000;
const INCIDENT_COMBINED_READYZ_P95_MAX_MS = 60_000;
const BOOLEAN_FLAGS = new Set([
  "--help",
  "-h",
  "--json",
  "--installed-child",
  "--installed-cpu-diagnostic",
  "--seed-only",
]);
const VALUE_FLAGS = new Set([
  "--case",
  "--cpu-prof-dir",
  "--entry",
  "--gateway-runtime",
  "--gateway-cpus",
  "--heap-prof-dir",
  "--installed-cohort",
  "--output",
  "--runs",
  "--timeout-ms",
  "--warmup",
  "--fixture-root",
  "--agent-database-mib",
  "--agent-gate-delay-ms",
  "--start-at",
  "--bundled-plugin-fixture",
]);

const BASE_CONFIG = BASE_GATEWAY_BENCH_CONFIG;
const LARGE_PLUGIN_MODEL_AGENT_COUNT = 256;
const LARGE_PLUGIN_MODEL_COUNT = 58;
const LARGE_PLUGIN_MODEL_PROVIDER_IDS = ["openai", "google", "minimax"] as const;

function buildLargePluginModelAgentEntries() {
  const model = {
    primary: `${LARGE_PLUGIN_MODEL_PROVIDER_IDS[0]}/model-01`,
    fallbacks: Array.from({ length: LARGE_PLUGIN_MODEL_COUNT - 1 }, (_, offset) => {
      const index = offset + 1;
      const provider = LARGE_PLUGIN_MODEL_PROVIDER_IDS[index % 3];
      return `${provider}/model-${String(index + 1).padStart(2, "0")}`;
    }),
  };
  return Object.fromEntries(
    Array.from({ length: LARGE_PLUGIN_MODEL_AGENT_COUNT }, (_, index) => [
      `agent-${String(index + 1).padStart(4, "0")}`,
      { model },
    ]),
  );
}

function preparedRuntimeConfig(): Record<string, unknown> {
  const model = `${STALLED_CATALOG_PROVIDER_ID}/${STALLED_CATALOG_MODEL_ID}`;
  return {
    ...BASE_CONFIG,
    agents: {
      defaults: {
        model: { primary: model },
        modelPolicy: { allow: [model] },
        models: { [model]: { agentRuntime: { id: "openclaw" } } },
      },
    },
  };
}

const GATEWAY_CASES: readonly GatewayBenchCase[] = [
  {
    id: "teamBoot",
    name: "gateway, 44 startup plugins, eight agents and 4096 sessions",
    agentTopology: "incident-scale",
    pluginActivationOnStartup: true,
    pluginCount: 44,
    runByDefault: false,
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    config: {
      ...BASE_CONFIG,
      gateway: { ...BASE_CONFIG.gateway, auth: { mode: "token", token: TEAM_BOOT_AUTH_TOKEN } },
      cron: { enabled: false },
    },
  },
  {
    id: "interruptedRegistry",
    name: "gateway, 86 retained runs and eight interrupted executions after SIGKILL",
    runByDefault: false,
    completionTracePhase: "sidecars.subagent-recovery",
    config: {
      ...BASE_CONFIG,
      plugins: { enabled: false },
      cron: { enabled: false },
    },
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
  },
  {
    id: "slowAgentDatabase",
    name: "gateway, one checking agent and four ready agents",
    runByDefault: false,
    config: {
      ...BASE_CONFIG,
      plugins: { enabled: false },
      cron: { enabled: false },
    },
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
  },
  {
    id: "default",
    name: "gateway default",
    config: BASE_CONFIG,
  },
  {
    id: "skipChannels",
    name: "gateway, skip channels",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    config: BASE_CONFIG,
  },
  {
    id: "preparedRuntimeCatalogStall",
    name: "gateway, prepared runtime with CPU-stalling live catalog",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    providerCatalogStallMs: 2_000,
    config: preparedRuntimeConfig(),
  },
  {
    id: "preparedRuntimeScaleOne",
    name: "gateway, prepared runtime scale with one agent",
    agentTopology: "single",
    completionTracePhase: "sidecars.ready",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    providerStaticCatalogModelCount: 64,
    providerStaticCatalogStallMs: 100,
    config: preparedRuntimeConfig(),
  },
  {
    id: "preparedRuntimeScaleMany",
    name: "gateway, prepared runtime scale with 11 shared-workspace agents and one distinct",
    agentTopology: "shared-eleven-plus-distinct-one",
    completionTracePhase: "sidecars.ready",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    providerStaticCatalogModelCount: 64,
    providerStaticCatalogStallMs: 100,
    config: preparedRuntimeConfig(),
  },
  {
    id: "oneInternalHook",
    name: "gateway, one configured internal hook",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    config: {
      ...BASE_CONFIG,
      hooks: {
        internal: {
          entries: {
            "session-memory": { enabled: true },
          },
        },
      },
    },
  },
  {
    id: "allInternalHooks",
    name: "gateway, all internal hooks",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    config: {
      ...BASE_CONFIG,
      hooks: {
        internal: {
          enabled: true,
        },
      },
    },
  },
  {
    id: "fiftyPlugins",
    name: "gateway, 50 manifest plugins",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    pluginActivationOnStartup: true,
    pluginCount: 50,
    config: BASE_CONFIG,
  },
  {
    id: "fiftyStartupLazyPlugins",
    name: "gateway, 50 startup-lazy manifest plugins",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    pluginActivationOnStartup: false,
    pluginCount: 50,
    config: BASE_CONFIG,
  },
  {
    id: "largePluginModelConfig",
    name: `gateway, ${LARGE_PLUGIN_MODEL_AGENT_COUNT} agents with ${LARGE_PLUGIN_MODEL_COUNT} plugin-owned model refs each`,
    completionTracePhase: "config.snapshot.auto-enable",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    runByDefault: false,
    config: {
      ...BASE_CONFIG,
      agents: {
        ownership: "explicit",
        entries: buildLargePluginModelAgentEntries(),
      },
      plugins: {
        enabled: true,
        allow: [...LARGE_PLUGIN_MODEL_PROVIDER_IDS],
      },
    },
  },
  {
    id: "incidentDatabase",
    name: "gateway, incident-scale database",
    incidentFixture: "database",
    runByDefault: false,
    config: BASE_CONFIG,
  },
  {
    id: "incidentNullMetadata",
    name: "gateway, incident-scale NULL metadata repair",
    incidentFixture: "null-metadata",
    runByDefault: false,
    config: BASE_CONFIG,
  },
  {
    id: "incidentWorkspace",
    name: "gateway, incident-scale workspace",
    agentTopology: "incident-scale",
    incidentFixture: "workspace",
    runByDefault: false,
    config: BASE_CONFIG,
  },
  {
    id: "incidentPackagedPlugins",
    name: "gateway, packaged plugin inventory",
    env: { OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1" },
    incidentFixture: "packaged-plugins",
    runByDefault: false,
    config: BASE_CONFIG,
  },
  {
    id: "incidentCombined",
    name: "gateway, incident-scale combined load",
    agentTopology: "incident-scale",
    env: { OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1" },
    incidentFixture: "combined",
    runByDefault: false,
    config: BASE_CONFIG,
  },
] as const;

function resolveCases(caseIds: string[]): GatewayBenchCase[] {
  const defaultCases = GATEWAY_CASES.filter((benchCase) => benchCase.runByDefault !== false);
  return resolveGatewayBenchCases(caseIds, caseIds.length === 0 ? defaultCases : GATEWAY_CASES, {
    allByDefault: true,
    validateDuplicatesFirst: true,
  });
}

function parseOptions(argv: string[] = process.argv.slice(2)): CliOptions {
  const flags = parseCliArgs(argv, {
    booleanFlags: BOOLEAN_FLAGS,
    repeatableValueFlags: new Set(["--case"]),
    valueFlags: VALUE_FLAGS,
  });
  const installedCohort = flags.get("--installed-cohort")?.[0];
  const installedChild = flags.has("--installed-child");
  const installedCpuDiagnostic = flags.has("--installed-cpu-diagnostic");
  if (installedChild && !installedCohort) {
    throw new CliArgumentError("--installed-child requires --installed-cohort");
  }
  if (installedCpuDiagnostic && !installedCohort) {
    throw new CliArgumentError("--installed-cpu-diagnostic requires --installed-cohort");
  }
  if (installedCohort) {
    for (const flag of [
      "--case",
      "--entry",
      "--gateway-runtime",
      "--gateway-cpus",
      "--runs",
      "--warmup",
      "--cpu-prof-dir",
      "--heap-prof-dir",
      "--timeout-ms",
    ]) {
      if (argv.includes(flag)) {
        throw new CliArgumentError(`${flag} is not supported with --installed-cohort`);
      }
    }
    if (!flags.get("--output")?.[0]) {
      throw new CliArgumentError("--installed-cohort requires --output");
    }
  }
  let cases = installedCohort ? [] : resolveCases(flags.get("--case") ?? []);
  const bundledPluginFixturePath = flags.get("--bundled-plugin-fixture")?.[0];
  if (bundledPluginFixturePath !== undefined) {
    if (cases.length !== 1 || cases[0]?.id !== "teamBoot") {
      throw new CliArgumentError("--bundled-plugin-fixture requires --case teamBoot only");
    }
    const value: unknown = JSON.parse(readFileSync(bundledPluginFixturePath, "utf8"));
    if (
      !isRecord(value) ||
      Object.keys(value).some((key) => !["plugins", "models", "tools", "channels"].includes(key))
    ) {
      throw new CliArgumentError(
        "--bundled-plugin-fixture may configure only plugins, models, tools, and channels",
      );
    }
    const validated = validateConfigObjectRaw(value);
    if (!validated.ok) {
      throw new CliArgumentError(
        `--bundled-plugin-fixture has invalid config: ${validated.issues.map((issue) => issue.path).join(", ")}`,
      );
    }
    const bundledPluginIds = validated.config.plugins?.allow ?? [];
    if (
      bundledPluginIds.length === 0 ||
      bundledPluginIds.length > cases[0].pluginCount! ||
      bundledPluginIds.some((id) => !id.trim()) ||
      new Set(bundledPluginIds).size !== bundledPluginIds.length ||
      validated.config.plugins?.load !== undefined
    ) {
      throw new CliArgumentError(
        "--bundled-plugin-fixture requires 1–44 unique plugins.allow IDs and no plugins.load paths",
      );
    }
    const { plugins, models, tools, channels } = validated.config;
    cases = [{ ...cases[0], bundledPluginFixture: { plugins, models, tools, channels } }];
  }
  return {
    ...parseGatewayBenchRuntimeOptions(flags),
    cases,
    cpuProfDir: flags.get("--cpu-prof-dir")?.[0],
    entry: resolveGatewayBenchEntry(flags.get("--entry")?.[0], DEFAULT_ENTRY),
    heapProfDir: flags.get("--heap-prof-dir")?.[0],
    installedCohort,
    installedChild,
    installedCpuDiagnostic,
    json: flags.has("--json"),
    output: resolveOutputPath(flags.get("--output")?.[0]),
    runs: parsePositiveInt(flags.get("--runs")?.[0], DEFAULT_RUNS, "--runs"),
    timeoutMs: parsePositiveInt(flags.get("--timeout-ms")?.[0], DEFAULT_TIMEOUT_MS, "--timeout-ms"),
    warmup: parseNonNegativeInt(flags.get("--warmup")?.[0], DEFAULT_WARMUP, "--warmup"),
    fixtureRoot: flags.get("--fixture-root")?.[0],
    seedOnly: flags.has("--seed-only"),
    agentDatabaseMib: parseNonNegativeInt(
      flags.get("--agent-database-mib")?.[0],
      512,
      "--agent-database-mib",
    ),
    agentGateDelayMs: parseNonNegativeInt(
      flags.get("--agent-gate-delay-ms")?.[0],
      10_000,
      "--agent-gate-delay-ms",
    ),
    startAt: flags.has("--start-at")
      ? parsePositiveInt(flags.get("--start-at")?.[0], 0, "--start-at")
      : undefined,
  };
}

function printUsage(): void {
  console.log(`OpenClaw Gateway startup benchmark

Usage:
  pnpm test:startup:gateway -- [options]
  node --import tsx scripts/bench-gateway-startup.ts [options]

Options:
  --case <id>          Specific case id to run; repeatable
  --entry <path>       Gateway CLI entry file (default: ${DEFAULT_ENTRY})
  --gateway-runtime <path> Gateway executable (default: the benchmark runtime)
  --gateway-cpus <list> Linux Gateway-only CPU affinity (comma-separated CPU numbers)
  --runs <n>           Measured runs per case (default: ${DEFAULT_RUNS})
  --warmup <n>         Warmup runs per case (default: ${DEFAULT_WARMUP})
  --timeout-ms <ms>    Per-run timeout (default: ${DEFAULT_TIMEOUT_MS})
  --cpu-prof-dir <dir> Write one V8 CPU profile per run
  --heap-prof-dir <dir> Write one V8 heap profile per run
  --installed-cohort <path> Measure one fresh installed startup and eight retained-state restarts
  --installed-cpu-diagnostic Profile one established startup after an unprofiled fresh prime; requires --installed-cohort
  --output <path>      Write machine-readable JSON to a file
  --json               Emit machine-readable JSON
  --help, -h           Show this text
  --fixture-root <path> Prepared teamBoot, slowAgentDatabase or interruptedRegistry fixture (requires --runs 1 --warmup 0)
  --seed-only         Create a new --fixture-root without launching a Gateway
  --bundled-plugin-fixture <path> Synthetic plugins/models/tools/channels config for teamBoot
  --agent-database-mib <n> Synthetic slow-agent cache payload (default: 512)
  --agent-gate-delay-ms <n> Benchmark-only delay before the real integrity scan (default: 10000)
  --start-at <epoch-ms> Synchronize prepared fixture startup with a concurrent comparison

Case ids:
  ${GATEWAY_CASES.map((benchCase) => `${benchCase.id} (${benchCase.name})`).join("\n  ")}
`);
}

function summarizeCase(benchCase: GatewayBenchCase, samples: GatewaySample[]) {
  const startupTrace = summarizeTraceStats(samples, (sample) => sample.startupTrace);
  const summarize = (read: (sample: GatewaySample) => number | null) =>
    summarizeNumbers(
      samples.map(read).filter((value): value is number => typeof value === "number"),
    );
  return {
    id: benchCase.id,
    name: benchCase.name,
    ...(benchCase.id === "teamBoot"
      ? {
          expectedPluginCount: benchCase.pluginCount ?? 44,
          bundledPluginIds: benchCase.bundledPluginFixture?.plugins?.allow ?? [],
        }
      : {}),
    samples,
    summary: {
      completionMs: summarize((sample) => sample.completionMs),
      firstOutputMs: summarize((sample) => sample.firstOutputMs),
      firstSessionRpcMs: summarize((sample) => sample.firstSessionRpc.ms),
      cpuCoreRatio: summarize((sample) => sample.cpuCoreRatio),
      cpuMs: summarize((sample) => sample.cpuMs),
      gatewayReadyLogMs: summarize((sample) => sample.gatewayReadyLogMs),
      healthzMs: summarize((sample) => sample.healthz.ms),
      httpListenLogMs: summarize((sample) => sample.httpListenLogMs),
      maxRssMb: summarize((sample) => sample.maxRssMb),
      readyzMs: summarize((sample) => sample.readyz.ms),
      shutdownMs: summarize((sample) => sample.shutdownMs),
      startupTrace,
    },
  };
}

function collectResultFailures(results: CaseResult[]): BenchmarkFailure[] {
  const failures: BenchmarkFailure[] = [];
  for (const result of results) {
    result.samples.forEach((sample, index) => {
      const missing: string[] = [];
      if (sample.healthz.status !== 200 || sample.healthz.ms == null) {
        missing.push("/healthz");
      }
      if (sample.readyz.status !== 200 || sample.readyz.ms == null) {
        missing.push("/readyz");
      }
      if (sample.firstSessionRpc.ms == null) {
        missing.push("sessions.list");
      }
      if (sample.completionMs == null) {
        missing.push("completion");
      }
      if (sample.cpuMs == null || sample.cpuCoreRatio == null) {
        missing.push("cpu");
      }
      if (sample.maxRssMb == null) {
        missing.push("rss");
      }
      if (result.id === "slowAgentDatabase") {
        if (
          SLOW_DATABASE_AGENT_IDS.some((agentId) => sample.agentRecoveryMs?.[agentId] === undefined)
        ) {
          missing.push("per-agent recovery");
        }
        if (sample.integrityGateMs?.["gate-passed"] === undefined) {
          missing.push("full integrity scan");
        }
      }
      if (result.id === "interruptedRegistry") {
        const recovery = sample.registryRecovery;
        if (
          !recovery ||
          recovery.retainedRuns !== INTERRUPTED_REGISTRY_RUNS ||
          recovery.recoveredRuns !== INTERRUPTED_REGISTRY_ACTIVE ||
          recovery.preservedTerminalRuns !==
            INTERRUPTED_REGISTRY_RUNS - INTERRUPTED_REGISTRY_ACTIVE ||
          Object.keys(recovery.events).length !== INTERRUPTED_REGISTRY_ACTIVE ||
          Object.values(recovery.events).some((count) => count !== 1)
        ) {
          missing.push("exactly one recovery per active run and preserved terminal outcomes");
        }
      }
      if (missing.length > 0) {
        failures.push({
          id: result.id,
          reason: `missing ${missing.join(", ")}`,
          sampleIndex: index + 1,
        });
        return;
      }
      if (result.expectedPluginCount !== undefined) {
        const inventory = /http server listening \((\d+) plugins?: ([^;)]+)/u.exec(
          sample.httpListenLogLine ?? "",
        );
        const loadedIds = new Set(inventory?.[2]?.split(", ") ?? []);
        const missingBundled = result.bundledPluginIds?.filter((id) => !loadedIds.has(id)) ?? [];
        if (
          Number(inventory?.[1]) !== result.expectedPluginCount ||
          loadedIds.size !== result.expectedPluginCount ||
          missingBundled.length > 0
        ) {
          failures.push({
            id: result.id,
            reason: `plugin inventory mismatch: expected ${result.expectedPluginCount}, observed ${inventory?.[1] ?? "unreported"}; missing bundled: ${missingBundled.join(", ") || "none"}`,
            sampleIndex: index + 1,
          });
        }
      }
      if (result.id === "slowAgentDatabase") {
        const gatePassed = sample.integrityGateMs!["gate-passed"]!;
        for (const agentId of SLOW_DATABASE_AGENT_IDS) {
          const recovered = sample.agentRecoveryMs![agentId]!;
          const slow = agentId === "bench-slow";
          if (slow ? recovered <= gatePassed : recovered >= gatePassed) {
            failures.push({
              id: result.id,
              reason: `${agentId} recovered at ${recovered.toFixed(1)}ms; must recover ${slow ? "after" : "before"} integrity gate passed at ${gatePassed.toFixed(1)}ms`,
              sampleIndex: index + 1,
            });
          }
        }
        if (sample.agentDatabaseAdmissionErrors !== 0) {
          failures.push({
            id: result.id,
            reason: `database admission errors: ${sample.agentDatabaseAdmissionErrors ?? "missing count"}`,
            sampleIndex: index + 1,
          });
        }
      }
      if (sample.exitedBeforeTeardown === true) {
        failures.push({
          id: result.id,
          reason:
            sample.signal == null
              ? `child exited ${sample.exitCode ?? "before teardown"}`
              : `child exited by ${sample.signal}`,
          sampleIndex: index + 1,
        });
      } else if (
        result.id === "teamBoot" &&
        (sample.shutdownForced || sample.exitCode !== 0 || sample.signal !== null)
      ) {
        failures.push({
          id: result.id,
          reason: `unclean shutdown (exitCode=${sample.exitCode}, signal=${sample.signal}, forced=${sample.shutdownForced})`,
          sampleIndex: index + 1,
        });
      }
    });
    if (result.id !== "incidentCombined") {
      continue;
    }
    for (const [probe, stats, limit] of [
      ["/healthz", result.summary.healthzMs, INCIDENT_COMBINED_HEALTHZ_P95_MAX_MS],
      ["/readyz", result.summary.readyzMs, INCIDENT_COMBINED_READYZ_P95_MAX_MS],
    ] as const) {
      const p95 = stats?.p95;
      if (p95 == null || p95 >= limit) {
        failures.push({
          id: result.id,
          reason: `${probe} p95 ${p95 == null ? "missing" : formatMs(p95)} must be under ${formatMs(limit)}`,
          sampleIndex: 0,
        });
      }
    }
  }
  return failures;
}

function printBenchmarkFailures(failures: BenchmarkFailure[]): void {
  if (failures.length === 0) {
    return;
  }
  console.error(
    `[gateway-startup-bench] failed: ${failures.length} sample(s) did not satisfy startup or lifecycle checks`,
  );
  for (const failure of failures.slice(0, 8)) {
    console.error(
      `[gateway-startup-bench] ${failure.id} ${failure.sampleIndex ? `run ${failure.sampleIndex}` : "summary"}: ${failure.reason}`,
    );
  }
  if (failures.length > 8) {
    console.error(`[gateway-startup-bench] ${failures.length - 8} more sample failure(s) omitted`);
  }
}

function formatRatio(value: number | null): string {
  if (value == null) {
    return "n/a";
  }
  return value.toFixed(3);
}

async function waitForStartupTracePhase(params: {
  deadlineAt: number;
  isDone: () => boolean;
  phase: string;
  startupTrace: Record<string, number>;
}): Promise<number | null> {
  const totalKey = `${params.phase}.total`;
  while (performance.now() < params.deadlineAt) {
    if (Object.hasOwn(params.startupTrace, totalKey)) {
      return params.startupTrace[totalKey] ?? null;
    }
    if (params.isDone()) {
      return null;
    }
    await delay(25);
  }
  return null;
}

function buildBenchAgentList(
  root: string,
  topology: GatewayBenchCase["agentTopology"],
): Array<{ id: string; workspace: string }> | undefined {
  if (!topology) {
    return undefined;
  }
  const sharedWorkspace = path.join(root, "shared-workspace");
  const distinctWorkspace = path.join(root, "distinct-workspace");
  mkdirSync(sharedWorkspace, { recursive: true });
  if (topology === "single") {
    return [{ id: "main", workspace: sharedWorkspace }];
  }
  if (topology === "incident-scale") {
    return Array.from({ length: 8 }, (_, index) => ({
      id: `incident-agent-${String(index + 1).padStart(2, "0")}`,
      workspace: path.join(root, "workspaces", `agent-${String(index + 1).padStart(2, "0")}`),
    }));
  }
  mkdirSync(distinctWorkspace, { recursive: true });
  return Array.from({ length: 12 }, (_, index) => ({
    id: `agent-${String(index + 1).padStart(2, "0")}`,
    workspace: index === 11 ? distinctWorkspace : sharedWorkspace,
  }));
}

const INCIDENT_AUDIT_ROW_COUNT = 200_000;
const INCIDENT_WORKSPACE_FILE_BYTES = 10 * 1024;
const INCIDENT_WORKSPACE_FILE_COUNT = 80_000;
const INCIDENT_WORKSPACE_COUNT = 8;
const INCIDENT_WORKSPACE_FILES_PER_DIRECTORY = 1_000;

type IncidentFixtureOptions = {
  auditRowCount?: number;
  kind: NonNullable<GatewayBenchCase["incidentFixture"]>;
  workspaceFileBytes?: number;
  workspaceFileCount?: number;
};

function fixtureIncludesDatabase(kind: IncidentFixtureOptions["kind"]): boolean {
  return kind === "combined" || kind === "database" || kind === "null-metadata";
}

function fixtureIncludesWorkspace(kind: IncidentFixtureOptions["kind"]): boolean {
  return kind === "combined" || kind === "workspace";
}

function fixtureIncludesNullMetadata(kind: IncidentFixtureOptions["kind"]): boolean {
  return kind === "combined" || kind === "null-metadata";
}

function fixtureIncludesPackagedPlugins(kind: IncidentFixtureOptions["kind"]): boolean {
  return kind === "combined" || kind === "packaged-plugins";
}

function listIncidentPackagedPluginArtifacts(env = process.env): string[] {
  return listBundledPluginPackArtifacts({
    env: { ...env, OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: undefined },
  });
}

function assertIncidentPackagedPluginInventory(): void {
  const missing = listIncidentPackagedPluginArtifacts().filter(
    (artifact) => !existsSync(path.resolve(process.cwd(), artifact)),
  );
  if (missing.length > 0) {
    throw new Error(
      `Incident packaged-plugin benchmark requires a built plugin inventory; ${missing.length} required artifact(s) are missing. Run pnpm build first.`,
    );
  }
}

function createIncidentWorkspaces(root: string, options: IncidentFixtureOptions): void {
  if (!fixtureIncludesWorkspace(options.kind)) {
    return;
  }
  const fileCount = options.workspaceFileCount ?? INCIDENT_WORKSPACE_FILE_COUNT;
  const fileBytes = options.workspaceFileBytes ?? INCIDENT_WORKSPACE_FILE_BYTES;
  const contents = Buffer.alloc(fileBytes, "x");
  for (let index = 0; index < fileCount; index += 1) {
    const workspaceIndex = index % INCIDENT_WORKSPACE_COUNT;
    const directoryIndex = Math.floor(index / INCIDENT_WORKSPACE_FILES_PER_DIRECTORY);
    const directory = path.join(
      root,
      "workspaces",
      `agent-${String(workspaceIndex + 1).padStart(2, "0")}`,
      "incident-artifacts",
      `batch-${String(directoryIndex).padStart(3, "0")}`,
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, `artifact-${String(index).padStart(6, "0")}.bin`), contents);
  }
}

function seedIncidentAuditRows(database: import("node:sqlite").DatabaseSync, count: number): void {
  const payload = `fixture:${"x".repeat(1024)}`;
  const insert = database.prepare(
    `INSERT INTO audit_events (
       event_id, source_id, source_sequence, occurred_at, kind, action, status, actor_type,
       actor_id, agent_id, session_key, run_id, channel, target_ref
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  database.exec("BEGIN IMMEDIATE;");
  try {
    for (let index = 0; index < count; index += 1) {
      const id = `incident-audit-${String(index).padStart(8, "0")}`;
      insert.run(
        id,
        `source-${id}`,
        index + 1,
        1_750_000_000_000 + index,
        "gateway.admission",
        "accepted",
        "ok",
        "system",
        "incident-fixture",
        "incident-agent-01",
        "agent:incident-agent-01:main",
        `run-${id}`,
        "fixture",
        payload,
      );
    }
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
  // Retain half the rows after a large write so the fixture keeps the incident's
  // high freelist pressure without storing any customer content.
  database.prepare("DELETE FROM audit_events WHERE source_sequence % 2 = 0").run();
}

async function writeIncidentFixture(root: string, options: IncidentFixtureOptions): Promise<void> {
  createIncidentWorkspaces(root, options);
  if (!fixtureIncludesDatabase(options.kind)) {
    return;
  }
  const env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
  const [{ DatabaseSync }, agentDatabase, stateDatabase] = await Promise.all([
    import("node:sqlite"),
    import("../src/state/openclaw-agent-db.js"),
    import("../src/state/openclaw-state-db.js"),
  ]);
  const state = stateDatabase.openOpenClawStateDatabase({ env });
  const agents = Array.from({ length: INCIDENT_WORKSPACE_COUNT }, (_, index) =>
    agentDatabase.openOpenClawAgentDatabase({
      agentId: `incident-agent-${String(index + 1).padStart(2, "0")}`,
      env,
    }),
  );
  const statePath = state.path;
  const agentPaths = agents.map((agent) => agent.path);
  try {
    state.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    agents.forEach((agent) => agent.db.exec("PRAGMA wal_checkpoint(TRUNCATE);"));
  } finally {
    agentDatabase.closeOpenClawAgentDatabasesForTest();
    stateDatabase.closeOpenClawStateDatabaseForTest();
  }
  const stateHandle = new DatabaseSync(statePath);
  try {
    seedIncidentAuditRows(stateHandle, options.auditRowCount ?? INCIDENT_AUDIT_ROW_COUNT);
    if (fixtureIncludesNullMetadata(options.kind)) {
      stateHandle
        .prepare("UPDATE schema_meta SET app_version = NULL WHERE meta_key = 'primary'")
        .run();
    }
    stateHandle.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    stateHandle.close();
  }
  if (!fixtureIncludesNullMetadata(options.kind)) {
    return;
  }
  for (const agentPath of agentPaths) {
    const agent = new DatabaseSync(agentPath);
    try {
      agent.prepare("UPDATE schema_meta SET app_version = NULL WHERE meta_key = 'primary'").run();
      agent.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } finally {
      agent.close();
    }
  }
}

async function withGatewayBenchRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-gateway-bench-"));
  try {
    return await run(root);
  } finally {
    rmSync(root, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
  }
}

function writeConfig(root: string, benchCase: GatewayBenchCase): string {
  const fixture = benchCase.bundledPluginFixture;
  const bundledPluginIds = fixture?.plugins?.allow ?? [];
  const hasCatalogFixture =
    benchCase.providerCatalogStallMs !== undefined ||
    benchCase.providerStaticCatalogStallMs !== undefined;
  const pluginCount = hasCatalogFixture
    ? 1
    : (benchCase.pluginCount ?? 0) - bundledPluginIds.length;
  const pluginFixtures = pluginCount
    ? writePluginFixtures(root, {
        activationOnStartup: hasCatalogFixture ? true : benchCase.pluginActivationOnStartup,
        count: pluginCount,
        providerCatalogStallMs: benchCase.providerCatalogStallMs,
        providerStaticCatalogModelCount: benchCase.providerStaticCatalogModelCount,
        providerStaticCatalogStallMs: benchCase.providerStaticCatalogStallMs,
      })
    : null;
  const agentList =
    benchCase.id === "slowAgentDatabase"
      ? SLOW_DATABASE_AGENT_IDS.map((id) => ({ id, workspace: path.join(root, "workspace", id) }))
      : benchCase.id === "interruptedRegistry"
        ? INTERRUPTED_REGISTRY_AGENT_IDS.map((id) => ({
            id,
            workspace: path.join(root, "workspace", id),
          }))
        : buildBenchAgentList(root, benchCase.agentTopology);
  const plugins = benchCase.config.plugins as OpenClawConfig["plugins"];
  const config = fixture
    ? {
        ...benchCase.config,
        ...fixture,
        plugins: {
          ...plugins,
          ...fixture.plugins,
          entries: {
            ...plugins?.entries,
            ...fixture.plugins?.entries,
            ...Object.fromEntries(
              bundledPluginIds.map((id) => [
                id,
                { ...fixture.plugins?.entries?.[id], enabled: true },
              ]),
            ),
          },
        },
      }
    : benchCase.config;
  return writeGatewayBenchConfig(root, config, { agentList, pluginFixtures });
}

const SLOW_DATABASE_AGENT_IDS = [
  "bench-fast-01",
  "bench-fast-02",
  "bench-fast-03",
  "bench-fast-04",
  "bench-slow",
] as const;

const INTERRUPTED_REGISTRY_RUNS = 86;
const INTERRUPTED_REGISTRY_ACTIVE = 8;
const INTERRUPTED_REGISTRY_AGENT_IDS = Array.from(
  { length: INTERRUPTED_REGISTRY_ACTIVE },
  (_, index) => `bench-registry-${index}`,
);

async function seedInterruptedRegistryFixture(root: string): Promise<void> {
  if (process.env.OPENCLAW_BENCHMARK_FIXTURE_WRITER !== "1") {
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        fileURLToPath(import.meta.url),
        "--case",
        "interruptedRegistry",
        "--fixture-root",
        root,
        "--seed-only",
      ],
      {
        env: { ...process.env, OPENCLAW_BENCHMARK_FIXTURE_WRITER: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "";
    let committed = false;
    child.stdout.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16_384);
      if (!committed && output.includes("interrupted-registry-fixture-ready")) {
        committed = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16_384);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    try {
      const [, signal] = await once(child, "exit");
      if (!committed || signal !== "SIGKILL") {
        throw new Error(
          `Interrupted registry fixture writer did not finish before SIGKILL: ${output}`,
        );
      }
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    return;
  }
  mkdirSync(root);
  const benchCase = GATEWAY_CASES.find((entry) => entry.id === "interruptedRegistry")!;
  const configPath = writeConfig(root, benchCase);
  const env = createGatewayBenchEnv(root, configPath, { caseEnv: benchCase.env });
  process.env = { ...env };
  const [agentDb, stateDb, { writeSessionEntry }, { bindSubagentRunRecord }, registry] =
    await Promise.all([
      import("../src/state/openclaw-agent-db.js"),
      import("../src/state/openclaw-state-db.js"),
      import("../src/config/sessions/session-accessor.sqlite-entry-store.js"),
      import("../src/agents/subagents/registry/subagent-registry.store.codec.js"),
      import("../src/agents/subagents/registry/subagent-registry.store.kernel.js"),
    ]);
  const now = Date.now() - 60_000;
  const databasePaths = new Set<string>();
  const terminalExecutions: Record<string, string> = {};
  const requesterAgentId = INTERRUPTED_REGISTRY_AGENT_IDS[0]!;
  const requesterStorePath = agentDb.openOpenClawAgentDatabase({
    agentId: requesterAgentId,
    env,
  }).path;
  for (let index = 0; index < INTERRUPTED_REGISTRY_ACTIVE; index++) {
    agentDb.runOpenClawAgentWriteTransaction(
      (database) => {
        writeSessionEntry(database, `agent:${requesterAgentId}:requester:${index}`, {
          sessionId: `requester-${index}`,
          lifecycleRevision: `requester-${index}`,
          lifecycleRunId: `requester-turn-${index}`,
          updatedAt: now,
        });
      },
      { agentId: requesterAgentId, env },
    );
  }
  const values = Array.from({ length: INTERRUPTED_REGISTRY_RUNS }, (_, index) => {
    const agentId = INTERRUPTED_REGISTRY_AGENT_IDS[index % INTERRUPTED_REGISTRY_ACTIVE]!;
    const runId = `interrupted-registry-${index}`;
    const childSessionKey = `agent:${agentId}:subagent:${runId}`;
    const active = index < INTERRUPTED_REGISTRY_ACTIVE;
    const requester = active ? index % 2 : index % INTERRUPTED_REGISTRY_ACTIVE;
    const requesterSessionKey = `agent:${requesterAgentId}:requester:${requester}`;
    const interrupted = active && index >= INTERRUPTED_REGISTRY_ACTIVE / 2;
    databasePaths.add(agentDb.openOpenClawAgentDatabase({ agentId, env }).path);
    agentDb.runOpenClawAgentWriteTransaction(
      (database) => {
        writeSessionEntry(database, childSessionKey, {
          sessionId: runId,
          lifecycleRevision: runId,
          lifecycleRunId: runId,
          startedAt: now,
          updatedAt: now,
          ...(interrupted ? { abortedLastRun: true } : {}),
        });
      },
      { agentId, env },
    );
    const entry: SubagentRunRecord = {
      runId,
      childSessionKey,
      childAgentId: agentId,
      childSessionIdentity: { sessionId: runId, lifecycleRevision: runId },
      requesterSessionKey,
      requesterAgentId,
      requesterStorePath,
      requesterDisplayKey: requesterSessionKey,
      requesterTurnRunId: `requester-turn-${requester}`,
      completionRequesterSessionId: `requester-${requester}`,
      completionRequesterLifecycleRevision: `requester-${requester}`,
      task: "Synthetic interrupted startup recovery",
      cleanup: "keep",
      createdAt: now,
      execution: active
        ? {
            status: interrupted ? "interrupted" : "running",
            startedAt: now,
            lifecycleGeneration: "synthetic-killed-fixture-writer",
            ...(interrupted
              ? ({ interruptedAt: now + 1, interruptionReason: "gateway-restart" } as const)
              : {}),
          }
        : { status: "terminal", startedAt: now, endedAt: now + 1, outcome: { status: "ok" } },
      ...(!active ? { cleanupCompletedAt: now + 2 } : {}),
      completion: {
        required: true,
        ...(!active ? { resultText: "Completed synthetic work" } : {}),
      },
      delivery: active
        ? { status: "pending" }
        : { status: "delivered", deliveredAt: now + 2, announcedAt: now + 2 },
      expectsCompletionMessage: true,
    };
    if (!active) {
      terminalExecutions[runId] = JSON.stringify(entry.execution);
    }
    return bindSubagentRunRecord(entry);
  });
  stateDb.runOpenClawStateWriteTransaction(
    (database) => {
      registry.writeSubagentRunValuesInDatabase(database, values, []);
    },
    { env },
  );
  const statePath = stateDb.openOpenClawStateDatabase({ env }).path;
  databasePaths.add(statePath);
  writeFileSync(
    path.join(root, "interrupted-registry-fixture.json"),
    JSON.stringify(
      {
        retainedRuns: INTERRUPTED_REGISTRY_RUNS,
        activeRuns: INTERRUPTED_REGISTRY_ACTIVE,
        runningRuns: 4,
        interruptedRuns: 4,
        predecessor:
          "SIGKILL of fixture writer after committed writes; no predecessor Gateway or model turns",
        statePath,
        terminalExecutions,
        requesterCohorts: INTERRUPTED_REGISTRY_ACTIVE,
        activeRequesterCohorts: 2,
        operatorSource:
          "Absent synthetic source; exercises missing-source settlement, not successful authority restoration",
        databaseBytes: [...databasePaths].reduce(
          (bytes, databasePath) =>
            bytes +
            statSync(databasePath).size +
            (existsSync(`${databasePath}-wal`) ? statSync(`${databasePath}-wal`).size : 0),
          0,
        ),
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(root, "interrupted-registry-preload.mjs"),
    `
import { isMainThread } from 'node:worker_threads';
if (isMainThread) {
  const listeners = globalThis[Symbol.for('openclaw.sessionLifecycleEventListeners')] ??= new Set();
  listeners.add((event) => {
    if (event.reason === 'subagent-status' && /:subagent:interrupted-registry-/.test(event.sessionKey)) {
      console.log('[interrupted-registry-bench] recovered ' + event.sessionKey.split(':').at(-1));
    }
  });
}
`,
  );
  // The parent kills this writer with open SQLite handles, preserving real WAL/crash residue.
  setInterval(() => {}, 1000);
  console.log("interrupted-registry-fixture-ready");
  await new Promise<never>(() => {});
}

async function inspectInterruptedRegistryRecovery(root: string, events: Record<string, number>) {
  const fixture = JSON.parse(
    readFileSync(path.join(root, "interrupted-registry-fixture.json"), "utf8"),
  ) as {
    statePath: string;
    terminalExecutions: Record<string, string>;
  };
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(fixture.statePath, { readOnly: true });
  try {
    const rows = database.prepare("SELECT run_id, payload_json FROM subagent_runs").all();
    return {
      events,
      retainedRuns: rows.length,
      recoveredRuns: rows.filter((row) => {
        const record = JSON.parse(String(row.payload_json)) as SubagentRunRecord;
        return (
          !(String(row.run_id) in fixture.terminalExecutions) &&
          record.execution.status === "terminal" &&
          record.execution.outcome?.status === "error"
        );
      }).length,
      preservedTerminalRuns: rows.filter(
        (row) =>
          fixture.terminalExecutions[String(row.run_id)] ===
          JSON.stringify((JSON.parse(String(row.payload_json)) as SubagentRunRecord).execution),
      ).length,
    };
  } finally {
    database.close();
  }
}

async function seedTeamBootFixture(root: string, benchCase: GatewayBenchCase): Promise<void> {
  mkdirSync(root);
  const configPath = writeConfig(root, benchCase);
  const env = createGatewayBenchEnv(root, configPath, { caseEnv: benchCase.env });
  const previousEnv = process.env;
  process.env = { ...env };
  try {
    const [agentDb, stateDb, { writeSessionEntry }, { writeConfigMachineStateAsync }] =
      await Promise.all([
        import("../src/state/openclaw-agent-db.js"),
        import("../src/state/openclaw-state-db.js"),
        import("../src/config/sessions/session-accessor.sqlite-entry-store.js"),
        import("../src/state/config-machine-state-async.js"),
      ]);
    const now = Date.parse("2026-10-19T00:00:00Z");
    const agents = buildBenchAgentList(root, benchCase.agentTopology)!;
    const databasePaths: string[] = [];
    let statePath = "";
    try {
      for (const { id: agentId, workspace } of agents) {
        mkdirSync(workspace, { recursive: true });
        const database = agentDb.openOpenClawAgentDatabase({ agentId, env });
        agentDb.runOpenClawAgentWriteTransaction(
          (writable) => {
            for (let index = 0; index < 512; index++) {
              writeSessionEntry(writable, `agent:${agentId}:bench-${index}`, {
                sessionId: `team-boot-${agentId}-${index}`,
                updatedAt: now - index,
                label: `Synthetic startup session ${index}`,
                visibility: "shared",
              });
            }
          },
          { agentId, env },
        );
        database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        databasePaths.push(database.path);
      }
      const state = stateDb.openOpenClawStateDatabase({ env });
      statePath = state.path;
      // An inert machine-state namespace adds real, incompressible pages without
      // making startup parse 128 MiB of synthetic records or changing the schema.
      const cipher = createCipheriv("aes-256-ctr", Buffer.alloc(32), Buffer.alloc(16));
      for (let index = 0; index < 128; index++) {
        if (index % 8 === 0 && process.platform === "linux") {
          const dirtyKb = Number(
            /^Dirty:\s+(\d+) kB$/mu.exec(readFileSync("/proc/meminfo", "utf8"))?.[1],
          );
          if (!Number.isFinite(dirtyKb) || dirtyKb >= 2 * 1024 * 1024) {
            throw new Error(
              "Fixture generation stopped: Linux Dirty must remain below 2 GiB; retry with a new root after writes settle.",
            );
          }
        }
        const payload = cipher.update(Buffer.alloc(768 * 1024)).toString("base64");
        await writeConfigMachineStateAsync(`startup-benchmark.payload.${index}`, payload, { env });
        if (index % 8 === 7) {
          state.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          await delay(100);
        }
      }
    } finally {
      await agentDb.closeOpenClawAgentDatabasesAsync();
      await stateDb.closeOpenClawStateDatabaseAsync();
    }
    writeBenchmarkJson(
      {
        pluginCount: 44,
        bundledPluginFixture: benchCase.bundledPluginFixture ?? {},
        externalPluginCount: 44 - (benchCase.bundledPluginFixture?.plugins?.allow?.length ?? 0),
        agentCount: agents.length,
        sessionCount: agents.length * 512,
        stateDatabaseBytes: statSync(statePath).size,
        agentDatabaseBytes: databasePaths.map((databasePath) => statSync(databasePath).size),
        workerEnvironments: "default local startup; no provisioned remote workers",
      },
      path.join(root, "team-boot-fixture.json"),
    );
  } finally {
    process.env = previousEnv;
  }
}

async function seedSlowAgentFixture(root: string, mib: number, gateDelayMs: number): Promise<void> {
  mkdirSync(root);
  const benchCase = GATEWAY_CASES.find((entry) => entry.id === "slowAgentDatabase")!;
  const configPath = writeConfig(root, benchCase);
  const env = createGatewayBenchEnv(root, configPath, { caseEnv: benchCase.env });
  const previousEnv = process.env;
  process.env = { ...env };
  try {
    const [agentDb, stateDb, { writeSessionEntry }, { bindSubagentRunRecord }, registry] =
      await Promise.all([
        import("../src/state/openclaw-agent-db.js"),
        import("../src/state/openclaw-state-db.js"),
        import("../src/config/sessions/session-accessor.sqlite-entry-store.js"),
        import("../src/agents/subagents/registry/subagent-registry.store.codec.js"),
        import("../src/agents/subagents/registry/subagent-registry.store.kernel.js"),
      ]);
    const now = Date.now() - 60_000;
    const requesterAgentId = SLOW_DATABASE_AGENT_IDS[0];
    const databases: Array<{ agentId: string; path: string }> = [];
    let slowPath = "";
    try {
      for (const agentId of SLOW_DATABASE_AGENT_IDS) {
        const database = agentDb.openOpenClawAgentDatabase({ agentId, env });
        const runId = `slow-db-bench-${agentId}`;
        const childSessionKey = `agent:${agentId}:subagent:${runId}`;
        const requesterSessionKey = `agent:${requesterAgentId}:requester:${agentId}`;
        agentDb.runOpenClawAgentWriteTransaction(
          (writable) => {
            writeSessionEntry(writable, requesterSessionKey, {
              sessionId: `requester-${agentId}`,
              updatedAt: now,
            });
          },
          { agentId: requesterAgentId, env },
        );
        agentDb.runOpenClawAgentWriteTransaction(
          (writable) => {
            writeSessionEntry(writable, childSessionKey, {
              sessionId: runId,
              lifecycleRevision: runId,
              lifecycleRunId: runId,
              startedAt: now,
              updatedAt: now,
            });
          },
          { agentId, env },
        );
        stateDb.runOpenClawStateWriteTransaction(
          (state) => {
            registry.writeSubagentRunValuesInDatabase(
              state,
              [
                bindSubagentRunRecord({
                  runId,
                  childSessionKey,
                  childAgentId: agentId,
                  childSessionIdentity: { sessionId: runId, lifecycleRevision: runId },
                  requesterSessionKey,
                  requesterAgentId,
                  requesterDisplayKey: requesterSessionKey,
                  task: "Synthetic interrupted startup recovery",
                  cleanup: "keep",
                  createdAt: now,
                  execution: {
                    status: "running",
                    startedAt: now,
                    lifecycleGeneration: "synthetic-previous-gateway",
                  },
                  completion: { required: false },
                  delivery: { status: "not_required" },
                  expectsCompletionMessage: false,
                }),
              ],
              [],
            );
          },
          { env },
        );
        if (agentId === "bench-slow") {
          slowPath = database.path;
          // An unused canonical cache scope adds real pages without loading payloads at boot.
          const payload = createCipheriv("aes-256-ctr", Buffer.alloc(32), Buffer.alloc(16)).update(
            Buffer.alloc(1024 * 1024),
          );
          const insert = database.db.prepare(
            "INSERT INTO cache_entries(scope, key, blob, updated_at) VALUES ('startup-benchmark', ?, ?, ?)",
          );
          for (let index = 0; index < mib; index++) {
            insert.run(String(index), payload, now);
            if (index % 16 === 15) {
              database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
            }
          }
        }
        database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        databases.push({ agentId, path: database.path });
      }
    } finally {
      await agentDb.closeOpenClawAgentDatabasesAsync();
      await stateDb.closeOpenClawStateDatabaseAsync();
    }
    // Exclusive offline fixture custody: the next owner must perform its real full scan.
    rmSync(`${slowPath}.seal`, { force: true });
    writeFileSync(
      path.join(root, "slow-agent-fixture.json"),
      JSON.stringify(
        {
          databases: databases.map(({ agentId, path: databasePath }) => ({
            agentId,
            bytes: statSync(databasePath).size,
          })),
          gateDelayMs,
        },
        null,
        2,
      ),
    );
    writeFileSync(
      path.join(root, "slow-agent-preload.mjs"),
      `
import { DatabaseSync } from 'node:sqlite';
import { isMainThread } from 'node:worker_threads';
const slowPath = ${JSON.stringify(slowPath)};
const original = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) {
  if (this.location() === slowPath && /^PRAGMA integrity_check;?$/i.test(sql.trim())) {
    console.log('[slow-agent-bench] gate-start');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${gateDelayMs});
    const statement = original.call(this, sql);
    const all = statement.all;
    statement.all = function(...args) {
      const rows = all.apply(this, args);
      if (rows.length === 1 && rows[0].integrity_check === 'ok') {
        console.log('[slow-agent-bench] gate-passed');
      }
      return rows;
    };
    return statement;
  }
  return original.call(this, sql);
};
if (isMainThread) {
  const key = Symbol.for('openclaw.sessionLifecycleEventListeners');
  const listeners = globalThis[key] ??= new Set();
  listeners.add((event) => {
    if (event.reason === 'subagent-status' && /:subagent:slow-db-bench-/.test(event.sessionKey)) {
      console.log('[slow-agent-bench] recovered ' + event.sessionKey.split(':')[1]);
    }
  });
}
`,
    );
  } finally {
    process.env = previousEnv;
  }
}

async function waitForFirstSessionRpc(params: {
  port: number;
  startAt: number;
  deadlineAt: number;
  isDone: () => boolean;
  requireSeededSession: boolean;
  authToken?: string;
}): Promise<GatewaySample["firstSessionRpc"]> {
  let attempts = 0;
  let lastError: string | null = null;
  while (performance.now() < params.deadlineAt && !params.isDone()) {
    attempts++;
    const remaining = () => Math.max(1, params.deadlineAt - performance.now());
    const client = createGatewayWsClient({
      url: `ws://127.0.0.1:${params.port}`,
      openTimeoutMs: remaining(),
      handshakeTimeoutMs: remaining(),
    });
    try {
      await client.waitOpen();
      const connected = await client.request(
        "connect",
        {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: "gateway-client",
            displayName: "startup-benchmark",
            version: "1.0.0",
            platform: process.platform,
            mode: "backend",
          },
          role: "operator",
          ...(params.authToken ? { auth: { token: params.authToken } } : {}),
          scopes: ["operator.read"],
          caps: [],
        },
        remaining(),
      );
      if (!connected.ok) {
        throw new Error(`connect: ${JSON.stringify(connected.error)}`);
      }
      const response = await client.request(
        "sessions.list",
        {
          limit: 1,
          ...(params.requireSeededSession
            ? { agentId: "incident-agent-01", label: "Synthetic startup session 0" }
            : {}),
        },
        remaining(),
      );
      if (!response.ok) {
        throw new Error(`sessions.list: ${JSON.stringify(response.error)}`);
      }
      if (
        !response.payload ||
        typeof response.payload !== "object" ||
        !("sessions" in response.payload) ||
        !Array.isArray(response.payload.sessions)
      ) {
        throw new Error("sessions.list returned no sessions array");
      }
      if (
        params.requireSeededSession &&
        !response.payload.sessions.some(
          (session: unknown) =>
            session !== null &&
            typeof session === "object" &&
            "key" in session &&
            session.key === "agent:incident-agent-01:bench-0",
        )
      ) {
        throw new Error("sessions.list has not returned the seeded session");
      }
      return { ms: performance.now() - params.startAt, attempts, lastError };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      if (client.ws.readyState !== client.ws.CLOSED) {
        const closed = new Promise<void>((resolve) => {
          client.ws.once("close", () => resolve());
        });
        const timer = setTimeout(() => client.ws.terminate(), 1_000);
        try {
          client.close();
          await closed;
        } finally {
          clearTimeout(timer);
        }
      }
    }
    await delay(25);
  }
  return { ms: null, attempts, lastError };
}

async function runGatewaySample(
  options: GatewayBenchRuntimeOptions & {
    benchCase: GatewayBenchCase;
    cpuProfDir?: string;
    entry: string;
    heapProfDir?: string;
    sampleIndex: number;
    timeoutMs: number;
    fixtureRoot?: string;
    startAt?: number;
  },
): Promise<GatewaySample> {
  const withRoot = options.fixtureRoot
    ? async <T>(run: (root: string) => Promise<T>) => run(path.resolve(options.fixtureRoot!))
    : withGatewayBenchRoot;
  return await withRoot(async (root) => {
    const slowAgent = options.benchCase.id === "slowAgentDatabase";
    const interruptedRegistry = options.benchCase.id === "interruptedRegistry";
    const preload = slowAgent
      ? path.join(root, "slow-agent-preload.mjs")
      : interruptedRegistry
        ? path.join(root, "interrupted-registry-preload.mjs")
        : undefined;
    let port = 0;
    for (let attempt = 0; port < 40000 && attempt < 32; attempt++) {
      port = await getFreePort();
    }
    if (port < 40000) {
      throw new CliArgumentError(
        "could not allocate a benchmark port >= 40000 after 32 attempts; ensure the host's ephemeral port range includes ports >= 40000",
      );
    }
    const configPath = writeConfig(root, options.benchCase);
    const env = createGatewayBenchEnv(root, configPath, { caseEnv: options.benchCase.env });
    if (preload) {
      env.NODE_OPTIONS = `--import=${preload}`;
    }
    const agentRecoveryMs: Record<string, number> = {};
    const registryRecoveryEvents: Record<string, number> = {};
    const integrityGateMs: Record<string, number> = {};
    let agentDatabaseAdmissionErrors = 0;
    if (options.benchCase.incidentFixture) {
      await writeIncidentFixture(root, { kind: options.benchCase.incidentFixture });
      if (fixtureIncludesPackagedPlugins(options.benchCase.incidentFixture)) {
        assertIncidentPackagedPluginInventory();
      }
    }
    if (options.startAt !== undefined) {
      const remaining = options.startAt - Date.now();
      if (remaining < 0) {
        throw new CliArgumentError("--start-at deadline has already passed");
      }
      await delay(remaining);
    }
    const startAt = performance.now();
    const deadlineAt = startAt + options.timeoutMs;
    const startupTrace: Record<string, number> = {};
    const startupTraceLines: string[] = [];
    const output: string[] = [];
    const outputBuffers: Record<"stderr" | "stdout", string> = { stderr: "", stdout: "" };
    let firstOutputMs: number | null = null;
    let gatewayReadyLogLine: string | null = null;
    let gatewayReadyLogMs: number | null = null;
    let httpListenLogLine: string | null = null;
    let httpListenLogMs: number | null = null;
    let childExited = false;
    let child: ChildProcessWithoutNullStreams | undefined;
    let rssSampler: ReturnType<typeof startGatewayRssSampling> | undefined;

    try {
      const nodeOptions = [
        ...(preload ? ["--import", preload] : []),
        ...(options.cpuProfDir
          ? [
              "--cpu-prof",
              "--cpu-prof-dir",
              options.cpuProfDir,
              "--cpu-prof-name",
              `openclaw-gateway-${options.benchCase.id}-${options.sampleIndex}-${Date.now()}.cpuprofile`,
            ]
          : []),
        ...(options.heapProfDir ? ["--heap-prof", "--heap-prof-dir", options.heapProfDir] : []),
      ];
      const childArgs = buildGatewayBenchChildArgs(
        options.entry,
        port,
        nodeOptions,
        options.benchCase.id === "teamBoot" ? "token" : "none",
      );
      const command = buildGatewayBenchCommand(childArgs, options);
      child = spawn(command.command, command.args, {
        cwd: process.cwd(),
        detached: process.platform !== "win32",
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      try {
        await once(child, "spawn");
      } catch (error) {
        child = undefined;
        throw error;
      }
      const startedChild = child;
      const cpuStartMs = readProcessTreeCpuMs(startedChild.pid);
      rssSampler = startGatewayRssSampling(startedChild);
      startedChild.once("exit", () => {
        childExited = true;
      });

      const onLine = (line: string, nowMs: number) => {
        if (line.includes("AgentDatabaseAdmissionError")) {
          agentDatabaseAdmissionErrors++;
        }
        const recoveredAgent = /\[slow-agent-bench\] recovered (\S+)/u.exec(line)?.[1];
        if (recoveredAgent && SLOW_DATABASE_AGENT_IDS.some((id) => id === recoveredAgent)) {
          agentRecoveryMs[recoveredAgent] ??= nowMs;
        }
        const recoveredRun = /\[interrupted-registry-bench\] recovered (\S+)/u.exec(line)?.[1];
        if (recoveredRun) {
          agentRecoveryMs[recoveredRun] ??= nowMs;
          registryRecoveryEvents[recoveredRun] = (registryRecoveryEvents[recoveredRun] ?? 0) + 1;
        }
        const gate = /\[slow-agent-bench\] (gate-start|gate-passed)/u.exec(line);
        if (gate) {
          integrityGateMs[gate[1]!] ??= nowMs;
        }
        const readyLogKind = classifyGatewayReadyLog(line);
        if (readyLogKind === "http-listen" && httpListenLogMs == null) {
          httpListenLogMs = nowMs;
          httpListenLogLine = line;
        }
        if (readyLogKind === "gateway-ready" && gatewayReadyLogMs == null) {
          gatewayReadyLogMs = nowMs;
          gatewayReadyLogLine = line;
        }
        if (collectTraceLine(line, "startup trace", startupTrace)) {
          startupTraceLines.push(line);
        }
      };
      const onChunk = (stream: "stderr" | "stdout", chunk: Buffer) => {
        if (firstOutputMs == null) {
          firstOutputMs = performance.now() - startAt;
        }
        const text = chunk.toString("utf8");
        output.push(text);
        if (output.length > 20) {
          output.splice(0, output.length - 20);
        }
        const parsed = collectOutputLines(outputBuffers[stream], text);
        outputBuffers[stream] = parsed.carry;
        const nowMs = performance.now() - startAt;
        for (const line of parsed.lines) {
          onLine(line, nowMs);
        }
      };
      startedChild.stdout.on("data", (chunk: Buffer) => onChunk("stdout", chunk));
      startedChild.stderr.on("data", (chunk: Buffer) => onChunk("stderr", chunk));

      const probe = (probePath: string) =>
        waitForProbe({
          deadlineAt,
          isDone: () => childExited,
          path: probePath,
          port,
          startAt,
        });
      const healthzProbe = probe("/healthz");
      const [healthz, readyz, firstSessionRpc] = await Promise.all([
        healthzProbe,
        probe("/readyz"),
        healthzProbe.then((health) =>
          health.status === 200
            ? waitForFirstSessionRpc({
                port,
                startAt,
                deadlineAt,
                isDone: () => childExited,
                requireSeededSession: options.benchCase.id === "teamBoot",
                ...(options.benchCase.id === "teamBoot" ? { authToken: TEAM_BOOT_AUTH_TOKEN } : {}),
              })
            : { ms: null, attempts: 0, lastError: "Gateway never became healthy" },
        ),
      ]);
      if (slowAgent || interruptedRegistry) {
        while (
          Object.keys(agentRecoveryMs).length <
            (slowAgent ? SLOW_DATABASE_AGENT_IDS.length : INTERRUPTED_REGISTRY_ACTIVE) &&
          startedChild.exitCode === null &&
          startedChild.signalCode === null &&
          performance.now() < deadlineAt
        ) {
          await delay(25);
        }
      }
      const completionMs = options.benchCase.completionTracePhase
        ? await waitForStartupTracePhase({
            deadlineAt,
            isDone: () => childExited,
            phase: options.benchCase.completionTracePhase,
            startupTrace,
          })
        : performance.now() - startAt;
      const completedAt = performance.now();
      const cpuEndMs = readProcessTreeCpuMs(startedChild.pid);
      const cpuMs =
        cpuStartMs == null || cpuEndMs == null ? null : Math.max(0, cpuEndMs - cpuStartMs);
      const cpuCoreRatio = cpuMs == null ? null : cpuMs / Math.max(1, completedAt - startAt);
      const shutdownStartedAt = performance.now();
      let shutdownForced = false;
      const exit = await stopChild(startedChild, {
        ...(options.benchCase.id === "teamBoot" ? { teardownGraceMs: 30_000 } : {}),
        onForceKill: () => {
          shutdownForced = true;
        },
      });
      const shutdownMs = performance.now() - shutdownStartedAt;
      const maxRssMb = rssSampler.sample();
      child = undefined;
      flushOutputLineBuffers(outputBuffers, onLine, performance.now() - startAt);

      return {
        ...(slowAgent ? { agentRecoveryMs, integrityGateMs, agentDatabaseAdmissionErrors } : {}),
        ...(interruptedRegistry
          ? {
              agentRecoveryMs,
              registryRecovery: await inspectInterruptedRegistryRecovery(
                root,
                registryRecoveryEvents,
              ),
            }
          : {}),
        completionMs,
        cpuCoreRatio,
        cpuMs,
        exitedBeforeTeardown: exit.exitedBeforeTeardown,
        exitCode: exit.exitCode,
        firstOutputMs,
        firstSessionRpc,
        gatewayReadyLogLine,
        gatewayReadyLogMs,
        healthz,
        httpListenLogLine,
        httpListenLogMs,
        maxRssMb,
        outputTail: output.join("").split(/\r?\n/u).slice(-20).join("\n"),
        readyz,
        shutdownForced,
        shutdownMs,
        signal: exit.signal,
        startupTrace,
        startupTraceLines,
      };
    } finally {
      rssSampler?.stop();
      if (child) {
        await stopChild(child).catch(() => undefined);
      }
    }
  });
}

async function runCase(
  options: GatewayBenchRuntimeOptions & {
    benchCase: GatewayBenchCase;
    cpuProfDir?: string;
    entry: string;
    heapProfDir?: string;
    runs: number;
    timeoutMs: number;
    warmup: number;
    fixtureRoot?: string;
    startAt?: number;
  },
): Promise<CaseResult> {
  const samples: GatewaySample[] = [];
  const total = options.runs + options.warmup;
  for (let index = 0; index < total; index += 1) {
    const sample = await runGatewaySample({
      ...options,
      sampleIndex: index + 1,
    });
    if (index >= options.warmup) {
      samples.push(sample);
      const heapUsedMb = sample.startupTrace["memory.ready.heapUsedMb"] ?? null;
      console.log(
        `[gateway-startup-bench] ${options.benchCase.id} run ${samples.length}/${options.runs}: completion=${formatMs(sample.completionMs)} healthz=${formatMs(sample.healthz.ms)} readyz=${formatMs(sample.readyz.ms)} sessionsRpc=${formatMs(sample.firstSessionRpc.ms)} httpListen=${formatMs(sample.httpListenLogMs)} gatewayReady=${formatMs(sample.gatewayReadyLogMs)} cpu=${formatMs(sample.cpuMs)} cpuCore=${formatRatio(sample.cpuCoreRatio)} rss=${formatMb(sample.maxRssMb)} heap=${formatMb(heapUsedMb)}`,
      );
      if (
        sample.outputTail &&
        (sample.completionMs == null ||
          sample.healthz.status !== 200 ||
          sample.readyz.status !== 200 ||
          sample.firstSessionRpc.ms === null)
      ) {
        console.error(
          `[gateway-startup-bench] ${options.benchCase.id} output tail:\n${sample.outputTail}`,
        );
      }
    } else {
      const heapUsedMb = sample.startupTrace["memory.ready.heapUsedMb"] ?? null;
      console.log(
        `[gateway-startup-bench] ${options.benchCase.id} warmup ${index + 1}/${options.warmup}: healthz=${formatMs(sample.healthz.ms)} readyz=${formatMs(sample.readyz.ms)} cpu=${formatMs(sample.cpuMs)} cpuCore=${formatRatio(sample.cpuCoreRatio)} rss=${formatMb(sample.maxRssMb)} heap=${formatMb(heapUsedMb)}`,
      );
    }
  }
  return summarizeCase(options.benchCase, samples);
}

function printResult(result: CaseResult): void {
  console.log(`\n${result.name} (${result.id})`);
  console.log(`  completion:   ${formatStats(result.summary.completionMs)}`);
  console.log(`  first output: ${formatStats(result.summary.firstOutputMs)}`);
  console.log(`  CPU:          ${formatStats(result.summary.cpuMs)}`);
  console.log(`  CPU core:     ${formatStats(result.summary.cpuCoreRatio, formatRatio)}`);
  console.log(`  /healthz:     ${formatStats(result.summary.healthzMs)}`);
  console.log(`  http listen:  ${formatStats(result.summary.httpListenLogMs)}`);
  console.log(`  gateway ready: ${formatStats(result.summary.gatewayReadyLogMs)}`);
  console.log(`  /readyz:      ${formatStats(result.summary.readyzMs)}`);
  console.log(`  sessions RPC: ${formatStats(result.summary.firstSessionRpcMs)}`);
  console.log(`  shutdown:     ${formatStats(result.summary.shutdownMs)}`);
  console.log(`  max RSS:      ${formatStats(result.summary.maxRssMb, formatMb)}`);
  console.log(
    `  ready memory: rss=${formatStats(result.summary.startupTrace["memory.ready.rssMb"], formatMb)} heap=${formatStats(result.summary.startupTrace["memory.ready.heapUsedMb"], formatMb)} external=${formatStats(result.summary.startupTrace["memory.ready.externalMb"], formatMb)}`,
  );
  console.log(
    `  post-ready memory: rss=${formatStats(result.summary.startupTrace["memory.post-ready.rssMb"], formatMb)} heap=${formatStats(result.summary.startupTrace["memory.post-ready.heapUsedMb"], formatMb)} external=${formatStats(result.summary.startupTrace["memory.post-ready.externalMb"], formatMb)}`,
  );
  console.log(
    `  prepared runtime: agents=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.agentCount"], String)} workspaces=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.workspaceGroupCount"], String)} configuredGroups=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.configuredFactsGroupCount"], String)} configuredModels=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.configuredRuntimeModelCount"], String)} generatedPlugins=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.generatedCatalogPluginCount"], String)} generatedReads=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.generatedCatalogReadCount"], String)} sources=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.catalogSourceCount"], String)} credentials=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.credentialGroupCount"], String)} catalogs=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.catalogGroupCount"], String)} registries=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.runtimeRegistryCount"], String)} workspaceFacts=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.workspaceFactsMs"])} runtimePlugins=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.runtimePluginMs"])} metadata=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.pluginMetadataMs"])} staticProviders=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.staticProviderCatalogMs"])} ambientAuth=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.ambientCredentialsMs"])} agentFacts=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.agentFactsMs"])} configuredProjection=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.configuredProjectionMs"])} sourceMs=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.catalogSourceMs"])} registryMs=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.registryMs"])} sourceLimit=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.sourceConcurrencyLimitCount"], String)} fullCatalogLimit=${formatStats(result.summary.startupTrace["sidecars.model-runtime-build.fullCatalogConcurrencyLimitCount"], String)} staticCatalog=${formatStats(result.summary.startupTrace["benchmark.preparedRuntimeStaticCatalogCallCount"], String)} pluginLoader=${formatStats(result.summary.startupTrace["sidecars.plugin-loader.callsCount"], String)} eventLoopMax=${formatStats(result.summary.startupTrace["sidecars.model-runtime.eventLoopMax"])}`,
  );
  const trace = selectSlowStartupTraceDurations(result.summary.startupTrace, 8);
  if (trace.length > 0) {
    console.log("  trace top:");
    for (const [name, stats] of trace) {
      console.log(`    ${name}: ${formatStats(stats)}`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    printUsage();
    return;
  }

  const options = parseOptions(argv);
  const slowAgent = options.cases.length === 1 && options.cases[0]?.id === "slowAgentDatabase";
  const teamBoot = options.cases.length === 1 && options.cases[0]?.id === "teamBoot";
  const interruptedRegistry =
    options.cases.length === 1 && options.cases[0]?.id === "interruptedRegistry";
  const fixtureFile = teamBoot
    ? "team-boot-fixture.json"
    : interruptedRegistry
      ? "interrupted-registry-fixture.json"
      : "slow-agent-fixture.json";
  const needsPreparedFixture = options.cases.some(
    ({ id }) => id === "slowAgentDatabase" || id === "teamBoot" || id === "interruptedRegistry",
  );
  if (options.fixtureRoot || options.seedOnly || needsPreparedFixture) {
    if (
      (!slowAgent && !teamBoot && !interruptedRegistry) ||
      !options.fixtureRoot ||
      (!options.seedOnly && (options.runs !== 1 || options.warmup !== 0))
    ) {
      throw new CliArgumentError(
        "teamBoot, slowAgentDatabase and interruptedRegistry require --fixture-root and either --seed-only or --runs 1 --warmup 0",
      );
    }
    if (options.seedOnly) {
      if (interruptedRegistry) {
        await seedInterruptedRegistryFixture(path.resolve(options.fixtureRoot));
        return;
      }
      if (teamBoot) {
        await seedTeamBootFixture(path.resolve(options.fixtureRoot), options.cases[0]!);
        return;
      }
      await seedSlowAgentFixture(
        path.resolve(options.fixtureRoot),
        options.agentDatabaseMib,
        options.agentGateDelayMs,
      );
      return;
    }
    if (!existsSync(path.join(options.fixtureRoot, fixtureFile))) {
      throw new CliArgumentError("--fixture-root must first be prepared with --seed-only");
    }
    if (teamBoot) {
      const fixture = JSON.parse(
        readFileSync(path.join(options.fixtureRoot, "team-boot-fixture.json"), "utf8"),
      ) as { bundledPluginFixture?: OpenClawConfig };
      if (
        JSON.stringify(fixture.bundledPluginFixture ?? {}) !==
        JSON.stringify(options.cases[0]?.bundledPluginFixture ?? {})
      ) {
        throw new CliArgumentError("--bundled-plugin-fixture must match the prepared fixture");
      }
    }
  }
  if (
    options.startAt !== undefined &&
    (options.cases.length !== 1 || options.runs !== 1 || options.warmup !== 0)
  ) {
    throw new CliArgumentError("--start-at requires one case with --runs 1 --warmup 0");
  }
  if (options.installedCohort) {
    const { runInstalledGatewayBenchmark } = await import("./lib/gateway-bench-installed.ts");
    process.exitCode = await runInstalledGatewayBenchmark({
      inputPath: options.installedCohort,
      outputPath: options.output!,
      child: options.installedChild,
      diagnostic: options.installedCpuDiagnostic,
      argv,
    });
    return;
  }
  if (options.cpuProfDir) {
    mkdirSync(options.cpuProfDir, { recursive: true });
  }
  if (options.heapProfDir) {
    mkdirSync(options.heapProfDir, { recursive: true });
  }
  const results: CaseResult[] = [];
  for (const benchCase of options.cases) {
    results.push(await runCase({ ...options, benchCase }));
  }

  const payload = {
    entry: options.entry,
    gatewayRuntime: options.gatewayRuntime,
    gatewayCpus: options.gatewayCpus,
    generatedAt: new Date().toISOString(),
    ...(teamBoot || interruptedRegistry
      ? {
          fixture: JSON.parse(readFileSync(path.join(options.fixtureRoot!, fixtureFile), "utf8")),
        }
      : {}),
    results,
  };
  if (options.output) {
    writeBenchmarkJson(payload, options.output);
  }
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    for (const result of results) {
      printResult(result);
    }
  }

  const failures = collectResultFailures(results);
  if (failures.length > 0) {
    printBenchmarkFailures(failures);
    process.exitCode = 1;
  }
}

export const testing = {
  collectResultFailures,
  listIncidentPackagedPluginArtifacts,
  parseOptions,
  summarizeCase,
  waitForStartupTracePhase,
  withGatewayBenchRoot,
  writeIncidentFixture,
  writeConfig,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err: unknown) => {
    if (err instanceof CliArgumentError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    console.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  });
}
