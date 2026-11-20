/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/compaction-transcript-clone-measure.ts
 *   --scratch /isolated/proof --output /isolated/result.json [--owner-file /isolated/base.ts]
 * Run five counterbalanced A/A and A/B pairs, allocation separately. Acceptance:
 * identical context/rewrite bytes, lower rewrite CPU/allocation, no >20% p95 regression.
 * Measures initial-context publication and a two-entry rewrite of hydrated 1,700-message
 * history. SQL setup/hydration is outside timing; rewrite commit is included.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import { sessionManagerReadInitialContext } from "../../src/agents/sessions/session-manager-current-turn.js";
import { sessionManagerReadTranscriptBranch } from "../../src/agents/sessions/session-manager-view-types.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";

const { values } = parseArgs({
  options: {
    scratch: { type: "string" },
    output: { type: "string" },
    "owner-file": { type: "string" },
    allocation: { type: "boolean", default: false },
    operations: { type: "string", default: "5" },
  },
});
assert(
  values.scratch && values.output && globalThis.gc,
  "--scratch, --output, --expose-gc required",
);
const operations = Number(values.operations);
assert(Number.isSafeInteger(operations) && operations > 0);
const directory = mkdtempSync(path.join(values.scratch, "compaction-clones-"));
process.env.OPENCLAW_STATE_DIR = directory;
process.env.OPENCLAW_CONFIG_PATH = path.join(directory, "openclaw.json");
process.env.OPENCLAW_AGENT_DIR = path.join(directory, "agents/main/agent");
const ownerUrl = new URL(
  "../../src/agents/embedded-agent-runner/transcript-rewrite.ts",
  import.meta.url,
);
const replaced = registerPerfOwnerReplacement(ownerUrl.href, values["owner-file"]);
const { rewriteTranscriptEntriesInSessionManager: rewrite } =
  await import("../../src/agents/embedded-agent-runner/transcript-rewrite.js");
const { SessionManager } = await import("../../src/agents/sessions/session-manager.js");
const { upsertSessionEntryCore } = await import("../../src/config/sessions/session-accessor.js");
const { replaceTranscriptEvents } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-write.test-support.js");
const { cleanupSessionStateForTest } =
  await import("../../src/test-utils/session-state-cleanup.js");
const { waitForSessionTranscriptProjection } =
  await import("../../src/config/sessions/session-transcript-reconcile.js");
assert(!values["owner-file"] || replaced(), "Baseline owner not loaded");
const target = {
  agentId: "main",
  sessionId: "synthetic",
  sessionKey: "agent:main:synthetic",
  storePath: path.join(directory, "sessions.json"),
};
const timestamp = "2026-01-01T00:00:00.000Z";
const events = [
  { type: "session", version: 4, id: "synthetic", cwd: directory, timestamp },
  ...Array.from({ length: 1700 }, (_, index) => {
    const turn = Math.floor(index / 4);
    const message =
      index % 4 === 0
        ? { role: "user", content: `Inspect synthetic module ${turn}`, timestamp: index }
        : index % 4 === 2
          ? {
              role: "toolResult",
              toolCallId: `call-${turn}`,
              toolName: "read",
              isError: false,
              timestamp: index,
              content: [{ type: "text", text: `${index}: synthetic source\n`.padEnd(32768, "x") }],
              details: {
                matches: Array.from({ length: 128 }, (_value, row) => ({
                  path: `src/module-${turn}-${row}.ts`,
                  range: { start: row, end: row + 4 },
                  preview: ["const synthetic = true", "export { synthetic }"],
                })),
              },
            }
          : {
              role: "assistant",
              api: "openai-responses",
              provider: "openai",
              model: "synthetic",
              timestamp: index,
              stopReason: "stop",
              content:
                index % 4 === 1
                  ? [
                      {
                        type: "toolCall",
                        id: `call-${turn}`,
                        name: "read",
                        arguments: { path: `src/module-${turn}.ts` },
                      },
                    ]
                  : [{ type: "text", text: `Module ${turn} reviewed.` }],
              usage: {
                input: 100,
                output: 20,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 120,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            };
    return {
      type: "message",
      id: `entry-${index}`,
      parentId: index ? `entry-${index - 1}` : null,
      timestamp,
      message,
    };
  }),
];
const fixtureBytes = Buffer.byteLength(JSON.stringify(events));
const samples: Array<{ phase: string; wallMs: number; cpuMs: number; bytes?: number }> = [];
const digests: string[] = [];
const inspector = new Session();
const hostBefore = loadavg();
async function measure<T>(
  phase: string,
  iteration: number,
  operation: () => T | Promise<T>,
): Promise<T> {
  await setImmediate();
  globalThis.gc!();
  if (values.allocation && iteration >= 0) {
    await startCollectedHeapSampling(inspector, 32768);
  }
  const startCpu = process.threadCpuUsage();
  const start = performance.now();
  const result = await operation();
  const wallMs = performance.now() - start;
  const used = process.threadCpuUsage(startCpu);
  let bytes: number | undefined;
  if (values.allocation && iteration >= 0) {
    bytes = sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head);
    inspector.disconnect();
  }
  if (iteration >= 0) {
    samples.push({ phase, wallMs, cpuMs: (used.user + used.system) / 1000, bytes });
  }
  return result;
}
try {
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  await replaceTranscriptEvents(target, events);
  for (let iteration = -1; iteration < operations; iteration++) {
    await waitForSessionTranscriptProjection(target);
    const manager = await SessionManager.openAsync(target, directory, { compaction: true });
    const before = await measure("initial-context", iteration, () =>
      manager[sessionManagerReadInitialContext](),
    );
    const branch = manager[sessionManagerReadTranscriptBranch]();
    const entry = branch.at(-2);
    assert(entry?.type === "message" && entry.message.role === "toolResult");
    const replacement = {
      ...entry.message,
      content: [{ type: "text" as const, text: `compacted result ${iteration}` }],
    };
    const outcome = await measure("rewrite", iteration, () =>
      rewrite({
        sessionManager: manager,
        replacements: [{ entryId: entry.id, message: replacement }],
      }),
    );
    assert(outcome.changed);
    const after = await manager[sessionManagerReadInitialContext]();
    const expected = before.messages.slice();
    for (const [index, message] of expected.entries()) {
      if (message.role === "toolResult" && message.toolCallId === replacement.toolCallId) {
        expected[index] = { ...message, content: replacement.content };
      }
    }
    assert.equal(JSON.stringify(after.messages), JSON.stringify(expected));
    if (iteration >= 0) {
      digests.push(hash("sha256", JSON.stringify(after)));
    }
  }
  writeFileSync(
    values.output,
    JSON.stringify(
      {
        node: process.version,
        operations,
        messages: 1700,
        fixtureBytes,
        ownerHash: hash("sha256", readFileSync(values["owner-file"] ?? ownerUrl)),
        samples,
        digests,
        hostBefore,
        hostAfter: loadavg(),
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await cleanupSessionStateForTest({ stateDir: directory });
  rmSync(directory, { recursive: true, force: true });
}
