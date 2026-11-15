/**
 * Measure deletion-owned executor admission after startup refused ordinary access.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-deletion-purge-measure.ts
 *   --state-dir <new-synthetic-directory> --prepare [--database-gib 35]
 * Repeat without --prepare on base and candidate; --owner selects an exact historical
 * openclaw-agent-execution-owner.ts copied beside its source. Use --allocations for
 * a separate sampled-allocation pass. Each launch prints A/A controls and five samples.
 * Acceptance: ordinary admission stays refused; deletion-owned admission completes.
 * The fixture has 3,000 real sessions and 62,000 files (1.116 GB). It does not model
 * btrfs. --database-gib fills canonical transcript rows to the requested real size.
 * Only executor acquisition/assertion/release is measured, not purge SQL, file
 * removal, full Gateway deletion or native allocation.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    prepare: { type: "boolean" },
    "database-gib": { type: "string", default: "0" },
    owner: { type: "string" },
    allocations: { type: "boolean" },
    label: { type: "string", default: "candidate" },
  },
});
assert(values["state-dir"] && globalThis.gc, "Supply --state-dir and --expose-gc");
const databaseGiB = Number(values["database-gib"]);
assert(Number.isFinite(databaseGiB) && databaseGiB >= 0 && databaseGiB <= 40);
assert(values.prepare || databaseGiB === 0, "--database-gib requires --prepare");
const root = path.resolve(values["state-dir"]);
const marker = path.join(root, ".agent-deletion-purge-measure.json");
const ownerPath = path.resolve(values.owner ?? "src/state/openclaw-agent-execution-owner.ts");
const ownerSha256 = createHash("sha256").update(fs.readFileSync(ownerPath)).digest("hex");
if (values.owner) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (/\/openclaw-agent-execution-owner\.(?:js|ts)$/.test(specifier)) {
        return nextResolve(pathToFileURL(ownerPath).href, context);
      }
      return nextResolve(specifier, context);
    },
  });
}
if (values.prepare) {
  assert(!fs.existsSync(root), "Refusing to overwrite an existing fixture");
  fs.mkdirSync(root, { recursive: true });
} else {
  assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).marker, "deletion-purge-v1");
}
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { writeSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
const { withAgentDeletion } = await import("../../src/agents/agent-lifecycle-registry.js");
const { captureAgentDeletionDatabaseExecution } =
  await import("../../src/state/openclaw-agent-execution.js");
const { createAgentDatabaseDeletionRefusal, recordAgentDatabaseAdmissions } =
  await import("../../src/state/agent-database-admission.js");
const agentId = "doomed";
const workspaceDir = path.join(root, "workspace");
const agentDir = path.join(root, "agents", agentId, "agent");
const target = { agentId, path: path.join(agentDir, "openclaw-agent.sqlite") };
const cfg = { agents: { entries: { doomed: { workspace: workspaceDir }, keeper: {} } } };
setRuntimeConfigSnapshot(cfg);
try {
  if (values.prepare) {
    fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg));
    runOpenClawAgentWriteTransaction((database) => {
      for (let index = 0; index < 3_000; index++) {
        writeSessionEntry(database, `agent:${agentId}:session-${index}`, {
          sessionId: `synthetic-${index}`,
          updatedAt: 1,
          label: `Synthetic session ${index}`,
        });
      }
    }, target);
    if (databaseGiB > 0) {
      // Offline synthetic seeding only; real SQLite pages, not a sparse file extension.
      const { db } = openOpenClawAgentDatabase(target);
      const pageSize = Number(db.prepare("PRAGMA page_size").get()!.page_size);
      const size = () => Number(db.prepare("PRAGMA page_count").get()!.page_count) * pageSize;
      const payload = JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: randomBytes(786_432).toString("base64") }],
        },
      });
      const insert = db.prepare(
        "INSERT INTO transcript_events(session_id,seq,event_json,created_at,navigation_type,message_role) VALUES(?,?,?,1,'message','toolResult')",
      );
      let rows = 0;
      db.exec("PRAGMA wal_autocheckpoint=0");
      while (size() < databaseGiB * 1024 ** 3) {
        runOpenClawAgentWriteTransaction(() => {
          for (let index = 0; index < 128; index++, rows++) {
            insert.run(`synthetic-${rows % 3_000}`, Math.floor(rows / 3_000) + 1, payload);
          }
        }, target);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      }
      assert.equal(db.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      console.log(JSON.stringify({ phase: "database-seeded", rows, databaseBytes: size() }));
    }
    const content = Buffer.alloc(18_000, 97);
    for (let index = 0; index < 62_000; index++) {
      const directory = path.join(workspaceDir, String(Math.floor(index / 1_000)));
      if (index % 1_000 === 0) {
        fs.mkdirSync(directory, { recursive: true });
      }
      fs.writeFileSync(path.join(directory, `${index}.txt`), content);
    }
    fs.writeFileSync(marker, JSON.stringify({ marker: "deletion-purge-v1" }));
    console.log(JSON.stringify({ prepared: true, sessions: 3_000, files: 62_000 }));
  } else {
    await withAgentDeletion(agentId, async (begin) => {
      const deletion = await begin({
        agentId,
        agentDir,
        workspaceDir,
        sessionsDir: path.join(root, "agents", agentId, "sessions"),
        deleteFiles: false,
        phase: "retiring",
      });
      recordAgentDatabaseAdmissions([
        createAgentDatabaseDeletionRefusal({
          agentId,
          paths: [target.path],
          code: "agent-database-inspection-pending",
          reason: "Synthetic startup inspection",
          repairHint: "Synthetic startup inspection",
        }),
      ]);
      try {
        for (const sample of ["warmup", "AA-1", "AA-2", "1", "2", "3", "4", "5"]) {
          const inspector = new Session();
          globalThis.gc!();
          if (values.allocations) {
            await startCollectedHeapSampling(inspector, 4096);
          }
          const cpu = process.threadCpuUsage();
          const started = performance.now();
          let completed = 0;
          let refused = 0;
          for (let index = 0; index < 20; index++) {
            try {
              await deletion.runDatabaseCleanup(target, async () => {
                const execution = await captureAgentDeletionDatabaseExecution(target);
                try {
                  execution.assertCurrent();
                } finally {
                  await execution.release();
                }
              });
              completed++;
            } catch (error) {
              if (!(error instanceof Error) || !error.message.includes("deleted during startup")) {
                throw error;
              }
              refused++;
            }
          }
          const wallMs = performance.now() - started;
          const used = process.threadCpuUsage(cpu);
          const sampledAllocationBytes = values.allocations
            ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
            : undefined;
          inspector.disconnect();
          console.log(
            JSON.stringify({
              label: values.label,
              sample,
              ownerSha256,
              completed,
              refused,
              wallMs,
              mainThreadCpuMs: (used.user + used.system) / 1000,
              sampledAllocationBytes,
              databaseBytes: fs.statSync(target.path).size,
              sessions: 3_000,
              workspaceFiles: 62_000,
              workspaceBytes: 1_116_000_000,
              hostLoad: loadavg(),
              node: process.version,
            }),
          );
        }
      } finally {
        recordAgentDatabaseAdmissions([]);
        await deletion.rollback();
      }
    });
  }
} finally {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
