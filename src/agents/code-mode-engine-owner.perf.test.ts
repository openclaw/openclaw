import { channel } from "node:diagnostics_channel";
import { arch, cpus, loadavg } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import {
  createCatalogCodeModeHarness,
  jsonTool,
  resetCodeModeTestState,
  testing,
} from "./code-mode.test-support.js";

// Opt-in measurement: public exec/wait owner with deterministic external tool I/O.
// OPENCLAW_CODE_MODE_MEASURE=1 node scripts/run-vitest.mjs <this-file> -t '^node '
// Separate processes and alternate engines for independent comparison arms.
const enabled = process.env.OPENCLAW_CODE_MODE_MEASURE === "1";
const rounds = Number(process.env.OPENCLAW_CODE_MODE_MEASURE_ROUNDS ?? 12);
const diagnostics = channel("openclaw.worker.task");
type TaskTiming = {
  queueMs: number;
  preparationMs: number;
  runMs: number;
  transferMs: number;
  hostWaitMs: number;
};
const summarize = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    n: values.length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
};
const cases = [
  { name: "noop-empty", source: "return 42;", value: 42, calls: 0, catalog: 0 },
  { name: "noop-160", source: "return 42;", value: 42, calls: 0 },
  {
    name: "cpu-100k",
    source: "let x=0;for(let i=0;i<100000;i++)x=(x+i)|0;return x;",
    value: 704982704,
    calls: 0,
  },
  {
    name: "cpu-1m",
    source: "let x=0;for(let i=0;i<1000000;i++)x=(x+i)|0;return x;",
    value: 1783293664,
    calls: 0,
  },
  ...[16, 64].flatMap((count) =>
    [false, true].map((required) => ({
      name: `sequential-${count}-${required ? "required" : "ordinary"}`,
      source: `let n=0;for(let i=0;i<${count};i++)n+=(await fixture_echo({})).value;return n;`,
      value: count * 7,
      calls: count,
      required,
    })),
  ),
  {
    name: "joined-16",
    source:
      "return (await Promise.all(Array.from({length:16},()=>fixture_echo({})))).reduce((n,r)=>n+r.value,0);",
    value: 112,
    calls: 16,
  },
  {
    name: "reply-128KiB",
    source: "return (await fixture_large({})).payload.length;",
    value: 128 * 1024,
    calls: 1,
    largeReply: true,
  },
  {
    name: "final-json-64KiB",
    source: 'return Array.from({length:1024},(_,i)=>({i,text:"x".repeat(40)}));',
    value: Array.from({ length: 1024 }, (_, i) => ({ i, text: "x".repeat(40) })),
    calls: 0,
  },
];

describe.runIf(enabled).each(["node", "quickjs"] as const)(
  "%s production owner measurements",
  (executor) => {
    afterEach(resetCodeModeTestState);
    it.each(cases)(
      "$name",
      async (scenario) => {
        expect(Number.isSafeInteger(rounds) && rounds >= 5 && rounds <= 40).toBe(true);
        const fixture = jsonTool("fixture_echo", { value: 7 });
        const large = jsonTool("fixture_large", { payload: "x".repeat(128 * 1024) });
        const extra = Array.from(
          { length: ("catalog" in scenario ? scenario.catalog : undefined) ?? 160 },
          (_, i) => jsonTool(`fixture_${i}`, i),
        );
        const targets = scenario.calls === 0 ? extra : [fixture, large, ...extra];
        const h = createCatalogCodeModeHarness(targets, {
          codeMode: {
            executor,
            timeoutMs: 30_000,
            memoryLimitBytes: 64 * 1024 * 1024,
            maxSnapshotBytes: 16 * 1024 * 1024,
            maxOutputBytes: 1024 * 1024,
          },
          modelContextWindowTokens: 1_000_000,
        });
        // Production keeps Node workers alive under the Gateway resource owner.
        // Without this host, each Node cell retires its pool and measures cold startup.
        const host = new LegacyPluginSdkResourceHost();
        host.bindScheduler(new GatewayScheduler());
        let observed: TaskTiming[] = [];
        const onTask = (message: unknown) => {
          const task = message as TaskTiming & { worker?: string };
          if (task.worker?.startsWith("code-mode") && task.worker.includes("worker")) {
            observed.push(task);
          }
        };
        diagnostics.subscribe(onTask);
        const latencies: number[] = [],
          taskCounts: number[] = [],
          waits: number[] = [];
        const timingTotals: TaskTiming = {
          queueMs: 0,
          preparationMs: 0,
          runMs: 0,
          transferMs: 0,
          hostWaitMs: 0,
        };
        const initialLoad = loadavg();
        const beforeCpu = process.cpuUsage();
        const beforeRss = process.memoryUsage().rss;
        let peakObservedRss = beforeRss;
        let firstCellMs = 0;
        let calls = 0;
        try {
          for (let index = -3; index < rounds; index++) {
            observed = [];
            const beforeCalls =
              vi.mocked(fixture.execute).mock.calls.length +
              vi.mocked(large.execute).mock.calls.length;
            const at = performance.now();
            let result = await host.run(() =>
              h.run(scenario.source, `owner-${index}`, {
                awaitResults: "required" in scenario && scenario.required,
              }),
            );
            let waitCount = 0;
            while (result.status === "waiting" && waitCount < 256) {
              const current = result;
              const waitCallId = `owner-${index}-wait-${waitCount}`;
              waitCount += 1;
              result = await host.run(() => h.resume(current, waitCallId));
            }
            const elapsed = performance.now() - at;
            expect(result).toMatchObject({ status: "completed", value: scenario.value });
            const actualCalls =
              vi.mocked(fixture.execute).mock.calls.length +
              vi.mocked(large.execute).mock.calls.length -
              beforeCalls;
            expect(actualCalls).toBe(scenario.calls);
            expect(testing.activeRuns.size).toBe(0);
            peakObservedRss = Math.max(peakObservedRss, process.memoryUsage().rss);
            if (index === -3) {
              firstCellMs = elapsed;
            }
            if (index >= 0) {
              latencies.push(elapsed);
              taskCounts.push(observed.length);
              waits.push(waitCount);
              calls += actualCalls;
              for (const item of observed) {
                for (const field of Object.keys(timingTotals) as (keyof TaskTiming)[]) {
                  timingTotals[field] += item[field];
                }
              }
            }
          }
          const cpu = process.cpuUsage(beforeCpu);
          console.log(
            "CODE_MODE_OWNER_MEASURE " +
              JSON.stringify({
                executor,
                scenario: scenario.name,
                rounds,
                firstCellMs,
                catalogBindings: targets.length,
                latency: summarize(latencies),
                calls,
                taskCounts,
                waits,
                timingTotals,
                cpuMsIncludingWarmup: (cpu.user + cpu.system) / 1000,
                beforeRss,
                peakObservedRss,
                loadStart: initialLoad,
                loadEnd: loadavg(),
                node: process.version,
                arch: arch(),
                cpu: cpus()[0]?.model,
              }),
          );
        } finally {
          diagnostics.unsubscribe(onTask);
          await host.close();
        }
      },
      90_000,
    );
  },
);
