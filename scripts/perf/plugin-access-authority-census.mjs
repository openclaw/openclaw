/**
 * Count authority checks in an isolated, already-built Gateway (diagnostic only):
 * node --import ./scripts/tsx.mjs scripts/perf/transcript-broadcast-measure.ts \
 *   --state-dir <synthetic-fixture> --entry <build>/dist/entry.js \
 *   --scenario memory-soak --operator-access-policy --operator-access-policies 40 \
 *   --stress-tools --stress-subagents --clients 4 --runs 1 --soak-rounds 2 \
 *   --warmup-ms 0 --retained-profile-ms 0 --reset-every-rounds 0 \
 *   --port 41980 --mock-port 41982 --gateway-preload <absolute-path-to-this-file>
 * The fixture must contain a real synthetic project (--projects 1 or greater).
 * result.json samples[].operatorAccessPolicy.scopeCounts records checks and scope
 * calls in the same window as plugin callbacks, primaryTurns and sourceEvents.
 * One selected policy returns a grant; the other 39 return no applicable grant.
 * Use fresh fixtures for historical builds with their matching database schemas.
 * Access assertion caller stacks (40 frames) are grouped in each round's callers
 * map. Stack capture adds diagnostic overhead; counts retain the same boundaries.
 * Never combine these injected counters with allocation/CPU acceptance evidence.
 */
import { registerHooks } from "node:module";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  const key = Symbol.for("openclaw.benchmark.accessAuthorityCensus");
  const installed = {};
  let callers = {};
  let active = false;
  let counts = {};
  const observers = [
    {
      owner: "src/config/sessions/session-source-authority.ts",
      name: "assertSources",
      declaration: /const assertSources = \(\) => \{/g,
    },
    {
      owner: "src/gateway/operator-access-policy.ts",
      name: "accessAssertCurrent",
      declaration: /const assertCurrent = \(\) => \{/g,
    },
    {
      owner: "src/plugins/runtime/gateway-request-scope.ts",
      name: "pluginGatewayScopeCalls",
      declaration: /function runWithPluginGatewayScope\([^)]*\) \{/g,
    },
  ];
  const census = {
    count(name) {
      if (active) {
        counts[name] = (counts[name] ?? 0) + 1;
        if (name === "accessAssertCurrent") {
          const previousLimit = Error.stackTraceLimit;
          let stack;
          try {
            Error.stackTraceLimit = 42;
            stack = new Error().stack?.split("\n").slice(2, 42).join("\n") ?? "<missing stack>";
          } finally {
            Error.stackTraceLimit = previousLimit;
          }
          callers[stack] = (callers[stack] ?? 0) + 1;
        }
      }
    },
    snapshot() {
      return {
        counts: { ...counts },
        installed: { ...installed },
        callers: { ...callers },
      };
    },
  };
  globalThis[key] = census;
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.endsWith(".mjs") || result.source == null) {
        return result;
      }
      let source =
        typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
      for (const { owner, name, declaration } of observers) {
        const marker = `//#region ${owner}\n`;
        const start = source.indexOf(marker);
        if (start < 0) {
          continue;
        }
        const end = source.indexOf("//#endregion", start);
        if (end < 0) {
          throw new Error(`Authority census owner region is incomplete: ${owner}`);
        }
        const region = source.slice(start, end);
        let matches = 0;
        const measured = region.replace(declaration, (match) => {
          matches++;
          return `${match}\nglobalThis[Symbol.for("openclaw.benchmark.accessAuthorityCensus")].count(${JSON.stringify(name)});`;
        });
        if (matches !== 1) {
          throw new Error(`Authority census expected one ${name}, found ${matches}: ${url}`);
        }
        installed[name] = (installed[name] ?? 0) + matches;
        source = source.slice(0, start) + measured + source.slice(end);
      }
      return { ...result, source };
    },
  });
  process.on("message", (message) => {
    if (message?.channel !== "openclaw-operator-authority-bench") {
      return;
    }
    if (message.action === "start") {
      const missing = observers.filter(({ name }) => !installed[name]).map(({ name }) => name);
      if (missing.length) {
        throw new Error(`Authority census missing: ${missing.join(", ")}`);
      }
      counts = {};
      callers = {};
      active = true;
    } else if (message.action === "stop") {
      active = false;
    }
  });
}
