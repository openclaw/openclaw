/**
 * Measure deletion's descendant-cancellation owner with no live runs.
 * First seed real 10k sessions and 35 GiB of transcripts with agent-startup-inspection.ts.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-deletion-cancellation-measure.ts
 *   --state-dir <marked-seed> --prepare
 * Repeat without --prepare, with --baseline-owner <historical-chat-abort-descendants.ts>
 * for warm A/A controls and five counterbalanced base/candidate pairs in one process.
 * Repeat with --allocations in a separate process. --owner selects a single owner.
 * Extract the exact base beside the original so its relative imports stay valid:
 * git show <base>:src/gateway/server-methods/chat-abort-descendants.ts > \
 *   src/gateway/server-methods/chat-abort-descendants.baseline.ts
 * Then pass --baseline-owner src/gateway/server-methods/chat-abort-descendants.baseline.ts.
 * Remove that task-owned copy after measurement. --cpu-profile <file> captures a
 * diagnostic profile of only the owner loop; exclude profiled runs from timings.
 * Each launch closes ingress under a real deletion journal, invokes the actual owner
 * for every persisted synthetic subagent, then rolls back. No session data is deleted.
 * Acceptance: all idle cancellations finish, zero admission refusals; report CPU and
 * allocations without claiming full-deletion speedup. Inventory, placement drainage,
 * filesystem cleanup, startup, native allocations, and worker CPU are not measured.
 */
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    prepare: { type: "boolean" },
    owner: { type: "string" },
    "baseline-owner": { type: "string" },
    allocations: { type: "boolean" },
    "cpu-profile": { type: "string" },
    label: { type: "string", default: "sample" },
  },
});
assert(values["state-dir"] && globalThis.gc, "Supply --state-dir and --expose-gc");
assert(!values["baseline-owner"] || (!values.owner && !values["cpu-profile"]));
const root = path.resolve(values["state-dir"]);
const seed = JSON.parse(readFileSync(path.join(root, ".agent-startup-inspection.json"), "utf8"));
assert.equal(seed.marker, "openclaw-agent-startup-inspection-v1");
assert.equal(seed.seedIncomplete, false, "Complete the existing seed first");
const databasePath = path.join(root, "agents/main/agent/openclaw-agent.sqlite");
assert(statSync(databasePath).size >= 35 * 1024 ** 3, "Requires the 35-GiB fixture");
const markerPath = path.join(root, ".agent-deletion-cancellation.json");
process.env = {
  ...createGatewayBenchEnv(path.join(root, "home"), path.join(root, "openclaw.json"), {
    startupTrace: false,
  }),
  OPENCLAW_STATE_DIR: root,
  TMPDIR: path.join(root, "tmp"),
  XDG_CACHE_HOME: path.join(root, "cache"),
};
const cfg: OpenClawConfig = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const { closeOpenClawAgentDatabasesAsync, runOpenClawAgentWriteTransaction } =
  await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
