import { registerHooks } from "node:module";

globalThis.fetch = async () => {
  throw new Error("Benchmark attempted a real network request");
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "openclaw/plugin-sdk/ssrf-runtime"
      ? {
          url: new URL("./report-run.benchmark-fixtures.test-support.ts", import.meta.url).href,
          shortCircuit: true,
        }
      : nextResolve(specifier, context);
  },
});

await import("./run.worker.js");
