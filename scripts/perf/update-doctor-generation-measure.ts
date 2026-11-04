// Run with node --import ./scripts/tsx.mjs; see scripts/perf/README.md.
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { UpdateDatabaseBackup } from "../../src/infra/update-database-backup.js";

const label = process.argv[2] ?? "sample";
assert.match(label, /^[a-zA-Z0-9-]+$/u);
const generationOnly = process.argv[3] === "generations-only";
const samples = Number(process.argv[4] ?? 5);
assert.ok(Number.isSafeInteger(samples) && samples > 0);
const sourceRoot = path.resolve(process.argv[5] ?? ".");
if (process.argv[3] === "ledger-writes") {
  await measureLedgerWrites();
  process.exit(0);
}
const root = path.resolve(".artifacts/update-doctor-generation-measure");
const stateDir = path.join(root, "state");
fs.mkdirSync(path.join(root, "home"), { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
process.env.HOME = path.join(root, "home");
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, '{"plugins":{"enabled":false}}');

const { createStoppedSqliteSnapshot }: typeof import("../../src/infra/sqlite-snapshot.js") =
  await import(pathToFileURL(path.join(sourceRoot, "src/infra/sqlite-snapshot.ts")).href);
const {
  readUpdatePhysicalDatabaseGenerations,
}: typeof import("../../src/infra/update-physical-database-generations.js") = await import(
  pathToFileURL(path.join(sourceRoot, "src/infra/update-physical-database-generations.ts")).href
);
const {
  createUpdateDoctorDatabaseWriteCapture,
}: typeof import("../../src/infra/update-doctor-result.js") = await import(
  pathToFileURL(path.join(sourceRoot, "src/infra/update-doctor-result.ts")).href
);

const paths: string[] = [];
for (let index = 0; index < 8; index += 1) {
  const directory = path.join(stateDir, "agents", `agent-${index}`, "agent");
  fs.mkdirSync(directory, { recursive: true });
  const pathname = path.join(directory, "openclaw-agent.sqlite");
  paths.push(pathname);
  if (!fs.existsSync(pathname)) {
    using database = new DatabaseSync(pathname);
    database.exec("PRAGMA journal_mode=DELETE; CREATE TABLE synthetic_state(payload BLOB);");
    const insert = database.prepare("INSERT INTO synthetic_state VALUES (zeroblob(1048576))");
    database.exec("BEGIN");
    for (let row = 0; row < (index === 0 ? 2048 : 146); row += 1) {
      insert.run();
    }
    database.exec("COMMIT");
  }
}
const bytes = paths.reduce((total, pathname) => total + fs.statSync(pathname).size, 0);
const identities = paths.map((pathname) => fs.statSync(pathname, { bigint: true }));
const sourceKeys = new Set(identities.map((stat) => `${stat.dev}:${stat.ino}`));
const sourceSizes = new Set(identities.map((stat) => stat.size));
const generations = await readUpdatePhysicalDatabaseGenerations(paths);
console.log(
  JSON.stringify({ label, fixtureBytes: bytes, files: paths.length, platform: process.platform }),
);

// macOS resourceUsage.fsRead counts I/O operations, not logical bytes. Report it
// without relabeling it; /proc/self/io supplies logical read bytes on Linux.
function io() {
  const usage = process.resourceUsage();
  const proc = process.platform === "linux" ? fs.readFileSync("/proc/self/io", "utf8") : "";
  return {
    userCPUTime: usage.userCPUTime,
    systemCPUTime: usage.systemCPUTime,
    fsRead: usage.fsRead,
    rchar: Number(/^rchar:\s+(\d+)$/mu.exec(proc)?.[1] ?? 0),
  };
}

for (let sample = 0; sample < samples; sample += 1) {
  const phases = generationOnly
    ? (["generation-bytes"] as const)
    : (["stopped-snapshot", "doctor-generations", "generation-bytes"] as const);
  for (const phase of phases) {
    const before = io();
    const start = performance.now();
    const warnings: string[] = [];
    let sourceReadBytes = 0;
    let privateReadBytes = 0;
    if (phase === "stopped-snapshot") {
      const output = path.join(root, `${label}-${sample}`);
      fs.mkdirSync(output);
      try {
        for (const [index, sourcePath] of paths.entries()) {
          await createStoppedSqliteSnapshot({
            sourcePath,
            targetPath: path.join(output, `${index}.sqlite`),
            sourceIdentity: fs.statSync(sourcePath, { bigint: true }),
          });
        }
      } finally {
        fs.rmSync(output, { recursive: true });
      }
    } else if (phase === "generation-bytes") {
      const originalRead = fs.readSync;
      // Count bytes returned to synchronous hashing/source admission, including
      // bounded headers. Native SQLite/copy reads are outside this measurement.
      fs.readSync = new Proxy(originalRead, {
        apply(target, thisArg, args) {
          const result: unknown = Reflect.apply(target, thisArg, args);
          if (typeof result === "number" && typeof args[0] === "number") {
            const stat = fs.fstatSync(args[0], { bigint: true });
            if (sourceKeys.has(`${stat.dev}:${stat.ino}`)) {
              sourceReadBytes += result;
            } else if (stat.isFile() && sourceSizes.has(stat.size)) {
              privateReadBytes += result;
            }
          }
          return result;
        },
      });
      try {
        assert.deepEqual(await readUpdatePhysicalDatabaseGenerations(paths), generations);
      } finally {
        fs.readSync = originalRead;
      }
    } else {
      const capture = createUpdateDoctorDatabaseWriteCapture(generations, {
        env: process.env,
        signal: new AbortController().signal,
        warn: (message) => warnings.push(message),
      });
      assert.ok(capture);
      await capture.admit();
      await capture.run(async () => {});
      await capture.settle();
      assert.equal(capture.receipt?.unchanged, true);
      assert.deepEqual(capture.receipt.generations, generations);
      assert.deepEqual(warnings, []);
    }
    const seconds = (performance.now() - start) / 1000;
    const after = io();
    console.log(
      JSON.stringify({
        label,
        sample,
        phase,
        seconds,
        userCPUSeconds: (after.userCPUTime - before.userCPUTime) / 1e6,
        systemCPUSeconds: (after.systemCPUTime - before.systemCPUTime) / 1e6,
        fsReadOperations: after.fsRead - before.fsRead,
        ...(phase === "generation-bytes" ? { sourceReadBytes, privateReadBytes } : {}),
        ...(process.platform === "linux" ? { logicalReadBytes: after.rchar - before.rchar } : {}),
      }),
    );
  }
}

// Counts only: preload the frozen SQL observer and supply SQLMEASURE_OUT.
// label ledger-writes warm-samples source-root source-head
async function measureLedgerWrites() {
  const head = process.argv[6];
  assert.match(head ?? "", /^[a-f0-9]{40}$/u);
  const output = process.env.SQLMEASURE_OUT;
  assert.ok(output, "SQLMEASURE_OUT must name the observer output directory");
  const phase = (value: string) => fs.writeFileSync(path.join(output, "phase"), value);
  const fixtureRoot = fs.mkdtempSync(path.join(tmpdir(), "update-ledger-measure-"));
  const env = {
    ...process.env,
    HOME: path.join(fixtureRoot, "home"),
    OPENCLAW_STATE_DIR: path.join(fixtureRoot, "state"),
    OPENCLAW_CONFIG_PATH: path.join(fixtureRoot, "openclaw.json"),
  };
  fs.mkdirSync(env.HOME);
  fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, '{"plugins":{"enabled":false}}');
  Object.assign(process.env, env);
  const load = (relative: string) => import(pathToFileURL(path.join(sourceRoot, relative)).href);
  phase("setup");
  const ledger: typeof import("../../src/infra/update-run-ledger.js") = await load(
    "src/infra/update-run-ledger.ts",
  );
  const worker: typeof import("../../src/infra/update-run-write.async.js") = await load(
    "src/infra/update-run-write.async.ts",
  );
  const state: typeof import("../../src/state/openclaw-state-db.js") = await load(
    "src/state/openclaw-state-db.ts",
  );
  const generationReader: typeof import("../../src/infra/update-database-generations.js") =
    await load("src/infra/update-database-generations.ts");
  // The baseline predates parent observation; measure its existing ledger owner unchanged.
  const receipts: {
    observeUpdateParentDatabaseWrites?: typeof import("../../src/cli/update-cli/update-command-database-receipts.js").observeUpdateParentDatabaseWrites;
  } = await load("src/cli/update-cli/update-command-database-receipts.ts");
  try {
    for (const owner of ["native", "worker"] as const) {
      for (const captured of [false, true]) {
        phase("setup");
        env.OPENCLAW_STATE_DIR = path.join(fixtureRoot, `${owner}-${captured}`);
        process.env.OPENCLAW_STATE_DIR = env.OPENCLAW_STATE_DIR;
        const { runId } = ledger.createUpdateRun({ trigger: "cli" }, { env });
        await state.closeOpenClawStateDatabaseAsync();
        const pathname = path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
        const sourceGenerations = generationReader.readUpdateDatabaseGenerations([pathname]);
        const backup: UpdateDatabaseBackup = {
          directory: fixtureRoot,
          databases: [],
          missingPaths: [],
          sourcePaths: [pathname],
          sourceGenerations,
          warnings: [],
        };
        // Cold is the first write after state handles close, not a cold module load.
        for (let sample = 0; sample <= samples; sample += 1) {
          const temperature = sample === 0 ? "cold" : "warm";
          const actionPhase = `${owner}-${captured ? "captured" : "ordinary"}-${temperature}-${sample}`;
          phase(actionPhase);
          const step = {
            step: "pre-plugin doctor",
            status: "completed" as const,
            endedAtMs: sample + 1,
          };
          if (owner === "native") {
            ledger.recordUpdateRunStep(runId, step, { env });
          } else {
            await worker.recordUpdateRunStepAsync(runId, step, { env });
          }
          if (captured && receipts.observeUpdateParentDatabaseWrites) {
            await receipts.observeUpdateParentDatabaseWrites(backup, { env });
          }
          phase("verification");
          assert.equal(backup.restoreRefusal, undefined);
          if (captured && receipts.observeUpdateParentDatabaseWrites) {
            assert.ok(backup.migration);
          }
          console.log(
            JSON.stringify({
              label,
              head,
              phase: actionPhase,
              owner,
              captured,
              temperature,
              sample,
              actions: 1,
              attributionAvailable: Boolean(receipts.observeUpdateParentDatabaseWrites),
            }),
          );
        }
        phase("verification");
        await state.closeOpenClawStateDatabaseAsync();
        assert.ok(
          ledger
            .getUpdateRun(runId, { env })
            ?.steps.some(
              (step) => step.step === "pre-plugin doctor" && step.endedAtMs === samples + 1,
            ),
        );
        await state.closeOpenClawStateDatabaseAsync();
      }
    }
  } finally {
    phase("cleanup");
    await state.closeOpenClawStateDatabaseAsync();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}
