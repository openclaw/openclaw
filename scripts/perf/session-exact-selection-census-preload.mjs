// Temporary L230 diagnostic: synthetic harness only; never enabled by the Gateway.
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  const census = new Map();
  const installed = new Set();
  let started;
  const symbol = Symbol.for("openclaw.benchmark.exact-selection-census");
  globalThis[symbol] = (kind, rows, task) => {
    if (kind !== "exact" || started === undefined) return;
    const stack = new Error().stack.split("\n").slice(2, 18).join("\n");
    const key = JSON.stringify([task ?? "unattributed", stack]);
    let counter = census.get(key);
    if (!counter) {
      counter = { task: task ?? "unattributed", stack, calls: 0, rows: 0 };
      census.set(key, counter);
    }
    counter.calls++;
    counter.rows += rows;
  };
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.includes("/dist/") || result.source == null) return result;
      const source =
        typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
      const declaration = /function recordSessionRowSelection\(kind, rows, task\) \{/;
      if (!declaration.test(source)) return result;
      installed.add(url);
      return {
        ...result,
        source: source.replace(
          declaration,
          `$&\nglobalThis[Symbol.for("openclaw.benchmark.exact-selection-census")](kind, rows, task);`,
        ),
      };
    },
  });
  const inspector = new Session();
  inspector.connect();
  process.on("message", async (message) => {
    if (message?.channel !== "team-shape-stress") return;
    if (message.action === "start") {
      census.clear();
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.start");
      started = performance.now();
    } else if (message.action === "stop" && started !== undefined) {
      const durationMs = performance.now() - started;
      started = undefined;
      writeFileSync(
        path.join(message.output, "exact-selection-census.json"),
        JSON.stringify(
          {
            durationMs,
            installed: [...installed],
            counters: [...census.values()].sort((a, b) => b.calls - a.calls),
          },
          null,
          2,
        ),
      );
      const { profile } = await inspector.post("Profiler.stop");
      writeFileSync(
        path.join(message.output, "exact-selection.cpuprofile"),
        JSON.stringify(profile),
      );
      inspector.disconnect();
    }
  });
}
