/**
 * Real durable-actor SessionManager appends with synthetic assistant/tool turns.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/transcript-writer-assert-measure.mjs \
 *   --mode counts --operations 1000 --output .local/writer-counts.json
 * Modes: counts (source probes), allocation (1 KiB sampling), timing (untraced).
 * --owners-dir overlays frozen repo-relative sources for same-checkout A/B runs.
 * Acceptance: fewer assertion calls/allocation, identical persisted message digest,
 * and no established CPU regression. This measures the append owner, not Gateway load.
 * The small synthetic test database uses the safe default temp root and is removed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    operations: { type: "string", default: "1000" },
    warmup: { type: "string", default: "200" },
    output: { type: "string" },
    "owners-dir": { type: "string" },
  },
});
const operations = Number(values.operations);
const warmup = Number(values.warmup);
assert(Number.isSafeInteger(warmup) && warmup >= 0 && warmup % 2 === 0);
assert(Number.isSafeInteger(operations) && operations > 0);
assert(values.output && ["timing", "allocation", "counts"].includes(values.mode));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const counters = {};
const counterKey = Symbol.for("openclaw.bench.writer-assert");
globalThis[counterKey] = counters;
let assertionLocation;
const probes = new Map([
  [
    "src/agents/sessions/session-manager-persistence.ts",
    [
      [/const assertCurrent\s*=\s*(?:__name\()?\(\)\s*=>\s*\{/, "persistence"],
      [/const assertBinding\s*=\s*(?:__name\()?\(\)\s*=>\s*\{/, "binding"],
    ],
  ],
  [
    "src/agents/sessions/session-manager-append-admission.ts",
    [[/const assertCurrent\s*=\s*(?:__name\()?\(\)\s*=>\s*\{/, "appendAdmission"]],
  ],
  [
    "src/agents/sessions/session-manager-actor-append.ts",
    [[/authorize:\s*(?:__name\()?\([^)]*\)\s*=>\s*\{/, "authorize"]],
  ],
  [
    "src/config/sessions/transcript-write-context.ts",
    [
      [/function captureOwnedTranscriptWriteAssertion\([^)]*\)\s*\{/, "captureOwned"],
      [/function assertTranscriptWriteContext\([\s\S]*?\)\s*\{(?=\s*if)/, "ownedCheck"],
      [/function assertSessionTranscriptInitialWriter\([^)]*\)\s*\{/, "initialCheck"],
    ],
  ],
]);
registerHooks({
  load(url, context, nextLoad) {
    const name = path.relative(
      repo,
      fileURLToPath(url.startsWith("file:") ? url : pathToFileURL(repo)),
    );
    if (!probes.has(name)) {
      return nextLoad(url, context);
    }
    const frozen = values["owners-dir"] && path.resolve(values["owners-dir"], name);
    const loaded = nextLoad(
      frozen && existsSync(frozen) ? pathToFileURL(frozen).href : url,
      context,
    );
    let source =
      typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
    if (name.endsWith("session-manager-persistence.ts")) {
      const match = /const assertCurrent\s*=\s*(?:__name\()?(\(\)\s*=>\s*\{)/.exec(source);
      assert(match, "Missing persistence assertion");
      const offset = match.index + match[0].indexOf(match[1]);
      const prefix = source.slice(0, offset).split("\n");
      assertionLocation = { lineNumber: prefix.length - 1, columnNumber: prefix.at(-1).length };
    }
    if (values.mode !== "counts") {
      return loaded;
    }
    for (const [needle, label] of probes.get(name)) {
      assert(needle.test(source), `Missing probe ${label}`);
      source = source.replace(
        needle,
        (declaration) =>
          `${declaration} const c = globalThis[Symbol.for("openclaw.bench.writer-assert")]; c.${label} = (c.${label} || 0) + 1;`,
      );
    }
    return { ...loaded, source, shortCircuit: true };
  },
});
const { createOpenClawTestState } = await import("../../src/test-utils/openclaw-test-state.js");
const { upsertSessionEntryCore, loadTranscriptEvents } =
  await import("../../src/config/sessions/session-accessor.js");
const { SessionManager } = await import("../../src/agents/sessions/session-manager.js");
const { withSelectedTranscriptReader } =
  await import("../../src/agents/sessions/session-manager-reader.test-support.js");
const { withSessionTranscriptWriteAssertion } =
  await import("../../src/config/sessions/transcript-write-context.js");
const state = await createOpenClawTestState({ label: "writer-assert" });
await mkdir(path.dirname(values.output), { recursive: true });
const inspector = values.mode === "allocation" ? new Session() : undefined;
try {
  const target = {
    agentId: "main",
    sessionId: "synthetic-writer",
    sessionKey: "agent:main:synthetic-writer",
    storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  const manager = await SessionManager.openAsync(target, state.workspaceDir);
  await manager.appendMessageAsync({ role: "user", content: "Synthetic tool turn", timestamp: 0 });
  const messages = Array.from({ length: operations + warmup }, (_, index) =>
    index % 2 === 0
      ? {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: `call-${index}`,
              name: "read",
              arguments: { path: "synthetic.txt" },
            },
          ],
          api: "openai-responses",
          provider: "openai",
          model: "synthetic",
          stopReason: "toolUse",
          timestamp: index,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }
      : {
          role: "toolResult",
          toolCallId: `call-${index - 1}`,
          toolName: "read",
          content: [{ type: "text", text: "Synthetic output ".repeat(128) }],
          isError: false,
          timestamp: index,
        },
  );
  let result;
  await withSelectedTranscriptReader(
    target,
    () =>
      withSessionTranscriptWriteAssertion(
        target,
        () => {},
        async () => {
          for (const message of messages.slice(0, warmup)) {
            await manager.appendMessageAsync(message);
          }
          for (const key of Object.keys(counters)) {
            delete counters[key];
          }
          globalThis.gc?.();
          inspector?.connect();
          if (inspector) {
            await inspector.post("HeapProfiler.startSampling", {
              samplingInterval: 1024,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
          }
          const hostLoad = loadavg();
          const cpu = process.threadCpuUsage();
          const start = performance.now();
          for (const message of messages.slice(warmup)) {
            await manager.appendMessageAsync(message);
          }
          const elapsedMs = performance.now() - start;
          const used = process.threadCpuUsage(cpu);
          const profile = inspector
            ? (await inspector.post("HeapProfiler.stopSampling")).profile
            : undefined;
          if (profile) {
            await writeFile(`${values.output}.heapprofile`, JSON.stringify(profile));
          }
          const leaves = new Map();
          let total = 0;
          let assertion = 0;
          function visit(node, inside = false) {
            const frame = node.callFrame;
            const selected =
              inside ||
              (frame.url.includes("session-manager-persistence") &&
                frame.lineNumber === assertionLocation?.lineNumber &&
                frame.columnNumber === assertionLocation?.columnNumber);
            total += node.selfSize;
            if (selected) {
              assertion += node.selfSize;
              const label = `${frame.functionName}@${path.basename(frame.url)}`;
              leaves.set(label, (leaves.get(label) ?? 0) + node.selfSize);
            }
            for (const child of node.children) {
              visit(child, selected);
            }
          }
          if (profile) {
            visit(profile.head);
          }
          result = {
            assertionLocation,
            mode: values.mode,
            warmup,
            operations,
            hostLoad,
            elapsedMs,
            mainThreadCpuMs: (used.user + used.system) / 1000,
            counters: { ...counters },
            sampledBytes: total,
            assertionSampledBytes: assertion,
            assertionLeaves: [...leaves].toSorted((a, b) => b[1] - a[1]).slice(0, 15),
            memory: process.memoryUsage(),
          };
        },
      ),
    true,
  );
  const events = await loadTranscriptEvents(target);
  const persisted = events
    .filter((entry) => entry.type === "message")
    .slice(warmup + 1)
    .map((entry) => entry.message);
  assert.deepEqual(persisted, messages.slice(warmup));
  result.messageSha256 = createHash("sha256").update(JSON.stringify(persisted)).digest("hex");
  await mkdir(path.dirname(values.output), { recursive: true });
  await writeFile(values.output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  inspector?.disconnect();
  await state.cleanup();
  delete globalThis[counterKey];
}
