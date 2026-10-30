// Benchmark-only instrumentation of the built create owner's existing phase tracker.
// Load after team-shape-stress-loader.mjs; never changes the production export surface.
import { registerHooks } from "node:module";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  const counterKey = "openclaw.benchmark.sessionCreateSpawns";
  globalThis[Symbol.for(counterKey)] = {};
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (
        !/\/(?:session-create-diagnostics|spawn-diagnostics)-[^/]+\.mjs$/.test(url) ||
        loaded.source == null
      ) {
        return loaded;
      }
      let source =
        typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
      if (url.includes("/spawn-diagnostics-")) {
        const marker = "const previous = spawnCounts.counts.get(key);";
        if (!source.includes(marker)) {
          throw new Error("Spawn counter instrumentation no longer matches this build");
        }
        source = source.replace(
          marker,
          `${marker}
          const measured = globalThis[Symbol.for(${JSON.stringify(counterKey)})];
          if (family === "git") measured[operation] = (measured[operation] ?? 0) + 1;`,
        );
        return { ...loaded, source };
      }
      if (
        !source.includes("const snapshot = timing.snapshot();") ||
        !source.includes("function startSessionCreateDiagnostics() {")
      ) {
        throw new Error("Session-create timing instrumentation no longer matches this build");
      }
      source = source
        .replace(
          "function startSessionCreateDiagnostics() {",
          `function startSessionCreateDiagnostics() {
        globalThis[Symbol.for(${JSON.stringify(counterKey)})] = {};`,
        )
        .replace(
          "const snapshot = timing.snapshot();",
          `const snapshot = timing.snapshot();
          snapshot.gitSpawns = { ...globalThis[Symbol.for(${JSON.stringify(counterKey)})] };
          process.send?.({ channel: "session-create-measure", snapshot });`,
        );
      return { ...loaded, source };
    },
  });
}
