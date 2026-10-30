/**
 * Diagnostic plugin-scope census for already-built Gateways. Pass this file to
 * team-shape-stress.ts with --gateway-preload "$PWD/scripts/perf/plugin-scope-attribution-preload.mjs".
 * The harness writes plugin-scope-counts.json beside each arm's measurements.
 * Join sampled allocation stacks to rows by markerName. Named declarations are
 * intentional: V8 collapses computed-property wrapper names to an unnamed marker.
 * Exclude this preload's diagnostic subtrees, including beneath nested markers,
 * from allocation totals. Stack collection changes CPU/allocation: use separate
 * uninstrumented runs for decisions. Async continuations remain unassigned.
 * This preload does not configure plugins or modify Gateway state.
 */
import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { compileFunction } from "node:vm";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  const key = Symbol.for("openclaw.benchmark.pluginScope");
  const rows = new Map();
  const installed = new Map();
  const expected = ["plugin", "gateway", "workRuns", "workTracks"];
  let measuring = false;
  let active;
  function classify(stack) {
    for (const line of stack.split("\n")) {
      if (/node:async_hooks|plugin-scope-attribution-preload/.test(line)) {
        continue;
      }
      if (/host-hook|\bhooks-|run\w*Hook|runHook/.test(line)) {
        return "hooks";
      }
      if (/cli-backend|CliBackend|CLIBackend/.test(line)) {
        return "cli-backends";
      }
      if (/executeTool|execute\w*Tool|tool-execution/.test(line)) {
        return "tool-calls";
      }
      if (/service-|Service|scheduler|Scheduler/.test(line)) {
        return "services";
      }
      if (/stream|Stream|inference|Inference|completion|Completion|provider/.test(line)) {
        return "provider";
      }
      if (/runPluginHttpRoute/.test(line)) {
        return "http";
      }
      if (/resolvePluginTools/.test(line)) {
        return "tool-setup";
      }
    }
    return "other";
  }
  function row(plugin, entry) {
    const id = `${plugin}:${entry}`;
    let result = rows.get(id);
    if (!result) {
      const name = `scope_${rows.size}_${plugin.replace(/[^a-zA-Z0-9]/g, "_")}_${entry.replace(/-/g, "_")}`;
      const marker = compileFunction(
        `return function ${name}(fn, scope, run, third, fourth) { return fn(scope, run, third, fourth); }\n//# sourceURL=plugin-scope-attribution://${name}`,
      )();
      if (marker.name !== name) {
        throw new Error("Plugin scope marker name mismatch");
      }
      result = {
        plugin,
        entry,
        markerName: name,
        marker,
        pluginScopeEntries: 0,
        gatewayScopeEntries: 0,
        workRuns: 0,
        alreadyPendingRuns: 0,
        workTracks: 0,
        stacks: new Map(),
      };
      rows.set(id, result);
    }
    return result;
  }
  globalThis[key] = {
    plugin(fn, scope, run, registry, invocation) {
      if (!measuring) {
        return fn(scope, run, registry, invocation);
      }
      const stack = (new Error().stack ?? "")
        .split("\n")
        .slice(3)
        .map((line) => line.replace(/(?:file:\/\/)?\/[^ ()]*\/|[A-Za-z]:\\[^ ()]*\\/g, ""))
        .join("\n");
      const current = row(scope.pluginId ?? "<host>", classify(stack));
      current.pluginScopeEntries++;
      current.stacks.set(stack, (current.stacks.get(stack) ?? 0) + 1);
      const previous = active;
      active = current;
      try {
        return current.marker(fn, scope, run, registry, invocation);
      } finally {
        active = previous;
      }
    },
    gateway(scope) {
      if (measuring) {
        (active ?? row(scope.pluginId ?? "<host>", "other")).gatewayScopeEntries++;
      }
    },
    work(kind, pending) {
      if (!measuring) {
        return;
      }
      const current = active ?? row("<outside-plugin-scope>", "other");
      current[kind]++;
      if (kind === "workRuns" && pending) {
        current.alreadyPendingRuns++;
      }
    },
  };
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (
        !/\/(?:gateway-request-scope|async-work-scope)-[^/]+\.mjs$/.test(url) ||
        result.source == null
      ) {
        return result;
      }
      let source =
        typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
      const owner = url.includes("/gateway-request-scope-")
        ? "src/plugins/runtime/gateway-request-scope.ts"
        : "src/shared/async-work-scope.ts";
      // Public export barrels share the filename prefix but contain no owner implementation.
      if (!source.includes(`//#region ${owner}`)) {
        return result;
      }
      const census = 'globalThis[Symbol.for("openclaw.benchmark.pluginScope")]';
      function replace(name, declaration, replacement) {
        const index = source.indexOf(declaration);
        if (index < 0 || source.includes(declaration, index + declaration.length)) {
          throw new Error(
            `Plugin scope instrumentation mismatch: ${name} in ${path.basename(url)}`,
          );
        }
        source = source.replace(declaration, replacement);
        installed.set(name, path.basename(url));
      }
      if (url.includes("/gateway-request-scope-")) {
        replace(
          "plugin",
          "function withPluginRuntimePluginScope(scope, run, registry, invocation) {",
          `function withPluginRuntimePluginScope(scope, run, registry, invocation) { return ${census}.plugin(measuredPluginScope, scope, run, registry, invocation); }\nfunction measuredPluginScope(scope, run, registry, invocation) {`,
        );
        const gateway = "function runWithPluginGatewayScope(gatewayScope, run, invocation) {";
        replace("gateway", gateway, `${gateway}\n${census}.gateway(gatewayScope);`);
      } else {
        for (const [method, counter] of [
          ["run", "workRuns"],
          ["track", "workTracks"],
        ]) {
          const declaration = `\n\t${method}(run) {`;
          replace(
            counter,
            declaration,
            `${declaration}\n${census}.work(${JSON.stringify(counter)}, this.pending.size > 0);`,
          );
        }
      }
      return { ...result, source };
    },
  });
  process.on("message", (message) => {
    if (message?.channel !== "team-shape-stress") {
      return;
    }
    if (message.action !== "start" && message.action !== "stop") {
      return;
    }
    const missing = expected.filter((name) => !installed.has(name));
    if (missing.length) {
      throw new Error(`Plugin scope instrumentation missing: ${missing.join(", ")}`);
    }
    if (message.action === "start") {
      rows.clear();
      measuring = true;
      return;
    }
    measuring = false;
    writeFileSync(
      path.join(message.output, "plugin-scope-counts.json"),
      JSON.stringify(
        {
          installed: Object.fromEntries(installed),
          caveats: [
            "Diagnostic stack census affects CPU and allocations outside marker frames.",
            "Synchronous markers do not attribute asynchronous continuation allocations.",
            "Entry classification uses named stack frames; unclassified calls remain other.",
          ],
          rows: [...rows.values()].map(({ marker: _marker, stacks, ...value }) =>
            Object.assign(value, {
              stacks: [...stacks].map(([stack, count]) => ({ stack, count })),
            }),
          ),
        },
        null,
        2,
      ),
    );
  });
  process.channel?.unref();
}
