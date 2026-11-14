// Isolated Team-shaped Gateway attribution; pass with team-shape-stress.ts --gateway-preload.
// Counts and a native 1 ms CPU profile cover only the harness's measured IPC window.
// Instrumented counts are diagnostic, not an untraced performance comparison.
import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { startCpuProfile } from "node:v8";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  const key = Symbol.for("openclaw.benchmark.diagnostics-observers");
  const counts = Object.create(null);
  const installed = new Set();
  let recording = false;
  globalThis[key] = (name) => {
    if (recording) {
      counts[name] = (counts[name] ?? 0) + 1;
    }
  };
  const owners = [
    {
      pattern: /\/diagnostic-events-[^/]+\.mjs$/,
      counters: [
        { name: "emit", anchor: /function emitDiagnosticEventWithTrust\([^)]*\) \{/ },
        { name: "dispatch", anchor: /function dispatchDiagnosticEvent\([^)]*\) \{/ },
      ],
    },
    {
      pattern: /\/main-thread-stall-[^/]+\.mjs$/,
      counters: [
        { name: "task", anchor: /run\(name, run, taskPhase\) \{/ },
        { name: "continuation", anchor: /begin\(name, now\(\)\);/ },
      ],
    },
    {
      pattern: /\/diagnostic-profile-[^/]+\.mjs$/,
      counters: [
        { name: "profile.parse", anchor: /function parseNativeCpuProfile\([^)]*\) \{/ },
        { name: "profile.frame", anchor: /function sanitizeDiagnosticProfileFrame\([^)]*\) \{/ },
      ],
    },
    {
      pattern: /\/gateway-prewarm\.js$/,
      counters: [{ name: "flight.sample", anchor: /sample\(stall\) \{/ }],
    },
    {
      pattern: /\/extensions\/diagnostics-prometheus\/index\.js$/,
      counters: [
        { name: "series", anchor: /const series = \([^)]*\) => \{/ },
        { name: "histogram", anchor: /const histogram = \([^)]*\) => \{/ },
        { name: "scrape", anchor: /const render = \(\) => \{/ },
      ],
    },
  ];
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      const owner = owners.find(({ pattern }) => pattern.test(url));
      if (!owner || result.source == null) {
        return result;
      }
      let source =
        typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
      for (const { name, anchor } of owner.counters) {
        if (!anchor.test(source)) {
          throw new Error(`Missing observer census anchor ${name} in ${url}`);
        }
        source = source.replace(
          anchor,
          `$&\nglobalThis[Symbol.for("openclaw.benchmark.diagnostics-observers")](${JSON.stringify(name)});`,
        );
        installed.add(name);
      }
      return { ...result, source };
    },
  });
  let profile;
  let output;
  let cpu;
  let started;
  process.on("message", (message) => {
    if (message?.channel !== "team-shape-stress") {
      return;
    }
    if (message.action === "start") {
      output = message.output;
      for (const name of Object.keys(counts)) {
        delete counts[name];
      }
      profile = startCpuProfile({ sampleInterval: 1, maxBufferSize: 1_000_000 });
      cpu = process.threadCpuUsage();
      started = performance.now();
      recording = true;
    } else if (message.action === "stop" && profile) {
      recording = false;
      const durationMs = performance.now() - started;
      const used = process.threadCpuUsage(cpu);
      const raw = profile.stop();
      profile = undefined;
      writeFileSync(path.join(output, "diagnostics-observers.cpuprofile.raw"), raw);
      writeFileSync(
        path.join(output, "diagnostics-observers-counts.json"),
        JSON.stringify(
          {
            durationMs,
            mainThreadCpuMs: (used.user + used.system) / 1000,
            counts,
            installed: [...installed],
            node: process.version,
          },
          null,
          2,
        ),
      );
    }
  });
  process.channel?.unref();
}
