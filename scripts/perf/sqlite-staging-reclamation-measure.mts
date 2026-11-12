// Synthetic only. Run with --root <disposable directory>; defaults reproduce a 35 GiB store.
// --gib 0.125 --sessions 32 --workspace-files 0 --stop-mib 1 --pairs 1 is the CI-sized proof.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    gib: { type: "string", default: "35" },
    sessions: { type: "string", default: "4000" },
    "workspace-files": { type: "string", default: "62000" },
    "stop-mib": { type: "string", default: "596" },
    pairs: { type: "string", default: "5" },
  },
});
if (!values.root) {
  throw new Error("Pass --root with an existing disposable directory");
}
const root = fs.mkdtempSync(path.join(path.resolve(values.root), "staging-reclamation-"));
const source = path.join(root, "source.sqlite");
const env = {
  ...process.env,
  HOME: root,
  USERPROFILE: root,
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  NODE_DISABLE_COMPILE_CACHE: "1",
  TSX_DISABLE_CACHE: "1",
};
Object.assign(process.env, env);
const sourceUrl = (name: string) => new URL(`../../src/infra/${name}.ts`, import.meta.url).href;
const loader = new URL("../tsx.mjs", import.meta.url).pathname;
const bytes = Math.floor(Number(values.gib) * 1024 ** 3);
const stopBytes = Math.floor(Number(values["stop-mib"]) * 1024 ** 2);
const sessions = Number(values.sessions);
const workspaceFiles = Number(values["workspace-files"]);
const pairs = Number(values.pairs);
if (
  !(bytes > stopBytes && stopBytes > 0) ||
  !Number.isInteger(sessions) ||
  sessions < 1 ||
  !Number.isInteger(workspaceFiles) ||
  workspaceFiles < 0 ||
  !Number.isInteger(pairs) ||
  pairs < 1
) {
  throw new Error("Invalid fixture dimensions");
}
const nodeArgs = ["--import", loader, "--input-type=module", "--eval"];
const records: unknown[] = [];
async function measuredSweep(baseline: boolean) {
  const { resolvePrivateSqliteSnapshotStagingRoot } = await import(
    sourceUrl("sqlite-private-directory")
  );
  const { reclaimSqliteSnapshotsInProcess } = await import(
    sourceUrl("sqlite-snapshot-reclamation")
  );
  const { cleanupSnapshotOperations } = await import(sourceUrl("sqlite-readonly-location-cleanup"));
  const stagingRoot = resolvePrivateSqliteSnapshotStagingRoot();
  const session = new Session();
  session.connect();
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const cpuAt = process.cpuUsage(),
    at = performance.now();
  const result = baseline
    ? (await cleanupSnapshotOperations(), { removed: 0, bytes: 0, skipped: 0 })
    : await reclaimSqliteSnapshotsInProcess(stagingRoot);
  const wallMs = performance.now() - at,
    cpu = process.cpuUsage(cpuAt);
  const { profile } = await session.post("HeapProfiler.stopSampling");
  session.disconnect();
  return {
    result,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    sampledAllocationBytes: profile.samples.reduce((sum, sample) => sum + sample.size, 0),
    maxRss: process.resourceUsage().maxRSS,
  };
}
function age(directory: string) {
  const old = new Date(Date.now() - 60 * 60_000);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      age(location);
    }
    fs.utimesSync(location, old, old);
  }
  fs.utimesSync(directory, old, old);
}
try {
  using database = new DatabaseSync(source);
  database.exec(
    "CREATE TABLE sessions(id INTEGER PRIMARY KEY, data TEXT); CREATE TABLE payload(data BLOB); BEGIN",
  );
  const insert = database.prepare("INSERT INTO sessions VALUES (?, ?)");
  for (let id = 0; id < sessions; id++) {
    insert.run(id, `synthetic-session-${id}`);
  }
  const padding = database.prepare("INSERT INTO payload VALUES(zeroblob(?))");
  for (let remaining = bytes; remaining > 0;) {
    const chunk = Math.min(32 * 1024 ** 2, remaining);
    padding.run(chunk);
    remaining -= chunk;
  }
  database.exec("COMMIT");
  database.close();
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const block = Buffer.alloc(17_743, 0x6d);
  for (let i = 0; i < workspaceFiles; i++) {
    fs.writeFileSync(path.join(workspace, `file-${i}`), block);
  }
  const labels = [
    "aa1",
    "aa2",
    ...Array.from({ length: pairs }, (_, i) => [`a${i + 1}`, `b${i + 1}`]).flat(),
  ];
  const liveSafety: unknown[] = [];
  for (const label of labels) {
    const script = `
      import fs from "node:fs";
      import path from "node:path";
      const { createSqliteSnapshotStagingTokenSync } = await import(${JSON.stringify(sourceUrl("sqlite-snapshot-staging"))});
      const { prepareSqliteReadOnlyLocationSyncInProcess } = await import(${JSON.stringify(sourceUrl("sqlite-readonly-location"))});
      const parent = createSqliteSnapshotStagingTokenSync();
      process.send({ directory: parent.directory });
      await new Promise(resolve => process.once("message", resolve));
      ${label === "b1" ? "parent.release();" : ""}
      prepareSqliteReadOnlyLocationSyncInProcess(${JSON.stringify(source)}, parent.directory);
      throw new Error("Copy was not interrupted");
    `;
    const child = spawn(process.execPath, [...nodeArgs, script], {
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let errors = "";
    child.stderr?.on("data", (chunk) => {
      errors += chunk;
    });
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      const parent = await new Promise<string>((resolve, reject) => {
        child.once("message", (message: { directory: string }) => resolve(message.directory));
        child.once("error", reject);
        child.once("close", () => reject(new Error(`Copy exited before readiness: ${errors}`)));
      });
      child.send("copy");
      let location: string | undefined;
      while (!location) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Copy finished before interruption: ${errors}`);
        }
        for (const directory of fs.readdirSync(parent, { withFileTypes: true })) {
          if (!directory.isDirectory()) {
            continue;
          }
          const nested = path.join(parent, directory.name);
          let entries: string[];
          try {
            entries = fs.readdirSync(nested);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              continue;
            }
            throw error;
          }
          for (const entry of entries) {
            if (!/^(?:\.fs-safe-.*\.tmp|database\.sqlite\.partial)$/u.test(entry)) {
              continue;
            }
            const candidate = path.join(nested, entry);
            const stat = fs.statSync(candidate, { throwIfNoEntry: false });
            if (stat && stat.size >= stopBytes && stat.size < fs.statSync(source).size) {
              child.kill("SIGSTOP");
              location = candidate;
              break;
            }
          }
          if (location) {
            break;
          }
        }
        // Wait for filesystem progress from the actual native copy, without replacing its backend.
        await setImmediate();
      }
      const ready = { parent, location, copiedBytes: fs.statSync(location).size };
      if (ready.copiedBytes >= fs.statSync(source).size) {
        throw new Error("Copy completed before SIGSTOP");
      }
      clearTimeout(deadline);
      age(ready.parent);
      if (label === "aa1" || label === "b1") {
        liveSafety.push({
          custody: label === "aa1" ? "creator" : "nested-reader",
          ...(await measuredSweep(false)),
        });
        if (!fs.existsSync(ready.location)) {
          throw new Error("Sweep deleted a live producer's copy");
        }
      }
      child.kill("SIGKILL");
      await closed;
      // SIGSTOP delivery can lag the observed write; count the final stopped payload.
      ready.copiedBytes = fs.statSync(ready.location).size;
      if (ready.copiedBytes >= fs.statSync(source).size) {
        throw new Error("Creator completed the copy before SIGKILL");
      }
      // Model the next eligible sweep after the creator and failed probes stop changing metadata.
      age(ready.parent);
      const journalLeft = fs.existsSync(
        path.join(path.dirname(ready.location), "owner.sqlite-journal"),
      );
      const measurement = await measuredSweep(!label.startsWith("b"));
      const retained = fs.existsSync(ready.parent);
      if (label.startsWith("b") ? retained : !retained) {
        throw new Error("Unexpected orphan disposition");
      }
      records.push({
        label,
        ...ready,
        parent: path.basename(ready.parent),
        location: path.basename(ready.location),
        journalLeft,
        retained,
        ...measurement,
      });
      if (retained) {
        await measuredSweep(false);
        if (fs.existsSync(ready.parent)) {
          throw new Error("Post-measurement cleanup did not reclaim orphan");
        }
      }
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed;
    }
  }
  using verified = new DatabaseSync(source, { readOnly: true });
  const preservedSessions = verified.prepare("SELECT COUNT(*) AS count FROM sessions").get();
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        node: process.version,
        fixture: {
          sourceBytes: fs.statSync(source).size,
          sessions,
          workspaceFiles,
          workspaceBytes: workspaceFiles * block.length,
        },
        proof:
          "Actual artifact-preserving byte copy interrupted by SIGKILL during an unpublished native byte copy; source records retained",
        preservedSessions,
        metrics:
          "Owner time/CPU and sampled V8 allocations; child startup and fixture construction excluded. A is process-local cleanup with no ownership of another process's staging, B is install-scoped abandoned cleanup.",
        liveSafety,
        records,
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
