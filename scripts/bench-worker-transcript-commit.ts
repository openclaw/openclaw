// Run with pnpm test:gateway:worker-commit.
// Measures the real committer owner with synthetic admission, not worker transport or UI delivery.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Session as InspectorSession } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import type {
  WorkerTranscriptCommitParams,
  WorkerTranscriptMessage,
} from "../packages/gateway-protocol/src/schema/worker-admission.js";
import { SessionManager } from "../src/agents/sessions/session-manager.js";
import { createZeroUsageFixture } from "../src/agents/test-helpers/usage-fixtures.js";
import {
  listSessionEntryKeysReadOnly,
  loadSessionEntry,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../src/config/sessions/session-accessor.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "../src/config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type { WorkerConnectionIdentity } from "../src/gateway/worker-environments/connection-identity.js";
import { createWorkerTranscriptCommitStore } from "../src/gateway/worker-environments/transcript-commit-store.js";
import { createWorkerTranscriptCommitter } from "../src/gateway/worker-environments/transcript-commit.js";
import { onSessionTranscriptUpdate } from "../src/sessions/transcript-events.js";
import { openOpenClawStateDatabase } from "../src/state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../src/test-utils/openclaw-test-state.js";

const { values } = parseArgs({
  options: {
    "active-events": { type: "string", default: "1000" },
    "abandoned-events": { type: "string", default: "0" },
    "session-count": { type: "string", default: "1" },
    "message-chars": { type: "string", default: "1024" },
    commits: { type: "string", default: "12" },
    runs: { type: "string", default: "3" },
    output: { type: "string" },
    "cpu-profile": { type: "string" },
  },
});

function integer(value: string, name: string, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}

const fixture = {
  activeEvents: integer(values["active-events"], "active-events", 2, 10_000),
  abandonedEvents: integer(values["abandoned-events"], "abandoned-events", 0, 10_000),
  sessionCount: integer(values["session-count"], "session-count", 1, 1000),
  messageChars: integer(values["message-chars"], "message-chars", 64, 4096),
  commits: integer(values.commits, "commits", 1, 100),
};
const runs = integer(values.runs, "runs", 1, 10);
if (values["cpu-profile"] && runs !== 1) {
  throw new Error(
    "cpu-profile requires runs=1; keep diagnostic profiles separate from timing runs",
  );
}
const sessionId = "worker-commit-benchmark";
const sessionKey = `agent:main:${sessionId}`;
const runEpoch = 7;
const skillsPrompt = "Benchmark skill instructions. ".repeat(600).slice(0, 16 * 1024);
const identity: WorkerConnectionIdentity = {
  environmentId: "benchmark-environment",
  credentialHash: "benchmark-credential-hash",
  bundleHash: "b".repeat(64),
  sessionId,
  runId: "benchmark-run",
  turnClaim: {
    sessionId,
    claimId: "benchmark-claim",
    runId: "benchmark-run",
    placementGeneration: 4,
    owner: { kind: "worker", environmentId: "benchmark-environment", ownerEpoch: runEpoch },
  },
  ownerEpoch: runEpoch,
  rpcSetVersion: 1,
  protocolFeatures: ["worker-transcript-commit-v1"],
  credentialExpiresAtMs: 10_000,
};

function messages(seq: number): WorkerTranscriptMessage[] {
  const toolCallId = `benchmark-read-${seq}`;
  const assistant = {
    role: "assistant" as const,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-4.1",
    usage: createZeroUsageFixture(),
    timestamp: seq * 10 + 1,
  };
  return [
    {
      role: "user",
      content: [{ type: "text", text: `Inspect item ${seq}.` }],
      timestamp: seq * 10,
    },
    {
      ...assistant,
      content: [
        { type: "toolCall", id: toolCallId, name: "read", arguments: { path: "README.md" } },
      ],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId,
      toolName: "read",
      content: [{ type: "text", text: "x".repeat(fixture.messageChars) }],
      isError: false,
      timestamp: seq * 10 + 2,
    },
    {
      ...assistant,
      content: [{ type: "text", text: `Item ${seq} inspected.` }],
      stopReason: "stop",
      timestamp: seq * 10 + 3,
    },
  ];
}

function percentile(samples: number[], fraction: number): number {
  const sorted = samples.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

async function seedFixture(state: OpenClawTestState, shape: typeof fixture) {
  const storePath = path.join(state.sessionsDir("main"), "sessions.json");
  const config: OpenClawConfig = {
    agents: { list: [{ id: "main", default: true }] },
    session: {
      mainKey: "main",
      store: path.join(state.stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
    },
  };
  for (let index = 0; index < shape.sessionCount; index += 1) {
    await upsertSessionEntryCore(
      {
        agentId: "main",
        sessionKey: index === 0 ? sessionKey : `agent:main:unrelated-${index}`,
        storePath,
      },
      {
        sessionId: index === 0 ? sessionId : `unrelated-${index}`,
        lifecycleRevision: "benchmark-revision",
        updatedAt: 1,
        skillsSnapshot: { prompt: skillsPrompt, skills: [] },
      },
    );
  }
  const target = { agentId: "main", sessionId, sessionKey, storePath };
  const content = "x".repeat(shape.messageChars);
  const seed = Array.from(
    { length: shape.activeEvents - 1 + shape.abandonedEvents },
    (_, index) => ({
      eventId: `seed-${index}`,
      parentId: index === 0 ? null : `seed-${index - 1}`,
      message: { role: index % 2 === 0 ? "user" : "assistant", content },
    }),
  );
  await persistSessionTranscriptTurn(target, { messages: seed, touchSessionEntry: false });
  // branch() is an in-memory cursor move. Appending an anchor persists the selected branch.
  const seeded = SessionManager.open(target);
  seeded.branch(`seed-${shape.activeEvents - 2}`);
  const baseLeafId = seeded.appendMessage({
    role: "user",
    content: "Benchmark anchor",
    timestamp: 1,
  });
  await waitForSessionTranscriptIndexReconcilesInStateDir(state.stateDir);
  const verifiedSeed = SessionManager.open(target);
  assert.equal(verifiedSeed.getLeafId(), baseLeafId);
  assert.equal(
    verifiedSeed.getBranch().filter((entry) => entry.type === "message").length,
    shape.activeEvents,
  );
  assert.equal(
    verifiedSeed.getEntries().filter((entry) => entry.type === "message").length,
    shape.activeEvents + shape.abandonedEvents,
  );
  const initialDagEvents = verifiedSeed.getEntries().length;
  const sessionRows = (await listSessionEntryKeysReadOnly({ agentId: "main", storePath })).length;
  assert.equal(sessionRows, shape.sessionCount);
  const seedSha256 = createHash("sha256").update(JSON.stringify(seed)).digest("hex");
  return { target, config, baseLeafId, initialDagEvents, sessionRows, seedSha256 };
}

async function runSample(shape: typeof fixture, profilePath?: string) {
  const sampleStart = performance.now();
  const result = await withOpenClawTestState(
    { label: "worker-commit-benchmark" },
    async (state) => {
      const { target, config, baseLeafId, initialDagEvents, sessionRows, seedSha256 } =
        await seedFixture(state, shape);
      const committer = createWorkerTranscriptCommitter({
        getConfig: () => config,
        store: createWorkerTranscriptCommitStore({ database: openOpenClawStateDatabase() }),
      });
      const updates: Array<{ messageId: string | undefined; messageSeq: number | undefined }> = [];
      const unsubscribe = onSessionTranscriptUpdate((update) => {
        if (update.target.sessionId === sessionId) {
          updates.push({ messageId: update.messageId, messageSeq: update.messageSeq });
        }
      });
      const batches = Array.from({ length: shape.commits }, (_, index) => messages(index + 1));
      const inspector = profilePath ? new InspectorSession() : undefined;
      const loopDelay = monitorEventLoopDelay({ resolution: 1 });
      try {
        inspector?.connect();
        if (inspector) {
          await inspector.post("Profiler.enable");
          await inspector.post("Profiler.start");
        }
        loopDelay.enable();
        await delay(5);
        loopDelay.reset();
        const memoryBefore = process.memoryUsage();
        const cpuBefore = process.cpuUsage();
        const loopBefore = performance.eventLoopUtilization();
        const started = performance.now();
        const durationsMs: number[] = [];
        const entryIds: string[] = [];
        let leaf = baseLeafId;
        let lastRequest: WorkerTranscriptCommitParams | undefined;
        let lastOutcome: Awaited<ReturnType<typeof committer.commit>> | undefined;
        for (let index = 0; index < batches.length; index += 1) {
          const request = { runEpoch, seq: index + 1, baseLeafId: leaf, messages: batches[index]! };
          const start = performance.now();
          const outcome = await committer.commit({
            identity,
            request,
            sessionTarget: target,
            assertCurrent: () => undefined,
          });
          durationsMs.push(performance.now() - start);
          assert.equal(
            outcome.ok,
            true,
            `commit ${index + 1} rejected: ${JSON.stringify(outcome)}`,
          );
          if (!outcome.ok) {
            throw new Error("unreachable rejected commit");
          }
          assert.equal(outcome.result.entryIds.length, 4);
          assert.equal(outcome.result.newLeafId, outcome.result.entryIds.at(-1));
          entryIds.push(...outcome.result.entryIds);
          leaf = outcome.result.newLeafId;
          lastRequest = request;
          lastOutcome = outcome;
        }
        const elapsedMs = performance.now() - started;
        const cpu = process.cpuUsage(cpuBefore);
        const loopUtilization = performance.eventLoopUtilization(loopBefore);
        const memoryAfter = process.memoryUsage();
        await delay(5);
        loopDelay.disable();
        if (inspector && profilePath) {
          const { profile } = await inspector.post("Profiler.stop");
          await fs.writeFile(profilePath, JSON.stringify(profile));
        }
        assert.equal(new Set(entryIds).size, shape.commits * 4);
        assert.deepEqual(
          updates,
          entryIds.map((messageId, index) => ({
            messageId,
            messageSeq: shape.activeEvents + index + 1,
          })),
        );
        const publicationCount = updates.length;
        assert.ok(lastRequest);
        assert.deepEqual(
          await committer.commit({
            identity,
            request: lastRequest,
            sessionTarget: target,
            assertCurrent: () => undefined,
          }),
          lastOutcome,
        );
        assert.equal(updates.length, publicationCount, "ledger replay must not publish again");
        const final = SessionManager.open(target);
        assert.equal(final.getLeafId(), leaf);
        assert.equal(loadSessionEntry(target)?.skillsSnapshot?.prompt, skillsPrompt);
        assert.deepEqual(
          final
            .getBranch()
            .slice(-entryIds.length)
            .map((entry) => entry.id),
          entryIds,
        );
        assert.equal(
          final.getBranch().filter((entry) => entry.type === "message").length,
          shape.activeEvents + entryIds.length,
        );
        assert.equal(
          final.getEntries().filter((entry) => entry.type === "message").length,
          shape.activeEvents + shape.abandonedEvents + entryIds.length,
        );
        const drainStart = performance.now();
        await waitForSessionTranscriptIndexReconcilesInStateDir(state.stateDir);
        const reconcileDrainMs = performance.now() - drainStart;
        return {
          requestedCommits: shape.commits,
          completedCommits: durationsMs.length,
          appendedMessages: entryIds.length,
          emittedUpdates: publicationCount,
          initialDagEvents,
          sessionRows,
          seedSha256,
          batchSha256: createHash("sha256").update(JSON.stringify(batches)).digest("hex"),
          elapsedMs,
          commitsPerSecond: shape.commits / (elapsedMs / 1000),
          commitMs: {
            samples: durationsMs,
            p50: percentile(durationsMs, 0.5),
            p95: percentile(durationsMs, 0.95),
            p99: percentile(durationsMs, 0.99),
          },
          processCpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 },
          eventLoop: {
            utilization: loopUtilization.utilization,
            delayP99Ms: loopDelay.percentile(99) / 1e6,
            delayMaxMs: loopDelay.max / 1e6,
            samples: loopDelay.count,
          },
          memory: {
            before: memoryBefore,
            after: memoryAfter,
            processLifetimePeakRssBytes: process.resourceUsage().maxRSS * 1024,
          },
          reconcileDrainMs,
        };
      } finally {
        loopDelay.disable();
        inspector?.disconnect();
        unsubscribe();
      }
    },
  );
  return { ...result, fixtureAndCleanupMs: performance.now() - sampleStart - result.elapsedMs };
}

async function main(): Promise<void> {
  // Load the lazy committer runtime through its real entrypoint, using a separate state and ledger.
  await runSample({ ...fixture, activeEvents: 2, abandonedEvents: 0, sessionCount: 1, commits: 1 });
  const samples = [];
  for (let run = 0; run < runs; run += 1) {
    samples.push(await runSample(fixture, values["cpu-profile"]));
  }
  const output = {
    scope:
      "committer owner; synthetic admission; synchronous event emission, no worker transport or UI delivery",
    warmup: "one real commit on separate state before fresh-state samples",
    fixtureIdentity:
      "deterministic seed and request hashes; runtime-generated entry IDs and timestamps vary",
    fixture,
    sessionSkillsPromptBytes: Buffer.byteLength(skillsPrompt),
    runtime: {
      node: process.version,
      versions: process.versions,
      availableParallelism: os.availableParallelism(),
      logicalCpus: os.cpus().length,
    },
    profiled: Boolean(values["cpu-profile"]),
    samples,
  };
  const json = `${JSON.stringify(output, null, 2)}\n`;
  if (values.output) {
    await fs.writeFile(values.output, json);
  }
  process.stdout.write(json);
}

await main().catch((error: unknown) => {
  console.error(error);
  console.error("[bench-worker-transcript-commit] FAILED (exit 1)");
  process.exitCode = 1;
});
