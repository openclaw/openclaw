/**
 * Matched source-runtime probe, not ShellBench or packaged startup proof.
 * node --import ./scripts/tsx.mjs scripts/perf/code-mode-engine-measure.ts [pairs=5] [rounds=40]
 * Each arm gets a fresh process; order alternates, workers then stay warm within
 * that arm. Each cell checks its value; bridge counts are checked per scenario.
 * No forced GC.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus, loadavg, platform, arch } from "node:os";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type {
  CodeModeExecutor,
  CodeModeExecutorContinuation,
  CodeModeWorkerResult,
} from "../../src/agents/code-mode-executor-types.js";

const child = process.argv[2] === "--arm";
const rounds = Number(process.argv[child ? 4 : 3] ?? 40);
assert(Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 1000);
if (!child) {
  const pairs = Number(process.argv[2] ?? 5);
  assert(Number.isSafeInteger(pairs) && pairs > 0 && pairs <= 20);
  for (let pair = 0; pair < pairs; pair++) {
    for (const executor of pair % 2 ? ["quickjs", "node"] : ["node", "quickjs"]) {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          fileURLToPath(new URL("../tsx.mjs", import.meta.url)),
          fileURLToPath(import.meta.url),
          "--arm",
          executor,
          String(rounds),
        ],
        { encoding: "utf8", timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
      );
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
      assert.equal(result.status, 0, String(result.error ?? result.stdout));
      console.log(JSON.stringify({ pair, ...JSON.parse(result.stdout) }));
    }
  }
} else {
  const engine = process.argv[3];
  assert(engine === "node" || engine === "quickjs");
  const importedAt = performance.now();
  const [{ LegacyPluginSdkResourceHost }, { GatewayScheduler }] = await Promise.all([
    import("../../src/plugins/legacy-sdk-resource-host.js"),
    import("../../src/infra/gateway-scheduler.js"),
  ]);
  const executor: CodeModeExecutor =
    engine === "node"
      ? (await import("../../src/agents/code-mode-node.js")).nodeCodeModeExecutor
      : (await import("../../extensions/code-mode-quickjs/code-mode-executor-api.js"))
          .codeModeExecutor;
  const importMs = performance.now() - importedAt;
  const config = {
    timeoutMs: 30_000,
    memoryLimitBytes: 64 * 1024 * 1024,
    maxOutputBytes: 64 * 1024,
    maxPendingToolCalls: 16,
    maxSnapshotBytes: 10 * 1024 * 1024,
  };
  const catalog = Array.from({ length: 160 }, (_, index) => ({
    name: `tool_${index}`,
    callableName: `tool_${index}`,
    source: "openclaw",
    description: "Synthetic tool description ".repeat(8),
  }));
  const { prepareCodeModeNodeCatalog } = await import("../../src/agents/code-mode-node-input.js");
  const prepared = prepareCodeModeNodeCatalog({ catalog, namespaces: [] });
  const host = new LegacyPluginSdkResourceHost();
  const scheduler = new GatewayScheduler();
  host.bindScheduler(scheduler);
  const keepAlive = globalThis.setInterval(() => {}, 1000);
  const continuations = new Set<CodeModeExecutorContinuation>();
  let bridgeCalls = 0;
  let checkpoints = 0;
  let observedRssBytes = process.memoryUsage().rss;
  const observe = () => {
    observedRssBytes = Math.max(observedRssBytes, process.memoryUsage().rss);
  };
  const sampler = globalThis.setInterval(observe, 5);
  const initialRssBytes = process.memoryUsage().rss;
  const initialLoad = loadavg();
  const settle = (requests: { id: string; method: string; args: unknown[] }[]) =>
    requests.map((request) => {
      assert.equal(request.method, "callValue");
      assert.equal(request.args[0], "tool_0");
      bridgeCalls++;
      return { id: request.id, ok: true, json: JSON.stringify(request.args[1]) };
    });
  const retain = (result: CodeModeWorkerResult) => {
    if (result.status === "waiting") {
      continuations.add(result.continuation);
    }
    return result;
  };
  // Take custody where each result arrives, before a sibling failure or a
  // consumer assertion can prevent registration of a parked execution.
  const execute = async (source: string, checkpoint = false) =>
    retain(
      await host.run(() =>
        executor.execute(
          {
            kind: "exec",
            source,
            config,
            ...prepared,
          },
          {
            timeoutMs: config.timeoutMs,
            inlineHost: {
              onBoundary: async (boundary, context) =>
                checkpoint
                  ? { kind: "checkpoint" }
                  : {
                      kind: "continue",
                      timeoutMs: context.maxTimeoutMs,
                      pendingRequests: [],
                      settledRequests: settle(boundary.pendingRequests),
                    },
            },
          },
        ),
      ),
    );
  const finish = async (initial: CodeModeWorkerResult) => {
    let result = initial;
    while (result.status === "waiting") {
      assert(checkpoints++ < 100_000, "run did not finish");
      const current = result;
      result = retain(
        await host.run(() =>
          current.continuation.resume(
            {
              kind: "resume",
              config,
              settledRequests: settle(current.pendingRequests),
            },
            { timeoutMs: config.timeoutMs },
          ),
        ),
      );
      continuations.delete(current.continuation);
    }
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert(result.status === "completed" && result.value?.kind === "complete");
    observe();
    return JSON.parse(result.value.json) as unknown;
  };
  const scenarios = [
    { name: "noop", source: "return 42;", expected: 42, calls: 0 },
    {
      name: "cpu",
      source: "let x=0; for(let i=0;i<100000;i++) x=(x+i)|0; return x;",
      expected: 704982704,
      calls: 0,
    },
    {
      name: "json",
      source:
        "const s=JSON.stringify(Array.from({length:1000},(_,i)=>({i,s:'abc'}))); return JSON.parse(s).length;",
      expected: 1000,
      calls: 0,
    },
    ...[1, 32, 128].map((count) => ({
      name: `bridge-${count}`,
      source: `let r; for(let i=0;i<${count};i++) r=await tool_0({value:i}); return r.value;`,
      expected: count - 1,
      calls: count,
    })),
    {
      name: "parallel-16",
      source:
        "return (await Promise.all(Array.from({length:16},(_,i)=>tool_0({value:i})))).map(x=>x.value);",
      expected: Array.from({ length: 16 }, (_, i) => i),
      calls: 16,
    },
    {
      name: "checkpoint-1MiB",
      source:
        "const b=new Uint8Array(1024*1024); b.fill(7); const r=await tool_0({value:1}); return b[0]+b[b.length-1]+r.value;",
      expected: 15,
      calls: 1,
      checkpoint: true,
    },
  ];
  const summaries = [];
  const armCpu = process.cpuUsage();
  const armAt = performance.now();
  const failures = new Set<unknown>();
  try {
    const coldAt = performance.now();
    assert.equal(await finish(await execute("return 42;")), 42);
    const coldWorkerMs = performance.now() - coldAt;
    const timezone = await finish(
      await execute(
        "return { offset: new Date('2026-01-01T00:00:00Z').getTimezoneOffset(), hour: new Date('2026-01-01T00:00:00Z').getHours() };",
      ),
    );
    for (const scenario of scenarios) {
      for (let warmup = 0; warmup < 3; warmup++) {
        assert.deepEqual(
          await finish(await execute(scenario.source, scenario.checkpoint)),
          scenario.expected,
        );
      }
      const latencies = [];
      const beforeCalls = bridgeCalls;
      const beforeCheckpoints = checkpoints;
      const cpu = process.cpuUsage();
      const at = performance.now();
      for (let index = 0; index < rounds; index++) {
        const cellAt = performance.now();
        assert.deepEqual(
          await finish(await execute(scenario.source, scenario.checkpoint)),
          scenario.expected,
        );
        latencies.push(performance.now() - cellAt);
      }
      const elapsed = performance.now() - at;
      const usage = process.cpuUsage(cpu);
      assert.equal(bridgeCalls - beforeCalls, rounds * scenario.calls);
      latencies.sort((a, b) => a - b);
      summaries.push({
        scenario: scenario.name,
        samples: rounds,
        wallMs: elapsed,
        cpuMs: (usage.user + usage.system) / 1000,
        medianMs: latencies[Math.floor(rounds / 2)],
        p95Ms: latencies[Math.min(rounds - 1, Math.ceil(rounds * 0.95) - 1)],
        bridgeCalls: bridgeCalls - beforeCalls,
        checkpoints: checkpoints - beforeCheckpoints,
      });
    }
    const beforeParkBytes = process.memoryUsage().rss;
    // A failed execution still owns its launched siblings until they settle.
    const parkedResults = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        execute(
          "const b=new Uint8Array(1024*1024); b.fill(7); await tool_0({value:1}); return b[0]+b[b.length-1];",
          true,
        ),
      ),
    );
    const parked = parkedResults.map((result) => {
      if (result.status === "rejected") {
        throw result.reason;
      }
      return result.value;
    });
    let retainedBytes = 0;
    for (const result of parked) {
      assert.equal(result.status, "waiting", JSON.stringify(result));
      assert(result.status === "waiting");
      retainedBytes += result.continuation.retainedBytes;
    }
    await setTimeout(100);
    const parkedRssBytes = process.memoryUsage().rss;
    for (const result of parked) {
      assert.equal(await finish(result), 14);
    }
    const cpu = process.cpuUsage(armCpu);
    const armWallMs = performance.now() - armAt;
    await host.close();
    observe();
    const hash = (relative: string) =>
      createHash("sha256")
        .update(readFileSync(new URL(relative, import.meta.url)))
        .digest("hex");
    console.log(
      JSON.stringify({
        executor: engine,
        node: process.version,
        quickjs: JSON.parse(
          readFileSync(
            new URL("../../extensions/code-mode-quickjs/package.json", import.meta.url),
            "utf8",
          ),
        ).dependencies["quickjs-wasi"],
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        guestTimezone: timezone,
        mode: "source workers with tsx; synthetic executor boundary",
        rounds,
        importMs,
        coldWorkerMs,
        armWallMs,
        armCpuMs: (cpu.user + cpu.system) / 1000,
        initialRssBytes,
        observedRssBytes,
        beforeParkBytes,
        parkedRssBytes,
        parkedCount: parked.length,
        retainedBytes,
        // Node retainedBytes is its configured heap estimate; QuickJS reports
        // serialized bytes. Neither is an observed process-memory measurement.
        bridgeCalls,
        checkpoints,
        loadStart: initialLoad,
        loadEnd: loadavg(),
        summaries,
        sourceHashes: {
          node: hash("../../src/agents/code-mode-node.worker.ts"),
          quickjs: hash("../../extensions/code-mode-quickjs/src/code-mode.worker.ts"),
        },
      }),
    );
  } catch (error) {
    failures.add(error);
  } finally {
    try {
      const disposed = await Promise.allSettled(
        [...continuations].map(async (value) => value.dispose()),
      );
      for (const result of disposed) {
        if (result.status === "rejected") {
          failures.add(result.reason);
        }
      }
      for (const close of [() => host.close(), () => scheduler.stop()]) {
        try {
          await close();
        } catch (error) {
          failures.add(error);
        }
      }
    } finally {
      // Keep the process alive until every cleanup attempt settles, including
      // when another cleanup rejects. Rejection must not leave either timer alive.
      clearInterval(sampler);
      clearInterval(keepAlive);
    }
  }
  if (failures.size > 0) {
    const [cause] = failures;
    throw failures.size === 1
      ? cause
      : new AggregateError(failures, "Code Mode measurement and cleanup failed", { cause });
  }
}
