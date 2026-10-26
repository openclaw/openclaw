/**
 * Diagnostic main-isolate timer census for a synthetic dist Gateway:
 *   node --import ./scripts/tsx.mjs scripts/perf/team-shape-stress.ts \
 *     --candidate "$PWD" --output "$PWD/.local/timer-census" --minutes 10 \
 *     --mode timing --gateway-preload "$PWD/scripts/perf/timer-census-preload.mjs"
 * Counts every set/clear call and samples 1/16 stacks during the harness window.
 * timer-census.json reports estimated call-site counts/minute; timer-census.cpuprofile
 * attributes CPU to timer internals. Instrumented latency/allocation is diagnostic.
 */
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import timers from "node:timers";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  const sampleProbability = 1 / 16;
  let capture;
  let profiling = Promise.resolve();
  const inspector = new Session();
  inspector.connect();
  for (const name of ["setTimeout", "clearTimeout"]) {
    const original = timers[name];
    const wrapped = new Proxy(original, {
      apply(target, receiver, args) {
        if (capture) {
          capture.counts[name]++;
          if (Math.random() < sampleProbability) {
            const stack = new Error().stack?.split("\n").slice(2, 6).join("\n") ?? "unknown";
            const key = `${name}\n${stack}`;
            capture.samples.set(key, (capture.samples.get(key) ?? 0) + 1);
          }
        }
        return Reflect.apply(target, receiver, args);
      },
    });
    timers[name] = globalThis[name] = wrapped;
  }
  syncBuiltinESMExports();
  process.on("message", (message) => {
    if (message?.channel !== "team-shape-stress") {
      return;
    }
    if (message.action === "start") {
      capture = {
        started: performance.now(),
        counts: { setTimeout: 0, clearTimeout: 0 },
        samples: new Map(),
      };
      profiling = inspector.post("Profiler.enable").then(() => inspector.post("Profiler.start"));
    } else if (message.action === "stop" && capture) {
      const completed = capture;
      capture = undefined;
      const durationMs = performance.now() - completed.started;
      writeFileSync(
        path.join(message.output, "timer-census.json"),
        JSON.stringify(
          {
            durationMs,
            sampleProbability,
            counts: completed.counts,
            callsPerMinute: Object.fromEntries(
              Object.entries(completed.counts).map(([name, count]) => [
                name,
                (count * 60_000) / durationMs,
              ]),
            ),
            sites: [...completed.samples]
              .toSorted((a, b) => b[1] - a[1])
              .map(([stack, samples]) => ({
                stack,
                samples,
                estimatedCallsPerMinute: ((samples / sampleProbability) * 60_000) / durationMs,
              })),
          },
          null,
          2,
        ),
      );
      profiling = profiling.then(async () => {
        const { profile } = await inspector.post("Profiler.stop");
        writeFileSync(
          path.join(message.output, "timer-census.cpuprofile"),
          JSON.stringify(profile),
        );
        inspector.disconnect();
      });
    }
    void profiling.catch(console.error);
  });
}