setRuntimeConfigSnapshot(cfg);
try {
  if (values.prepare) {
    assert(!existsSync(markerPath), "Refusing to prepare an existing cancellation fixture");
    const workspace = path.join(root, "workspace", "deletion-shape");
    mkdirSync(workspace);
    const cipher = createCipheriv(
      "aes-256-ctr",
      createHash("sha256").update("deletion-cancellation-fixture").digest(),
      Buffer.alloc(16),
    );
    const fileBytes = 18_000;
    const files = 62_000;
    const zeros = Buffer.alloc(fileBytes);
    for (let index = 0; index < files; index++) {
      const directory = path.join(workspace, String(Math.floor(index / 1_000)));
      if (index % 1_000 === 0) {
        mkdirSync(directory);
      }
      writeFileSync(path.join(directory, `synthetic-${index}.dat`), cipher.update(zeros));
    }
    const { writeSessionEntry } =
      await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
    runOpenClawAgentWriteTransaction(
      (database) => {
        for (let index = 0; index < 349; index++) {
          writeSessionEntry(database, `agent:main:subagent:deletion-${index}`, {
            sessionId: `deletion-subagent-${index}`,
            updatedAt: 1_790_000_000_000,
            status: "done",
          });
        }
      },
      { agentId: "main", path: databasePath },
    );
    writeFileSync(markerPath, JSON.stringify({ files, workspaceBytes: files * fileBytes }));
    console.log(JSON.stringify({ phase: "prepared", files, workspaceBytes: files * fileBytes }));
  } else {
    const fixture = JSON.parse(readFileSync(markerPath, "utf8"));
    const { readSessionEntrySummariesInWorker } =
      await import("../../src/config/sessions/session-entry-read-runtime.js");
    const { withAgentDeletion } = await import("../../src/agents/agent-lifecycle-registry.js");
    const { closeAgentWorkAdmissions } =
      await import("../../src/sessions/session-controller.lifecycle.js");
    const { AgentDeletionPendingError } =
      await import("../../src/sessions/session-agent-work-admission.js");
    const loadOwner = async (ownerPath: string, name: string) => {
      const url = pathToFileURL(path.resolve(ownerPath));
      const { abortControlledSubagents } = (await import(
        url.href
      )) as typeof import("../../src/gateway/server-methods/chat-abort-descendants.js");
      return {
        name,
        abortControlledSubagents,
        hash: createHash("sha256").update(readFileSync(url)).digest("hex"),
      };
    };
    const candidate = await loadOwner(
      values.owner ?? "src/gateway/server-methods/chat-abort-descendants.ts",
      values.owner ? "selected" : "candidate",
    );
    const owners = values["baseline-owner"]
      ? [await loadOwner(values["baseline-owner"], "base"), candidate]
      : [candidate];
    const sessionsDir = path.join(root, "agents/main/sessions");
    const sessions = await readSessionEntrySummariesInWorker({
      agentId: "main",
      storePath: path.join(sessionsDir, "sessions.json"),
    });
    const targets = sessions.filter(({ sessionKey }) =>
      sessionKey.startsWith("agent:main:subagent:deletion-"),
    );
    assert.equal(targets.length, 349);
    const release = closeAgentWorkAdmissions({
      agentId: "main",
      reason: new AgentDeletionPendingError("Agent main deletion is draining active work."),
    });
    try {
      await withAgentDeletion("main", async (begin) => {
        const deletion = await begin({
          agentId: "main",
          agentDir: path.dirname(databasePath),
          workspaceDir: path.join(root, "workspace"),
          sessionsDir,
          deleteFiles: false,
          phase: "draining",
        });
        const measure = async (
          owner: Awaited<ReturnType<typeof loadOwner>>,
          label: string,
          warmup = false,
        ) => {
          const inspector = new Session();
          let completed = 0;
          let admissionRefusals = 0;
          globalThis.gc!();
          if (values.allocations && !warmup) {
            await startCollectedHeapSampling(inspector, 4096);
          }
          if (values["cpu-profile"]) {
            if (!values.allocations) {
              inspector.connect();
            }
            await inspector.post("Profiler.enable");
            await inspector.post("Profiler.start");
          }
          const cpu = process.threadCpuUsage();
          const started = performance.now();
          for (const { sessionKey, entry } of targets) {
            try {
              const result = await owner.abortControlledSubagents({
                cfg,
                sessionKey,
                sessionId: entry.sessionId,
                agentId: "main",
                assertCurrent: deletion.assertCurrentFinal,
              });
              assert.equal(result, undefined, "No live descendants exist in the fixture");
              completed++;
            } catch (error) {
              if (!(error instanceof AgentDeletionPendingError)) {
                throw error;
              }
              admissionRefusals++;
            }
          }
          const wallMs = performance.now() - started;
          const used = process.threadCpuUsage(cpu);
          const sampledAllocationBytes =
            values.allocations && !warmup
              ? sumSampledHeapBytes(
                  (await inspector.post("HeapProfiler.stopSampling")).profile.head,
                )
              : undefined;
          if (values["cpu-profile"]) {
            const { profile } = await inspector.post("Profiler.stop");
            writeFileSync(values["cpu-profile"], JSON.stringify(profile));
          }
          console.log(
            JSON.stringify({
              label: `${values.label}-${label}-${owner.name}`,
              owner: owner.name,
              warmup,
              allocation: values.allocations ?? false,
              ownerSha256: owner.hash,
              databaseBytes: statSync(databasePath).size,
              sessions: sessions.length,
              targets: targets.length,
              ...fixture,
              completed,
              admissionRefusals,
              wallMs,
              mainThreadCpuMs: (used.user + used.system) / 1000,
              sampledAllocationBytes,
              hostLoad: loadavg(),
              node: process.version,
            }),
          );
          inspector.disconnect();
          if (values["baseline-owner"]) {
            assert.equal(admissionRefusals, owner.name === "base" ? targets.length : 0);
            assert.equal(completed, owner.name === "base" ? 0 : targets.length);
          }
        };
        try {
          if (values["baseline-owner"]) {
            for (const owner of owners) {
              await measure(owner, "warmup", true);
              await measure(owner, "AA-1");
              await measure(owner, "AA-2");
            }
            for (let pair = 0; pair < 5; pair++) {
              for (const owner of pair % 2 ? owners.toReversed() : owners) {
                await measure(owner, `pair-${pair}`);
              }
            }
          } else {
            await measure(candidate, "single");
          }
        } finally {
          await deletion.rollback();
        }
      });
    } finally {
      release();
    }
  }
} finally {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
