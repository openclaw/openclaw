/**
 * Control assembly + real argument validation, 170 rotating synthetic sessions.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/code-mode-control-schema-measure.ts
 *   [--source /absolute/frozen-code-mode.ts] [--iterations 5000] [--count-compiles]
 * Run five fresh processes per side in AB/BA order. --source substitutes only the
 * owner module at its original URL. No tools execute. CPU/allocation exclude imports,
 * warmup and explicit GC; compilation counts use a separate diagnostic pass.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { getHeapCodeStatistics, getHeapStatistics } from "node:v8";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    iterations: { type: "string", default: "5000" },
    "count-compiles": { type: "boolean" },
  },
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "iterations",
  min: 1,
  fallback: 5000,
});
const owner = new URL("../../src/agents/code-mode.ts", import.meta.url);
const source = readFileSync(values.source ? path.resolve(values.source) : owner, "utf8");
registerHooks({
  load(url, context, nextLoad) {
    return url === owner.href
      ? { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true }
      : nextLoad(url, context);
  },
});
const { createCodeModeTools } = await import("../../src/agents/code-mode.js");
const { validateToolArguments } = await import("../../packages/llm-core/src/validation.js");
let compiles = 0;
if (values["count-compiles"]) {
  globalThis.Function = new Proxy(globalThis.Function, {
    construct(target, args, newTarget) {
      compiles++;
      return Reflect.construct(target, args, newTarget);
    },
  });
}
const contexts = Array.from({ length: 170 }, (_, index) => ({
  agentId: `agent-${index % 4}`,
  sessionId: `synthetic-${index}`,
  sessionKey: `agent:main:synthetic-${index}`,
  config: { tools: { codeMode: { enabled: true, timeoutMs: 10_000 } } },
}));
function assemble(index: number) {
  const context = contexts[index % contexts.length];
  assert(context);
  for (const tool of createCodeModeTools(context)) {
    validateToolArguments(tool, {
      type: "toolCall",
      id: "synthetic",
      name: tool.name,
      arguments: tool.name === "exec" ? { code: "return 42;" } : { runId: "synthetic-cell" },
    });
  }
}
const allocation = () => {
  const bytes: unknown = Reflect.get(getHeapStatistics(), "total_allocated_bytes");
  assert(typeof bytes === "number", "Node with native cumulative allocation counter required");
  return bytes;
};
assert(globalThis.gc, "Run with --expose-gc");
for (let index = 0; index < 200; index++) {
  assemble(index);
}
globalThis.gc();
const warmCompiles = compiles;
const beforeCode = getHeapCodeStatistics();
const allocatedBefore = allocation();
const cpuBefore = process.cpuUsage();
const started = performance.now();
for (let index = 0; index < iterations; index++) {
  assemble(index);
}
const wallMs = performance.now() - started;
const cpu = process.cpuUsage(cpuBefore);
const allocatedBytes = allocation() - allocatedBefore;
console.log(
  JSON.stringify({
    ownerSha256: createHash("sha256").update(source).digest("hex"),
    iterations,
    sessions: contexts.length,
    validationCalls: iterations * 2,
    diagnostic: Boolean(values["count-compiles"]),
    warmCompiles,
    compiles: values["count-compiles"] ? compiles - warmCompiles : null,
    cpuMs: (cpu.user + cpu.system) / 1000,
    wallMs,
    allocatedBytes,
    codeBefore: beforeCode,
    codeAfter: getHeapCodeStatistics(),
    load: loadavg(),
  }),
);
