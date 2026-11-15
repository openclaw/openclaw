/**
 * Actual runMemoryFlushIfNeeded with real accounting workers; no model call.
 * Reuse a synthetic usage-refresh-stats-measure fixture, then --prepare once.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/completed-memory-flush-measure.ts
 *   --state-dir <synthetic fixture> --prepare --events 45000
 * Repeat without --prepare; --revision pins only agent-runner-memory.ts AND its
 * memory-flush.ts policy dependency. --mode timing|allocation --samples 5.
 * Alternate baseline/candidate processes, with five A/A controls. Allocation
 * samples MAIN isolate; use gateway-bench-heap-profile.mjs separately for workers.
 * Acceptance: identical skipped result, zero candidate accounting requests,
 * lower CPU/allocation/wall beyond A/A spread; report every >20% regression.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createCipheriv, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { FollowupRun } from "../../src/auto-reply/reply/queue.js";
import type { TranscriptEvent } from "../../src/config/sessions/session-accessor.sqlite-contract.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    prepare: { type: "boolean" },
    events: { type: "string", default: "45000" },
    samples: { type: "string", default: "5" },
    iterations: { type: "string", default: "1" },
    revision: { type: "string" },
    mode: { type: "string", default: "timing" },
    label: { type: "string", default: "candidate" },
    "worker-profiles": { type: "string" },
  },
});
assert(values["state-dir"]);
assert(["timing", "allocation"].includes(values.mode));
assert(global.gc, "--expose-gc is required");
const positive = (value: string) => {
  const n = Number(value);
  assert(Number.isSafeInteger(n) && n > 0);
  return n;
};
const root = path.resolve(values["state-dir"]);
const manifest = JSON.parse(
  readFileSync(path.join(root, "usage-refresh-stats-fixture.json"), "utf8"),
);
assert.equal(manifest.format, "openclaw-usage-refresh-stats-v1");
const fixturePath = path.join(root, "completed-memory-flush-fixture.json");
const workspaceDir = path.join(root, "flush-workspace");
const configPath = path.join(root, "flush-config.json");
const databasePath = path.join(root, "agents/main/agent/openclaw-agent.sqlite");
const cfg: OpenClawConfig = {
  agents: { defaults: { workspace: workspaceDir, compaction: { memoryFlush: {} } } },
  session: { maintenance: { mode: "warn" } },
};
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_CONFIG_PATH = configPath;
process.env.OPENCLAW_HOME = path.join(root, "home");
process.env.TMPDIR = path.join(root, "flush-tmp");
mkdirSync(process.env.TMPDIR, { recursive: true });
mkdirSync(workspaceDir, { recursive: true });
writeFileSync(configPath, JSON.stringify(cfg));
const sources = new Map<string, string>();
for (const owner of ["agent-runner-memory.ts", "memory-flush.ts"]) {
  const ownerPath = `src/auto-reply/reply/${owner}`;
  const source = values.revision
    ? (() => {
        const r = spawnSync("git", ["show", `${values.revision}:${ownerPath}`], {
          encoding: "utf8",
        });
        assert.equal(r.status, 0, r.stderr);
        return r.stdout;
      })()
    : readFileSync(ownerPath, "utf8");
  sources.set(pathToFileURL(path.resolve(ownerPath)).href, source);
}
if (values.revision) {
  registerHooks({
    load(url, context, nextLoad) {
      const source = sources.get(url);
      return source === undefined
        ? nextLoad(url, context)
        : { source, format: "module-typescript", shortCircuit: true };
    },
  });
}
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
setRuntimeConfigSnapshot(cfg);
const { importSqliteSessionRowsBatch } =
  await import("../../src/config/sessions/session-accessor.sqlite-import.js");
const { loadSessionEntry } = await import("../../src/config/sessions/session-accessor.js");
const { SESSION_TOTAL_TOKENS_VERSION } = await import("../../src/config/sessions/types.js");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const { createEmptyPluginRegistry } = await import("../../src/plugins/registry-empty.js");
const { setActivePluginRegistry } = await import("../../src/plugins/runtime.js");
const { registerMemoryCapability } = await import("../../src/plugins/memory-state.js");
const { setDiagnosticsEnabledForProcess } = await import("../../src/infra/diagnostic-events.js");
const { onWorkerRequestMetrics } = await import("../../src/infra/worker-request-diagnostics.js");
const { runMemoryFlushIfNeeded } =
  await import("../../src/auto-reply/reply/agent-runner-memory.js");
const target = {
  agentId: "main",
  sessionId: "synthetic-completed-memory-flush",
  sessionKey: "agent:main:synthetic-completed-memory-flush",
  storePath: databasePath,
};
try {
  if (values.prepare) {
    assert(!existsSync(fixturePath) && !loadSessionEntry(target), "Refusing to replace fixture");
    const count = positive(values.events),
      now = Date.now(),
      timestamp = new Date(now).toISOString();
    const cipher = createCipheriv(
      "aes-256-ctr",
      createHash("sha256").update("completed-flush-synthetic-v1").digest(),
      Buffer.alloc(16),
    );
    let utf8Bytes = 0;
    await importSqliteSessionRowsBatch([
      {
        ...target,
        entry: {
          sessionId: target.sessionId,
          updatedAt: now,
          lifecycleRevision: "synthetic",
          compactionCount: 0,
          memoryFlush: { kind: "succeeded", compactionCount: 0 },
          totalTokens: 100,
          totalTokensFresh: true,
          totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        },
        transcriptMtimeMs: now,
        readTranscriptEvents(append: (event: TranscriptEvent) => void) {
          append({ type: "session", version: 3, id: target.sessionId, timestamp });
          for (let index = 0; index < count; index++) {
            const event: TranscriptEvent = {
              type: "message",
              id: `flush-${index}`,
              parentId: index ? `flush-${index - 1}` : null,
              timestamp,
              message: {
                role: index % 2 ? "assistant" : "user",
                content: cipher.update(Buffer.alloc(12_288)).toString("base64"),
                ...(index % 2 ? { usage: { input: 100, output: 20 } } : {}),
              },
            };
            utf8Bytes += Buffer.byteLength(JSON.stringify(event)) + 1;
            append(event);
          }
        },
      },
    ]);
    cipher.final();
    await closeOpenClawAgentDatabasesAsync();
    writeFileSync(
      fixturePath,
      JSON.stringify({
        format: "completed-memory-flush-v1",
        events: count,
        utf8Bytes,
        backgroundSessions: manifest.sessions,
        databaseBytes: statSync(databasePath).size,
      }) + "\n",
      { flag: "wx" },
    );
    console.log(readFileSync(fixturePath, "utf8"));
  } else {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    assert.equal(fixture.format, "completed-memory-flush-v1");
    const sessionEntry = loadSessionEntry(target);
    assert.equal(sessionEntry?.memoryFlush?.compactionCount, sessionEntry?.compactionCount);
    assert(sessionEntry);
    setActivePluginRegistry(createEmptyPluginRegistry());
    registerMemoryCapability("memory-core", {
      flushPlanResolver: () => ({
        prompt: "Synthetic flush",
        systemPrompt: "Synthetic flush",
        relativePath: "memory/synthetic.md",
        forceFlushTranscriptBytes: 2 * 1024 * 1024,
        softThresholdTokens: 4000,
        reserveTokensFloor: 20000,
      }),
    });
    setDiagnosticsEnabledForProcess(true);
    const followupRun: FollowupRun = {
      prompt: "synthetic",
      enqueuedAt: 1,
      run: {
        ...target,
        config: cfg,
        agentDir: path.dirname(databasePath),
        workspaceDir,
        sessionFile: target.sessionKey,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        senderIsOwner: true,
        skillsSnapshot: { prompt: "", skills: [] },
        thinkLevel: "off",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
        timeoutMs: 30000,
        blockReplyBreak: "message_end",
      },
    };
    const requests: string[] = [];
    const stop = onWorkerRequestMetrics((kind, request, phase) => {
      if (phase === "started") {
        requests.push(`${kind}:${request}`);
      }
    });
    const run = async () => {
      const result = await runMemoryFlushIfNeeded({
        cfg,
        followupRun,
        sessionEntry,
        sessionKey: target.sessionKey,
        storePath: databasePath,
        defaultModel: "anthropic/claude-sonnet-4-6",
        resolvedVerboseLevel: "off",
      });
      assert.equal(result.outcome, "skipped");
      assert.equal(result.sessionEntry, sessionEntry);
    };
    const persistedBefore = JSON.stringify(loadSessionEntry(target));
    const workerBytes = () => {
      const directory = values["worker-profiles"];
      if (!directory) {
        return undefined;
      }
      return readdirSync(directory)
        .filter((file) => file.endsWith(".heapprofile"))
        .reduce((total, file) => {
          const capture = JSON.parse(readFileSync(path.join(directory, file), "utf8"));
          return total + sumSampledHeapBytes(capture.profile.head);
        }, 0);
    };
    const summaries = [];
    for (let sample = -1; sample < positive(values.samples); sample++) {
      if (values["worker-profiles"] && sample >= 0) {
        await delay(1200);
      }
      const workerBefore = sample >= 0 ? workerBytes() : undefined;
      global.gc();
      requests.length = 0;
      const inspector = values.mode === "allocation" && sample >= 0 ? new Session() : undefined;
      if (inspector) {
        await startCollectedHeapSampling(inspector, 4096);
      }
      const cpu = process.cpuUsage(),
        mainCpu = process.threadCpuUsage(),
        start = performance.now();
      const iterations = sample < 0 ? 1 : positive(values.iterations);
      for (let index = 0; index < iterations; index++) {
        await run();
      }
      const wallMs = performance.now() - start,
        used = process.cpuUsage(cpu),
        usedMain = process.threadCpuUsage(mainCpu);
      let allocatedBytes: number | undefined;
      if (inspector) {
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        allocatedBytes = sumSampledHeapBytes(profile.head) / iterations;
        inspector.disconnect();
      }
      if (values["worker-profiles"] && sample >= 0) {
        await delay(1200);
      }
      const workerAfter = sample >= 0 ? workerBytes() : undefined;
      summaries.push({
        phase: sample < 0 ? "cold" : "warm",
        sample,
        wallMs: wallMs / iterations,
        cpuMs: (used.user + used.system) / 1000 / iterations,
        mainCpuMs: (usedMain.user + usedMain.system) / 1000 / iterations,
        mainAllocatedBytes: allocatedBytes,
        workerAllocatedBytes:
          workerBefore !== undefined && workerAfter !== undefined
            ? (workerAfter - workerBefore) / iterations
            : undefined,
        requests: [...requests],
        iterations,
        hostLoad: loadavg(),
      });
    }
    stop();
    assert.equal(JSON.stringify(loadSessionEntry(target)), persistedBefore);
    console.log(
      JSON.stringify({
        label: values.label,
        mode: values.mode,
        revision: values.revision ?? "working-tree",
        sources: Object.fromEntries(
          [...sources].map(([url, source]) => [
            url,
            createHash("sha256").update(source).digest("hex"),
          ]),
        ),
        fixture,
        databaseBytes: statSync(databasePath).size,
        node: process.version,
        entryDigest: createHash("sha256").update(persistedBefore).digest("hex"),
        summaries,
      }),
    );
    if (values.mode === "allocation") {
      await delay(1200);
    }
  }
} finally {
  setActivePluginRegistry(createEmptyPluginRegistry());
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await drainGlobalSingletonLifecycleState();
}
