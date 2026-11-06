/**
 * Real flush preparation on synthetic SQLite sessions and a populated workspace.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/memory-flush-admission-measure.ts \
 *   --baseline-file /absolute/path/base-memory-flush-prepare.ts --fixture-root /new/synthetic
 * Set TMPDIR to an isolated scratch directory before launch. Baseline and candidate
 * share dependencies; only the preparation owner changes. Timing and sampled main
 * isolate allocation use separate passes. --archived-mib 35840 seeds 35 GiB of
 * real archived transcript text. This does not run inference or reproduce a
 * production Gateway's full lane duration; report actual database bytes separately.
 * --seed-only prepares and closes a retained fixture; --reuse-fixture measures it
 * without regenerating data. Fixture owners close before exit; remove the root
 * after all source comparisons finish.
 * --prepared-team-fixture finalizes a synthetic state/ directory completed by
 * session-resource-loader-fixture.mjs --complete-gib, reusing that archive owner.
 * Acceptance: denied candidates prepare zero runs; lower preparation CPU/allocation
 * and wall time, with A/A controls and five alternating A/B samples.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { FollowupRun } from "../../src/auto-reply/reply/queue.js";
import type { SessionEntry } from "../../src/config/sessions/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "baseline-file": { type: "string" },
    "candidate-file": { type: "string" },
    "fixture-root": { type: "string" },
    "reuse-fixture": { type: "boolean" },
    "seed-only": { type: "boolean" },
    "prepared-team-fixture": { type: "boolean" },
    sessions: { type: "string", default: "5000" },
    files: { type: "string", default: "62000" },
    "file-bytes": { type: "string", default: "17742" },
    "archived-mib": { type: "string", default: "0" },
    iterations: { type: "string", default: "5" },
    samples: { type: "string", default: "5" },
  },
});
assert(values["baseline-file"], "--baseline-file is required");
assert(
  values["fixture-root"] && path.isAbsolute(values["fixture-root"]),
  "--fixture-root must be absolute",
);
assert(global.gc, "--expose-gc is required");
assert(process.env.TMPDIR && path.isAbsolute(process.env.TMPDIR), "Set an isolated TMPDIR");
const integer = (name: "sessions" | "files" | "file-bytes" | "iterations" | "samples") =>
  parseStrictIntegerOption({ raw: values[name], label: name, min: 1, fallback: 1 });
const sessions = integer("sessions");
const files = integer("files");
const fileBytes = integer("file-bytes");
const archivedMiB = parseStrictIntegerOption({
  raw: values["archived-mib"],
  label: "archived-mib",
  min: 0,
  fallback: 0,
});
const iterations = integer("iterations");
const samples = integer("samples");
const ownerUrl = new URL("../../src/auto-reply/reply/memory-flush-prepare.ts", import.meta.url);
const baseSource = readFileSync(values["baseline-file"], "utf8");
const candidateSource = readFileSync(values["candidate-file"] ?? ownerUrl, "utf8");
const digest = (source: string) => createHash("sha256").update(source).digest("hex");
console.log(
  JSON.stringify({
    stage: "source-captured",
    base: digest(baseSource),
    candidate: digest(candidateSource),
  }),
);
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.split("?")[0] !== ownerUrl.href) {
      return nextLoad(url, context);
    }
    return {
      format: "module",
      source: stripTypeScriptTypes(url.endsWith("?base") ? baseSource : candidateSource),
      shortCircuit: true,
    };
  },
});
type Owner = typeof import("../../src/auto-reply/reply/memory-flush-prepare.js");
const base: Owner = await import(`${ownerUrl.href}?base`);
const candidate: Owner = await import(`${ownerUrl.href}?candidate`);
hooks.deregister();
const { withOpenClawTestState } = await import("../../src/test-utils/openclaw-test-state.js");
const { cleanupSessionStateForTest } =
  await import("../../src/test-utils/session-state-cleanup.js");
const { seedTeamShapeSessions } = await import("./team-shape-sessions.ts");
const { upsertSessionEntryCore, waitForSessionTranscriptProjection } =
  await import("../../src/config/sessions/session-accessor.js");
const { SessionManager } = await import("../../src/agents/sessions/session-manager.js");
const { createEmptyPluginRegistry } = await import("../../src/plugins/registry-empty.js");
const { setActivePluginRegistry } = await import("../../src/plugins/runtime.js");

const fixtureRoot = values["fixture-root"];
const markerPath = path.join(fixtureRoot, "fixture.json");
const state = {
  stateDir: path.join(fixtureRoot, "state"),
  workspaceDir: path.join(fixtureRoot, "workspace"),
  agentDir: () => path.join(fixtureRoot, "state", "agents", "main", "agent"),
};
const preparedTeamFixture = values["prepared-team-fixture"]
  ? JSON.parse(readFileSync(path.join(state.stateDir, "team-shape-summary.json"), "utf8"))
  : undefined;
if (preparedTeamFixture) {
  assert.equal(preparedTeamFixture.format, "openclaw-team-shape-v1");
  assert.equal(preparedTeamFixture.completion.completed, true);
  assert.equal(preparedTeamFixture.sessionCount, sessions);
}
if (values["reuse-fixture"]) {
  assert.equal(JSON.parse(readFileSync(markerPath, "utf8")).format, "memory-flush-synthetic-v1");
} else {
  if (!preparedTeamFixture) {
    mkdirSync(fixtureRoot);
    mkdirSync(state.stateDir);
  }
  mkdirSync(state.workspaceDir);
}
await withOpenClawTestState(
  {
    label: "flush-admission-env",
    env: {
      OPENCLAW_STATE_DIR: state.stateDir,
      OPENCLAW_CONFIG_PATH: path.join(fixtureRoot, "openclaw.json"),
      OPENCLAW_AGENT_DIR: state.agentDir(),
    },
  },
  async () => {
    try {
      console.log(JSON.stringify({ stage: "seeding", stateDir: state.stateDir, archivedMiB }));
      const seeded =
        values["reuse-fixture"] || preparedTeamFixture
          ? undefined
          : await seedTeamShapeSessions({
              stateDir: state.stateDir,
              sessions,
              retainedRuns: 0,
              seed: 2038,
              now: Date.parse("2026-10-01T12:00:00Z"),
              transcriptBytes: archivedMiB * 1024 * 1024,
            });
      if (!values["reuse-fixture"]) {
        console.log(JSON.stringify({ stage: "sessions-seeded", sessions }));
        const padding = Buffer.alloc(fileBytes, 120);
        for (let index = 0; index < files; index++) {
          const directory = path.join(state.workspaceDir, `synthetic-${Math.floor(index / 1000)}`);
          if (index % 1000 === 0) {
            mkdirSync(directory);
          }
          writeFileSync(path.join(directory, `file-${index}.txt`), padding);
        }
        console.log(JSON.stringify({ stage: "workspace-seeded", files }));
      }
      const target = {
        agentId: "main",
        sessionId: "20380000-0000-4000-8000-000000000001",
        sessionKey: "agent:main:main",
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      };
      const sessionEntry: SessionEntry = {
        sessionId: target.sessionId,
        updatedAt: 1,
        lifecycleRevision: "synthetic-source",
        chatType: "direct",
        compactionCount: 1,
      };
      if (!values["reuse-fixture"]) {
        await upsertSessionEntryCore(target, sessionEntry);
        const source = await SessionManager.openAsync(target, state.workspaceDir);
        for (let index = 0; index < 512; index++) {
          await source.appendMessageAsync({
            role: "user",
            content: `Synthetic conversation record ${index}. ${"bounded context ".repeat(256)}`,
            timestamp: index + 1,
          });
        }
        await waitForSessionTranscriptProjection(target);
        assert(seeded || preparedTeamFixture);
        writeFileSync(
          markerPath,
          JSON.stringify({
            format: "memory-flush-synthetic-v1",
            sessions: sessions + 1,
            files,
            workspaceBytes: files * fileBytes,
            ...(seeded
              ? {
                  archivedTranscriptInputBytes: seeded.logicalTranscriptBytes,
                  archivedMessages: seeded.transcriptMessages,
                }
              : {
                  completedArchiveDatabaseBytes: preparedTeamFixture.agentDatabaseBytes,
                  archivedTranscriptPayloadBytes: preparedTeamFixture.transcriptPayloadBytes,
                }),
            activeMessages: 512,
          }),
        );
      }
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: state.workspaceDir } },
        tools: { deny: ["knowledge_save_page"] },
      };
      writeFileSync(path.join(fixtureRoot, "openclaw.json"), JSON.stringify(cfg));
      const followupRun: FollowupRun = {
        prompt: "",
        enqueuedAt: 1,
        run: {
          ...target,
          config: cfg,
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          sessionFile: target.sessionKey,
          provider: "synthetic",
          model: "synthetic",
          senderIsOwner: true,
          skillsSnapshot: { prompt: "", skills: [] },
          thinkLevel: "off",
          verboseLevel: "off",
          elevatedLevel: "off",
          bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
          timeoutMs: 30_000,
          blockReplyBreak: "message_end",
        },
      };
      const resolution = {
        pluginId: "knowledge",
        selectedSlotOwner: true,
        plan: {
          prompt: "Save durable synthetic context.",
          systemPrompt: "Use the selected persistence tool.",
          persistenceToolNames: ["knowledge_save_page"],
          softThresholdTokens: 4_000,
          forceFlushTranscriptBytes: 2 * 1024 * 1024,
          reserveTokensFloor: 20_000,
        },
      };
      const registry = createEmptyPluginRegistry();
      registry.memoryCapabilities.push({
        pluginId: "knowledge",
        memorySlotSelected: true,
        capability: { providerRuntime: { open: async () => ({ provider: null }) } },
      });
      setActivePluginRegistry(registry);
      console.log(
        JSON.stringify({
          fixture: {
            ...JSON.parse(readFileSync(markerPath, "utf8")),
            databaseBytes: statSync(target.storePath).size,
            databaseWalBytes: existsSync(`${target.storePath}-wal`)
              ? statSync(`${target.storePath}-wal`).size
              : 0,
          },
          sourceSha256: { base: digest(baseSource), candidate: digest(candidateSource) },
          runtime: process.version,
          platform: process.platform,
          scope: "prepareMemoryFlushAttempt only; no inference or full Gateway lane",
        }),
      );
      if (values["seed-only"]) {
        return;
      }
      let runNumber = 0;
      async function run(owner: Owner, expectedSkipped: boolean) {
        const prepared = await owner.prepareMemoryFlushAttempt({
          cfg,
          followupRun,
          sessionEntry,
          sessionKey: target.sessionKey,
          storePath: target.storePath,
          flushRunId: `synthetic-flush-${runNumber++}`,
          resolution,
          assertCurrent() {},
          recordPersistenceToolSuccess() {},
        });
        assert.equal(prepared === null, expectedSkipped);
        if (prepared) {
          prepared.preparedRunAdmission.close();
          prepared.release();
        }
      }
      await run(base, false);
      await run(candidate, true);
      async function measure(
        arm: string,
        owner: Owner,
        skipped: boolean,
        mode: string,
        sample: number,
      ) {
        global.gc?.();
        const inspector = mode === "allocation" ? new Session() : undefined;
        inspector?.connect();
        await inspector?.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
        const hostLoad = loadavg();
        const cpu = process.cpuUsage();
        const started = performance.now();
        for (let index = 0; index < iterations; index++) {
          await run(owner, skipped);
        }
        const wallMs = performance.now() - started;
        const cpuUsed = process.cpuUsage(cpu);
        const allocation = await inspector?.post("HeapProfiler.stopSampling");
        inspector?.disconnect();
        console.log(
          JSON.stringify({
            arm,
            mode,
            sample,
            iterations,
            hostLoad,
            preparedRuns: skipped ? 0 : iterations,
            ...(allocation
              ? {
                  mainIsolateSampledBytesPerOperation:
                    sumSampledHeapBytes(allocation.profile.head) / iterations,
                }
              : {
                  wallMsPerOperation: wallMs / iterations,
                  processCpuMsPerOperation: (cpuUsed.user + cpuUsed.system) / 1000 / iterations,
                }),
          }),
        );
      }
      for (const mode of ["timing", "allocation"]) {
        for (let sample = 0; sample < samples; sample++) {
          await measure("A-control-1", base, false, mode, sample);
          await measure("A-control-2", base, false, mode, sample);
        }
        for (let sample = 0; sample < samples; sample++) {
          const arms =
            sample % 2 === 0
              ? ([
                  ["base", base, false],
                  ["candidate", candidate, true],
                ] as const)
              : ([
                  ["candidate", candidate, true],
                  ["base", base, false],
                ] as const);
          for (const [arm, owner, skipped] of arms) {
            await measure(arm, owner, skipped, mode, sample);
          }
        }
      }
    } finally {
      setActivePluginRegistry(createEmptyPluginRegistry());
      await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: fixtureRoot });
    }
  },
);
