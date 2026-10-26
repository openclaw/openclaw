// Run with node --import ./scripts/tsx.mjs; see scripts/perf/README.md.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const label = process.argv[2] ?? "sample";
assert.match(label, /^[a-zA-Z0-9-]+$/u);
const generationOnly = process.argv[3] === "generations-only";
const samples = Number(process.argv[4] ?? 5);
assert.ok(Number.isSafeInteger(samples) && samples > 0);
const sourceRoot = path.resolve(process.argv[5] ?? ".");
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
