// Diagnostic-only preload: keep traced load timings separate from latency comparisons.
import { mkdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { threadId } from "node:worker_threads";

const directory = process.env.OPENCLAW_LAZY_IMPORT_TRACE_DIR;
if (!directory) {
  throw new Error("OPENCLAW_LAZY_IMPORT_TRACE_DIR is required");
}
mkdirSync(directory, { recursive: true });
const events = [];
const key = Symbol.for("openclaw.lazy-import-trace");
const trace = {
  phase: "startup",
  events,
  evaluate(feature, url) {
    events.push({ kind: "evaluate", feature, url, phase: trace.phase, at: Date.now() });
  },
  async load(feature, owner, specifier, importer) {
    const phase = trace.phase;
    const at = Date.now();
    const started = performance.now();
    try {
      return await importer();
    } finally {
      events.push({
        kind: "import",
        feature,
        owner,
        specifier,
        phase,
        at,
        ms: performance.now() - started,
      });
    }
  },
};
globalThis[key] = trace;
const access = 'globalThis[Symbol.for("openclaw.lazy-import-trace")]';
function featureFor(specifier) {
  if (specifier.includes("mcp-transport-config")) {
    return undefined;
  }
  if (/reasoning-tag-text-partitioner/u.test(specifier)) {
    return "parser";
  }
  if (/io\.legacy-issues\.runtime|legacy-config-issues/u.test(specifier)) {
    return "config-diagnostic";
  }
  if (/control-ui-public-session\.runtime/u.test(specifier)) {
    return "public-session";
  }
  if (
    /modelcontextprotocol\/client|mcp-client-lifecycle|mcp-json-schema-validator|mcp-client-elicitation\.runtime|mcp-transport|native-mcp-connect|native-mcp-runtime-client|agent-bundle-mcp-catalog-projection|mcp-error/u.test(
      specifier,
    )
  ) {
    return "mcp";
  }
  return undefined;
}
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (
      !url.startsWith("file:") ||
      !result.source ||
      !/\.(?:mjs|js|ts)$/u.test(new URL(url).pathname)
    ) {
      return result;
    }
    let source =
      typeof result.source === "string" ? result.source : Buffer.from(result.source).toString();
    let changed = false;
    source = source.replace(/\bimport\((['"])([^'"\n]+)\1\)/gu, (call, _quote, specifier) => {
      const feature = featureFor(specifier);
      if (!feature) {
        return call;
      }
      changed = true;
      return `${access}.load(${JSON.stringify(feature)},${JSON.stringify(url)},${JSON.stringify(specifier)},()=>${call})`;
    });
    const feature = featureFor(new URL(url).pathname);
    if (feature) {
      changed = true;
      source += `\n${access}.evaluate(${JSON.stringify(feature)},${JSON.stringify(url)});\n`;
    }
    return changed ? { ...result, source } : result;
  },
});
const flush = () =>
  writeFileSync(
    path.join(directory, `imports-${process.pid}-${threadId}.json`),
    JSON.stringify({ pid: process.pid, threadId, events }, null, 2),
  );
const interval = setInterval(flush, 1000);
interval.unref();
process.on("exit", flush);
