// Load erasable TypeScript instrumentation without transforming built Gateway code.
// This must be the first loader; package imports use the measured build's exports.
import { writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

// Node strips types; only source instrumentation needs .js-to-.ts resolution.
const sourceRoots = [
  new URL("../../src/", import.meta.url).href,
  new URL("../", import.meta.url).href,
];
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error?.code !== "ERR_MODULE_NOT_FOUND" ||
        !specifier.startsWith(".") ||
        !specifier.endsWith(".js") ||
        !sourceRoots.some((root) => context.parentURL?.startsWith(root))
      ) {
        throw error;
      }
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});

if (isMainThread) {
  // Diagnostic allocation passes only: count owner work without changing production exports.
  if (process.env.OPENCLAW_BENCH_OPERATOR_MODEL_POLICY_COUNTS === "1") {
    const key = "openclaw.benchmark.operator-model-policy";
    const names = [
      "prepareOperatorModelPolicy",
      "restoreOperatorModelPolicySnapshot",
      "prepareRefs",
      "prepareSessionRowRecipient",
    ];
    const counts = Object.fromEntries(names.map((name) => [name, 0]));
    const installed = new Set();
    globalThis[Symbol.for(key)] = counts;
    registerHooks({
      load(url, context, nextLoad) {
        const result = nextLoad(url, context);
        if (!/\/(?:operator-model-policy|session-row-presentation)-[^/]+\.mjs$/.test(url)) {
          return result;
        }
        if (result.source == null) {
          return result;
        }
        let source =
          typeof result.source === "string"
            ? result.source
            : new TextDecoder().decode(result.source);
        for (const name of names) {
          const declaration = new RegExp(`function ${name}\\([^)]*\\) \\{`);
          if (declaration.test(source)) {
            installed.add(name);
            source = source.replace(
              declaration,
              `$&\nglobalThis[Symbol.for(${JSON.stringify(key)})].${name}++;`,
            );
          }
        }
        return { ...result, source };
      },
    });
    let started;
    process.on("message", (message) => {
      if (message?.channel !== "team-shape-stress") {
        return;
      }
      if (message.action === "start") {
        for (const name of names) {
          counts[name] = 0;
        }
        started = performance.now();
      } else if (message.action === "stop" && started !== undefined) {
        writeFileSync(
          path.join(message.output, "operator-model-policy-counts.json"),
          JSON.stringify(
            {
              durationMs: performance.now() - started,
              counts,
              installed: [...installed],
              scope:
                "Main isolate; diagnostic allocation pass only. prepareRefs runs twice per configured allow/deny policy preparation.",
            },
            null,
            2,
          ),
        );
      }
    });
  }
  process.channel?.unref();
  const instrumentationSource = new URL("../../src/", import.meta.url).href;
  const packages = new Set(["@openclaw/normalization-core", "@openclaw/worker-runtime"]);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const packageName = specifier.split("/").slice(0, 2).join("/");
      if (!context.parentURL?.startsWith(instrumentationSource) || !packages.has(packageName)) {
        return nextResolve(specifier, context);
      }
      // Worker telemetry imports source instrumentation. Its internal workspace
      // dependencies still use the measured build's compiled package exports.
      const buildRoot = path.dirname(path.dirname(path.resolve(process.argv[1])));
      const resolve = createRequire(
        path.join(buildRoot, "packages", packageName.slice("@openclaw/".length), "package.json"),
      );
      return nextResolve(pathToFileURL(resolve.resolve(specifier)).href, context);
    },
  });
}
