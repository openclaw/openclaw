// Read-only count probe. Omit from latency runs: stack capture adds observer overhead.
const fs = require("node:fs");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const { isMainThread } = require("node:worker_threads");

if (isMainThread && process.env.SESSION_COST_READY_PROBE) {
  const phases = {};
  const phaseCounts = () => {
    const phase = fs.readFileSync(path.join(process.env.SESSION_COST_READY_PROBE, "phase"), "utf8");
    return (phases[phase] ??= {
      busySleeps: 0,
      refreshPathStatCalls: 0,
      refreshPathRealpathCalls: 0,
    });
  };
  const writeProbe = () => {
    phaseCounts();
    fs.writeFileSync(
      path.join(process.env.SESSION_COST_READY_PROBE, `cost-wait-probe-${process.pid}.json`),
      JSON.stringify({ format: "session-cost-ready-probe-v1", pid: process.pid, phases }, null, 2),
    );
  };
  // Keep completed counts if teardown kills the process before its exit hook.
  setInterval(writeProbe, 1_000).unref();
  const original = globalThis.setTimeout;
  globalThis.setTimeout = new Proxy(original, {
    apply(target, receiver, args) {
      if (args[1] === 25 && /loadSessionCostSummary/u.test(new Error().stack ?? "")) {
        phaseCounts().busySleeps++;
      }
      return Reflect.apply(target, receiver, args);
    },
  });
  for (const [name, counter] of [
    ["statSync", "refreshPathStatCalls"],
    ["realpathSync", "refreshPathRealpathCalls"],
  ]) {
    fs[name] = new Proxy(fs[name], {
      apply(target, receiver, args) {
        const stack = new Error().stack ?? "";
        if (
          (stack.includes("prepareSessionCostUsageRefreshLock") ||
            stack.includes("createCacheWriter")) &&
          stack.includes("loadSessionCostSummary")
        ) {
          phaseCounts()[counter]++;
        }
        return Reflect.apply(target, receiver, args);
      },
    });
  }
  fs.realpathSync.native = new Proxy(fs.realpathSync.native, {
    apply(target, receiver, args) {
      const stack = new Error().stack ?? "";
      if (
        (stack.includes("prepareSessionCostUsageRefreshLock") ||
          stack.includes("createCacheWriter")) &&
        stack.includes("loadSessionCostSummary")
      ) {
        phaseCounts().refreshPathRealpathCalls++;
      }
      return Reflect.apply(target, receiver, args);
    },
  });
  syncBuiltinESMExports();
  process.on("exit", writeProbe);
}
