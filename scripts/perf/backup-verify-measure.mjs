import { execFileSync } from "node:child_process";
// Instrument a disposable qaRuntime build, then preload this file for real CLI phase timing.
// node scripts/perf/backup-verify-measure.mjs instrument dist
// BACKUP_MEASUREMENT=/absolute/result.jsonl node --import ./scripts/perf/backup-verify-measure.mjs openclaw.mjs backup ...
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const phases = new Set([
  "createConsistentStateSnapshotPlan",
  "createBackupSqliteSnapshotPlan",
  "writeArchiveStreamToFile",
  "listBackupArchiveEntries",
  "extractDatabaseArtifacts",
  "prepareDatabaseArtifacts",
  "verifyPostgresSnapshots",
  "verifySqliteSnapshots",
  "verifyMatchedPostgresBackup",
  "assertSqliteIntegrity",
]);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "instrument" || !process.argv[3]) {
    throw new Error("Usage: backup-verify-measure.mjs instrument <disposable-dist-directory>");
  }
  for (const name of fs.readdirSync(process.argv[3])) {
    if (!/\.(?:mjs|js)$/u.test(name)) {
      continue;
    }
    const file = path.join(process.argv[3], name);
    const source = fs.readFileSync(file, "utf8");
    if (![...phases].some((phase) => source.includes(`function ${phase}(`))) {
      continue;
    }
    if (source.includes("globalThis.backupMeasure")) {
      throw new Error(`Build already instrumented: ${file}`);
    }
    const edits = [];
    const visit = (node) => {
      if (!node || typeof node !== "object") {
        return;
      }
      if (node.type === "FunctionDeclaration" && phases.has(node.id.name)) {
        const archive = ["listBackupArchiveEntries", "extractDatabaseArtifacts"].includes(
          node.id.name,
        );
        edits.push([
          node.body.start + 1,
          `const __measurement = globalThis.backupMeasure?.(${JSON.stringify(node.id.name)}${archive ? ", archivePath" : ""}); try {`,
        ]);
        edits.push([node.body.end - 1, "} finally { __measurement?.(); }"]);
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          value.forEach(visit);
        } else if (value && typeof value === "object") {
          visit(value);
        }
      }
    };
    visit(parse(source, { ecmaVersion: "latest", sourceType: "module" }));
    if (!edits.length) {
      continue;
    }
    let output = source;
    for (const [offset, text] of edits.toSorted((a, b) => b[0] - a[0])) {
      output = output.slice(0, offset) + text + output.slice(offset);
    }
    fs.writeFileSync(file, output);
    console.log(`${name}: ${edits.length / 2} phase boundaries`);
  }
} else if (process.env.BACKUP_MEASUREMENT) {
  // macOS resourceUsage.fsRead is always zero. An optional proc_pid_rusage helper
  // reports physical disk bytes; archiveReadBytes separately counts logical input.
  const disk = () =>
    process.env.BACKUP_MEASURE_RUSAGE
      ? JSON.parse(
          execFileSync(process.env.BACKUP_MEASURE_RUSAGE, [String(process.pid)], {
            encoding: "utf8",
          }).trim(),
        )
      : undefined;
  globalThis.backupMeasure = (phase, archivePath) => {
    const started = performance.now();
    const load = os.loadavg();
    const cpu = process.cpuUsage();
    const read = disk();
    return () => {
      const elapsed = process.cpuUsage(cpu);
      const currentRead = disk();
      fs.appendFileSync(
        process.env.BACKUP_MEASUREMENT,
        `${JSON.stringify({
          phase,
          load,
          wallMs: performance.now() - started,
          userMs: elapsed.user / 1000,
          systemMs: elapsed.system / 1000,
          ...(archivePath ? { archiveReadBytes: fs.statSync(archivePath).size } : {}),
          ...(read === undefined
            ? {}
            : {
                diskReadBytes: currentRead.diskReadBytes - read.diskReadBytes,
                childUserMs: currentRead.childUserMs - read.childUserMs,
                childSystemMs: currentRead.childSystemMs - read.childSystemMs,
              }),
        })}\n`,
      );
    };
  };
  process.once("exit", globalThis.backupMeasure("CLI total"));
}
