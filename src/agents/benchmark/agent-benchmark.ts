/**
 * Agent subsystem benchmark baseline.
 *
 * Measures cold/warm latency for the critical operations in src/agents/.
 * Run: bun src/agents/benchmark/agent-benchmark.ts
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

type BenchmarkResult = {
  metric: string;
  value: number;
  unit: string;
  notes: string;
};

const results: BenchmarkResult[] = [];

function record(metric: string, value: number, unit: string, notes = "") {
  results.push({ metric, value: Math.round(value * 100) / 100, unit, notes });
}

async function timeAsync<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - start };
}

function timeSync<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

async function benchmarkModuleImports() {
  // Cold import of model-selection (pure computation, no I/O)
  const { ms: modelSelectionMs } = await timeAsync(() => import("../model-selection.js"));
  record("Module import: model-selection", modelSelectionMs, "ms", "cold import");

  // Cold import of workspace (has fs deps)
  const { ms: workspaceMs } = await timeAsync(() => import("../workspace.js"));
  record("Module import: workspace", workspaceMs, "ms", "cold import");

  // Cold import of system-prompt
  const { ms: systemPromptMs } = await timeAsync(() => import("../system-prompt.js"));
  record("Module import: system-prompt", systemPromptMs, "ms", "cold import");

  // Cold import of pi-embedded-runner/run (the big one)
  const { ms: runnerMs } = await timeAsync(() => import("../pi-embedded-runner/run.js"));
  record("Module import: pi-embedded-runner/run", runnerMs, "ms", "cold import, heavy deps");
}

async function benchmarkModelSelection() {
  const { normalizeProviderId, parseModelRef, buildModelAliasIndex } =
    await import("../model-selection.js");

  // normalizeProviderId - hot path, called per-request
  const iterations = 10_000;
  const providers = ["anthropic", "openai", "z.ai", "bedrock", "aws-bedrock", "google", "ollama"];
  const { ms: normalizeMs } = timeSync(() => {
    for (let i = 0; i < iterations; i++) {
      for (const p of providers) {
        normalizeProviderId(p);
      }
    }
  });
  record(
    "normalizeProviderId (10k x 7 providers)",
    normalizeMs,
    "ms",
    `${(((iterations * providers.length) / normalizeMs) * 1000).toFixed(0)} ops/sec`,
  );

  // parseModelRef
  const refs = [
    "anthropic/claude-sonnet-4-5",
    "openai/gpt-5.3",
    "claude-sonnet-4-5",
    "google/gemini-2.5-pro",
  ];
  const { ms: parseMs } = timeSync(() => {
    for (let i = 0; i < iterations; i++) {
      for (const r of refs) {
        parseModelRef(r, "anthropic");
      }
    }
  });
  record(
    "parseModelRef (10k x 4 refs)",
    parseMs,
    "ms",
    `${(((iterations * refs.length) / parseMs) * 1000).toFixed(0)} ops/sec`,
  );

  // buildModelAliasIndex with a realistic config
  const mockCfg = {
    agents: {
      defaults: {
        models: {
          "anthropic/claude-sonnet-4-5": { alias: "sonnet" },
          "anthropic/claude-opus-4-5": { alias: "opus" },
          "openai/gpt-5.3": { alias: "gpt" },
          "google/gemini-2.5-pro": { alias: "gemini" },
        },
      },
    },
  };
  const { ms: aliasMs } = timeSync(() => {
    for (let i = 0; i < 1000; i++) {
      buildModelAliasIndex({ cfg: mockCfg as never, defaultProvider: "anthropic" });
    }
  });
  record("buildModelAliasIndex (1k iterations)", aliasMs, "ms", "4 model entries");
}

async function benchmarkAuthProfileStore() {
  const { loadAuthProfileStore } = await import("../auth-profiles/store.js");

  // Cold load
  const { ms: coldMs } = timeSync(() => {
    loadAuthProfileStore();
  });
  record("Auth profile store: cold load", coldMs, "ms", "disk read + parse");

  // Warm load (cached)
  const { ms: warmMs } = timeSync(() => {
    for (let i = 0; i < 100; i++) {
      loadAuthProfileStore();
    }
  });
  record("Auth profile store: warm load (100x)", warmMs, "ms", "should be cached");
}

async function benchmarkWorkspaceBootstrap() {
  const { loadWorkspaceBootstrapFiles } = await import("../workspace.js");
  const tmpDir = path.join(os.tmpdir(), `oc-bench-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });

  // Create minimal bootstrap files
  await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "# Test agent\nBe helpful.");
  await fs.writeFile(path.join(tmpDir, "IDENTITY.md"), "# Identity\nYou are a test agent.");
  await fs.writeFile(path.join(tmpDir, "TOOLS.md"), "# Tools\nUse tools wisely.");

  // Cold load
  const { ms: coldMs } = await timeAsync(() => loadWorkspaceBootstrapFiles(tmpDir));
  record("Workspace bootstrap: cold load", coldMs, "ms", "3 files present");

  // Warm load (file cache should help)
  const { ms: warmMs } = await timeAsync(() => loadWorkspaceBootstrapFiles(tmpDir));
  record("Workspace bootstrap: warm load", warmMs, "ms", "inode cache hit");

  await fs.rm(tmpDir, { recursive: true, force: true });
}

async function benchmarkToolDisplayCommon() {
  const { resolveExecDetail } = await import("../tool-display-common.js");

  const commands = [
    "git status",
    "cd /tmp && npm install && npm test",
    'grep -rn "pattern" src/',
    "bash -c 'echo hello world'",
    "ENV_VAR=1 python3 script.py --flag value",
    "find . -name '*.ts' -type f | head -20",
  ];

  const iterations = 1000;
  const { ms: execDetailMs } = timeSync(() => {
    for (let i = 0; i < iterations; i++) {
      for (const cmd of commands) {
        resolveExecDetail({ command: cmd });
      }
    }
  });
  record(
    "resolveExecDetail (1k x 6 commands)",
    execDetailMs,
    "ms",
    `shell parsing + summarization`,
  );
}

async function benchmarkSubagentRegistryQueries() {
  const { countActiveDescendantRunsFromRuns, listRunsForRequesterFromRuns } =
    await import("../subagent-registry-queries.js");

  // Simulate a registry with 50 runs
  const runs = new Map<
    string,
    {
      childSessionKey: string;
      requesterSessionKey: string;
      endedAt?: number;
      cleanupCompletedAt?: number;
      outcome?: { status: string };
    }
  >();
  for (let i = 0; i < 50; i++) {
    runs.set(`run-${i}`, {
      childSessionKey: `child-${i}`,
      requesterSessionKey: i < 25 ? "main" : `child-${i % 10}`,
      endedAt: i < 40 ? Date.now() : undefined,
      cleanupCompletedAt: i < 30 ? Date.now() : undefined,
      outcome: i < 40 ? { status: "ok" } : undefined,
    });
  }

  const iterations = 1000;
  const { ms: countMs } = timeSync(() => {
    for (let i = 0; i < iterations; i++) {
      countActiveDescendantRunsFromRuns(runs as never, "main");
    }
  });
  record("countActiveDescendantRuns (1k, 50 runs)", countMs, "ms", "graph traversal");

  const { ms: listMs } = timeSync(() => {
    for (let i = 0; i < iterations; i++) {
      listRunsForRequesterFromRuns(runs as never, "main");
    }
  });
  record("listRunsForRequester (1k, 50 runs)", listMs, "ms", "linear scan");
}

function printResults() {
  const maxMetric = Math.max(...results.map((r) => r.metric.length));
  const maxValue = Math.max(...results.map((r) => String(r.value).length));
  const maxUnit = Math.max(...results.map((r) => r.unit.length));

  console.log("\n" + "=".repeat(80));
  const systemInfo = `${os.type()} ${os.release()} | ${os.cpus()[0]?.model ?? "unknown"} | Node ${process.version}`;
  console.log("  Agent Subsystem Benchmark Baseline");
  console.log("  " + new Date().toISOString());
  console.log("  " + systemInfo);
  console.log("=".repeat(80));
  console.log();

  const header = `  ${"Metric".padEnd(maxMetric + 2)}${"Current".padStart(maxValue + 2)}  ${"Unit".padEnd(maxUnit + 2)}Notes`;
  const separator = `  ${"-".repeat(maxMetric + 2)}${"-".repeat(maxValue + 2)}  ${"-".repeat(maxUnit + 2)}${"─".repeat(30)}`;
  console.log(header);
  console.log(separator);

  for (const r of results) {
    const line = `  ${r.metric.padEnd(maxMetric + 2)}${String(r.value).padStart(maxValue + 2)}  ${r.unit.padEnd(maxUnit + 2)}${r.notes}`;
    console.log(line);
  }
  console.log();
}

async function main() {
  console.log("Running agent subsystem benchmarks...\n");

  try {
    await benchmarkModuleImports();
  } catch (e) {
    console.warn("Module import benchmarks skipped:", (e as Error).message);
  }

  try {
    await benchmarkModelSelection();
  } catch (e) {
    console.warn("Model selection benchmarks skipped:", (e as Error).message);
  }

  try {
    await benchmarkAuthProfileStore();
  } catch (e) {
    console.warn("Auth profile store benchmarks skipped:", (e as Error).message);
  }

  try {
    await benchmarkWorkspaceBootstrap();
  } catch (e) {
    console.warn("Workspace bootstrap benchmarks skipped:", (e as Error).message);
  }

  try {
    await benchmarkToolDisplayCommon();
  } catch (e) {
    console.warn("Tool display benchmarks skipped:", (e as Error).message);
  }

  try {
    await benchmarkSubagentRegistryQueries();
  } catch (e) {
    console.warn("Subagent registry benchmarks skipped:", (e as Error).message);
  }

  printResults();
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
