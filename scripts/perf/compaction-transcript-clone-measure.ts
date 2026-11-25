/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/compaction-transcript-clone-measure.ts
 *   --scratch /isolated/proof --output /isolated/result.json [--owner-file /isolated/base.ts]
 * Run five counterbalanced A/A and A/B pairs, allocation separately. Acceptance:
 * identical context/rewrite bytes, lower rewrite CPU/allocation, no >20% p95 regression.
 * Measures initial-context publication and a two-entry rewrite of hydrated 1,700-message
 * history. SQL setup/hydration is outside timing; rewrite commit is included.
 * --endpoint measures the real endpoint owner with a synthetic transport response;
 * --owner-file then replaces server-endpoint-compaction.ts. Prepare/commit CPU is
 * also reported; allocation samples cover the entire endpoint operation. Generated
 * IDs and ISO timestamps are fixed so persistedDigests compare raw stored event bytes.
 * --initial-context measures publication alone and replaces immutable-data.ts with
 * --owner-file. Require lower initial CPU/allocation and no >20% pooled p95 regression.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import { claimResponsesCompactRequest } from "../../packages/ai/src/transports/openai-responses-compact-request.js";
import { buildOpenAIResponsesReasoningReplayMetadata } from "../../packages/ai/src/transports/openai-responses-compaction-replay.js";
import { createAssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream.js";
import { sessionManagerReadTranscriptBranch } from "../../src/agents/sessions/session-manager-view-types.js";
import { makeAgentAssistantMessage } from "../../src/agents/test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../../src/agents/test-helpers/provider-model-fixture.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";

const { values } = parseArgs({
  options: {
    scratch: { type: "string" },
    output: { type: "string" },
    "owner-file": { type: "string" },
    endpoint: { type: "boolean", default: false },
    "initial-context": { type: "boolean", default: false },
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
  values.endpoint
    ? "../../src/agents/embedded-agent-runner/server-endpoint-compaction.ts"
    : values["initial-context"]
      ? "../../src/shared/immutable-data.ts"
      : "../../src/agents/embedded-agent-runner/transcript-rewrite.ts",
  import.meta.url,
);
const replaced = registerPerfOwnerReplacement(ownerUrl.href, values["owner-file"]);
// Deterministic fixture IDs and event timestamps permit raw persisted-byte comparisons.
const idUrl = new URL("../../src/agents/sessions/session-manager-id.ts", import.meta.url).href;
let fixedIdsLoaded = false;
const idFixture = registerHooks({
  load(url, context, nextLoad) {
    if (url === idUrl) {
      fixedIdsLoaded = true;
      return {
        format: "module",
        source: `let id = 0; export const generateSessionEntryId = () => "rewrite-" + ++id;
export const createManagedSessionId = generateSessionEntryId;`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
const isoClock = mock.method(Date.prototype, "toISOString", () => "2026-01-01T00:00:00.000Z");
const { rewriteTranscriptEntriesInSessionManager: rewrite } =
  await import("../../src/agents/embedded-agent-runner/transcript-rewrite.js");
const { attemptServerEndpointCompaction } =
  await import("../../src/agents/embedded-agent-runner/server-endpoint-compaction.js");
const { SessionManager } = await import("../../src/agents/sessions/session-manager.js");
const sessionContext = await import("../../src/agents/sessions/session-manager-current-turn.js");
const { upsertSessionEntryCore, loadTranscriptEvents } =
  await import("../../src/config/sessions/session-accessor.js");
const { replaceTranscriptEvents } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-write.test-support.js");
const { cleanupSessionStateForTest } =
  await import("../../src/test-utils/session-state-cleanup.js");
const { waitForSessionTranscriptProjection } =
  await import("../../src/config/sessions/session-transcript-reconcile.js");
assert(!values["owner-file"] || replaced(), "Baseline owner not loaded");
assert(fixedIdsLoaded, "Deterministic ID fixture not loaded");
const target = {
  agentId: "main",
  sessionId: "synthetic",
  sessionKey: "agent:main:synthetic",
  storePath: path.join(directory, "sessions.json"),
};
const timestamp = "2026-01-01T00:00:00.000Z";
const events = [
  { type: "session", version: 4, id: "synthetic", cwd: "/synthetic", timestamp },
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
const persistedDigests: string[] = [];
const model = makeProviderModelFixture({
  id: "synthetic",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 100_000_000,
});
const inspector = new Session();
const hostBefore = loadavg();
async function measure<T>(
  phase: string,
  iteration: number,
  operation: () => T | Promise<T>,
  nested = false,
): Promise<T> {
  if (!nested) {
    await setImmediate();
    globalThis.gc!();
  }
  if (values.allocation && iteration >= 0 && !nested) {
    await startCollectedHeapSampling(inspector, 32768);
  }
  const startCpu = process.threadCpuUsage();
  const start = performance.now();
  const result = await operation();
  const wallMs = performance.now() - start;
  const used = process.threadCpuUsage(startCpu);
  let bytes: number | undefined;
  if (values.allocation && iteration >= 0 && !nested) {
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
    const prepare = manager.prepareTranscriptRewriteAsync.bind(manager);
    manager.prepareTranscriptRewriteAsync = async () => {
      const prepared = await measure("prepare", iteration, prepare, true);
      return {
        sessionManager: prepared.sessionManager,
        commit: (ids) => measure("commit", iteration, () => prepared.commit(ids), true),
      };
    };
    const before = await measure("initial-context", iteration, () =>
      manager[sessionContext.sessionManagerReadInitialContext](),
    );
    if (values["initial-context"]) {
      const expected = events.flatMap((entry) => {
        if (!("message" in entry)) {
          return [];
        }
        const { details: _details, ...message } = entry.message;
        return [message];
      });
      assert.equal(JSON.stringify(before.messages), JSON.stringify(expected));
      if (iteration >= 0) {
        digests.push(hash("sha256", JSON.stringify(before)));
      }
      continue;
    }
    const branch = manager[sessionManagerReadTranscriptBranch]();
    const entry = branch.at(-2);
    assert(entry?.type === "message" && entry.message.role === "toolResult");
    const replacement = {
      ...entry.message,
      content: [{ type: "text" as const, text: `compacted result ${iteration}` }],
    };
    const outcome = await measure(
      values.endpoint ? "endpoint-rewrite" : "rewrite",
      iteration,
      async () =>
        values.endpoint
          ? attemptServerEndpointCompaction({
              trigger: "manual",
              model,
              context: { systemPrompt: "synthetic", messages: before.messages },
              sessionManager: manager,
              extraParams: {},
              requestOptions: { sessionId: "synthetic" },
              streamFn: (_model, _context, options) => {
                const request = claimResponsesCompactRequest(options);
                assert(request);
                const item = {
                  type: "compaction" as const,
                  id: `cmp-${iteration}`,
                  encrypted_content: `synthetic-${iteration}`,
                };
                request.resolve({
                  item,
                  output: [item],
                  historyMode: "compacted-prefix",
                  usage: { input_tokens: 1000, output_tokens: 10 },
                  model,
                  replayMetadata: buildOpenAIResponsesReasoningReplayMetadata(model, {
                    sessionId: "synthetic",
                  }),
                });
                const stream = createAssistantMessageEventStream();
                void setImmediate().then(() =>
                  stream.end(
                    makeAgentAssistantMessage({ content: [{ type: "text", text: "remembered" }] }),
                  ),
                );
                return stream;
              },
            })
          : rewrite({
              sessionManager: manager,
              replacements: [{ entryId: entry.id, message: replacement }],
            }),
    );
    assert(outcome && outcome !== "context-overflow");
    if ("changed" in outcome) {
      assert(outcome.changed);
    }
    const after = await manager[sessionContext.sessionManagerReadInitialContext]();
    const expected = before.messages.slice();
    for (const [index, message] of expected.entries()) {
      if (message.role === "toolResult" && message.toolCallId === replacement.toolCallId) {
        expected[index] = { ...message, content: replacement.content };
      }
    }
    if (!values.endpoint) {
      assert.equal(JSON.stringify(after.messages), JSON.stringify(expected));
    }
    const persisted = await loadTranscriptEvents(target);
    await waitForSessionTranscriptProjection(target);
    const reopened = await SessionManager.openAsync(target, directory, { compaction: true });
    assert.equal(
      JSON.stringify(await reopened[sessionContext.sessionManagerReadInitialContext]()),
      JSON.stringify(after),
    );
    if (iteration >= 0) {
      digests.push(hash("sha256", JSON.stringify(after)));
      persistedDigests.push(hash("sha256", JSON.stringify(persisted)));
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
        persistedDigests,
        hostBefore,
        hostAfter: loadavg(),
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  isoClock.mock.restore();
  idFixture.deregister();
  await cleanupSessionStateForTest({ stateDir: directory });
  rmSync(directory, { recursive: true, force: true });
}
