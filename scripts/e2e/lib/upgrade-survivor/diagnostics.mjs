import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { publishedBackupRollback } from "./backup-rollback-summary.mjs";
import { publishedPluginPolicy } from "./plugin-policy-summary.mjs";

// Capture and snapshot validation stay plain Node. The host entrypoint owns
// the redactor; neither candidate code nor raw fixture data owns uploads.
const inputLimit = 256 * 1024;
const indexLimit = 1024 * 1024;
const outputLimit = 16 * 1024;
const privateLimit = 8 * 1024 * 1024;
const publicLimit = 512 * 1024;
const entryLimit = 128;
const migrationFileLimit = 2 * 1024 * 1024;
const migrationDirectory = "session-sqlite-migration-runs";
const migrationLabels = {
  manifest: "session migration manifest",
  failureReport: "session migration failure report",
};
const siblingRefusalLogs = [
  "sibling-refusal-update.json",
  "sibling-refusal-update.err",
  "sibling-refusal-status.json",
  "sibling-refusal-status.err",
  "sibling-refusal-baseline.json",
  "sibling-refusal-worker.json",
  "sibling-refusal-child.json",
  "sibling-refusal-cleanup.json",
  "sibling-refusal-registrations.jsonl",
];
const restoredIndexLogs = [
  "legacy-operator-restored-index.json",
  "restored-index-post-update.json",
  "restored-index-candidate-import.json",
  "restored-index-rollback.json",
];
const backupRollbackLogs = [
  "backup-rollback.json",
  "backup-rollback-create.json",
  "backup-rollback-create.json.err",
  "backup-rollback-restore.json",
  "backup-rollback-restore.json.err",
];
const pluginPolicyLogs = [
  "webhooks-only-policy/result.json",
  "webhooks-only-policy/update.json",
  "webhooks-only-policy/baseline-runtime.out",
  "webhooks-only-policy/candidate-runtime.out",
];
const logNames = [
  "baseline-install.log",
  "baseline-companion.json",
  "install.log",
  "update.json",
  "update.err",
  "update-noop.json",
  "update-noop.err",
  ...siblingRefusalLogs,
  ...restoredIndexLogs,
  ...backupRollbackLogs,
  "repair.json",
  "repair.err",
  "recovery-update.json",
  "recovery-update.err",
  "post-update-validate.json",
  "post-update-validate.err",
  "doctor.log",
  "baseline-doctor.log",
  "workshop-doctor-recovery.json",
  "update-report-recovery.json",
  "update-report-baseline.json",
  "update-report-retry.pty.log",
  "update-report-pending.pty.log",
  "update-report-retry.gh.jsonl",
  "update-report-pending.gh.jsonl",
  "update-report-retry-status.log",
  "update-report-pending-status.log",
  "update-report-retry-status.err",
  "update-report-pending-status.err",
  "update-report-retry.output.log",
  "update-report-pending.output.log",
  "workshop-published-refusal.json",
  "workshop-baseline-doctor.json",
  "workshop-recovered-upgrade.json",
  "workshop-candidate-doctor.json",
  "physical-baseline-update.json",
  "physical-baseline-update.err",
  "physical-baseline-refusal.json",
  "physical-baseline-restoration.json",
  "physical-candidate-doctor.log",
  "physical-candidate-repair.json",
  "legacy-operator-cron-history-proof.json",
  ...pluginPolicyLogs,
  "webhooks-only-policy/update.err",
  "webhooks-only-policy/gateway.log",
  "webhooks-only-policy/baseline-gateway.log",
  "legacy-operator-post-update-cron-history.json",
  "legacy-operator-candidate-cron-history.json",
  "dreaming-cron-proof.json",
  "legacy-operator-baseline-turn.out",
  "legacy-operator-baseline-turn.err",
  "legacy-operator-candidate-turn.out",
  "legacy-operator-candidate-turn.err",
  "legacy-operator-run-survivor-default-owner.out",
  "legacy-operator-run-survivor-default-owner.err",
  "legacy-operator-run-survivor-ops-owner.out",
  "legacy-operator-run-survivor-ops-owner.err",
  ...["post-update", "candidate"].flatMap((stage) =>
    [0, 1].flatMap((index) =>
      ["", "-earlier"].flatMap((page) =>
        ["out", "err"].map(
          (extension) => `legacy-operator-${stage}-transcript-${index}${page}.${extension}`,
        ),
      ),
    ),
  ),
  "gateway.log",
  "gateway-startup-probes.json",
  "gateway-startup-os-before.log",
  "gateway-startup-os-after.log",
  "gateway.log.doctor",
  "missing-load-path/baseline-gateway.log",
  "missing-load-path/startup-readiness.log",
  "missing-load-path/baseline-gateway-convergence-refusal.log",
  "baseline-service-install.err",
  "systemctl-shim.log",
  "systemctl-shim-gateway.log",
  "systemctl-shim-gateway.log.bootstrap.log",
  "gateway-restart.log",
];
const reasons = [
  "missing or unsafe file",
  "input exceeds cap; omitted whole",
  "input changed while reading; omitted whole",
  "invalid observation; omitted",
  "SQLite journal state requires an artifact-preserving reader; omitted before native open",
];
const omissions = {};

function ownedPath(root, relative) {
  if (!root || fs.lstatSync(root).isSymbolicLink()) {
    throw new Error();
  }
  let file = fs.realpathSync(root);
  for (const part of relative.split(path.sep)) {
    if (!part || part === "." || part === "..") {
      throw new Error();
    }
    file = path.join(file, part);
    if (fs.lstatSync(file).isSymbolicLink()) {
      throw new Error();
    }
  }
  return file;
}

function openOwned(root, relative) {
  const file = ownedPath(root, relative);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1) {
    fs.closeSync(fd);
    throw new Error();
  }
  return { fd, stat, file };
}

function sameFileIdentity(before, after) {
  return ["dev", "ino", "size", "nlink"].every((key) => before[key] === after[key]);
}

function unchangedFile(before, after) {
  return (
    sameFileIdentity(before, after) &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function readOwned(root, relative, label, limit = inputLimit, binary = false) {
  try {
    const { fd, stat } = openOwned(root, relative);
    try {
      // Never truncate before redaction, including a short read or growing log.
      const bytes = Buffer.alloc(limit + 1);
      const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (length > limit || stat.size > limit) {
        omissions[label] = reasons[1];
        return null;
      }
      if (length !== stat.size || !unchangedFile(stat, fs.fstatSync(fd))) {
        omissions[label] = reasons[2];
        return null;
      }
      const complete = bytes.subarray(0, length);
      return binary ? complete : complete.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    omissions[label] = reasons[0];
    return null;
  }
}

function boundedList(value) {
  if (!Array.isArray(value) || value.length > entryLimit) {
    throw new Error();
  }
  return value;
}

function textFields(value, fields, sanitize) {
  return Object.fromEntries(
    fields
      .filter((key) => value?.[key] !== undefined)
      .map((key) => {
        if (typeof value[key] !== "string") {
          throw new Error();
        }
        return [key, sanitize(value[key], "post-core/plugin identity")];
      }),
  );
}

function postCoreResult(value, sanitize = (text) => text) {
  if (
    !["ok", "warning", "skipped", "error"].includes(value?.status) ||
    typeof value.changed !== "boolean" ||
    typeof value.sync?.changed !== "boolean" ||
    typeof value.npm?.changed !== "boolean"
  ) {
    throw new Error();
  }
  const sync = { changed: value.sync.changed };
  for (const key of ["switchedToBundled", "switchedToNpm", "warnings", "errors"]) {
    sync[key] = boundedList(value.sync[key]).map(
      (text) => textFields({ text }, ["text"], sanitize).text,
    );
  }
  return {
    status: value.status,
    changed: value.changed,
    ...textFields(value, ["reason"], sanitize),
    sync,
    warnings: boundedList(value.warnings ?? []).map((warning) =>
      textFields(warning, ["pluginId", "reason", "message"], sanitize),
    ),
    npm: {
      changed: value.npm.changed,
      outcomes: boundedList(value.npm.outcomes).map((outcome) => {
        if (!["updated", "unchanged", "skipped", "error"].includes(outcome?.status)) {
          throw new Error();
        }
        const projected = textFields(
          outcome,
          ["pluginId", "message", "warning", "code", "currentVersion", "nextVersion"],
          sanitize,
        );
        projected.status = outcome.status;
        if (outcome.channelFallback) {
          projected.channelFallback = textFields(
            outcome.channelFallback,
            ["requestedSpec", "usedSpec", "reason", "message"],
            sanitize,
          );
        }
        return projected;
      }),
    },
    integrityDrifts: boundedList(value.integrityDrifts).map((drift) =>
      textFields(
        drift,
        [
          "pluginId",
          "spec",
          "expectedIntegrity",
          "actualIntegrity",
          "resolvedSpec",
          "resolvedVersion",
          "action",
        ],
        sanitize,
      ),
    ),
  };
}

// Keep the assertion receipt independent of large Doctor output in update.json.
export function recordSuccessfulUpdateCheck(artifactRoot, result) {
  if (!artifactRoot) {
    return;
  }
  try {
    writeReport(
      artifactRoot,
      path.join(artifactRoot, "diagnostics"),
      "successful-update-check.json",
      { artifactRoot: fs.realpathSync(artifactRoot), ...successfulUpdateCheck(result) },
      inputLimit,
    );
  } catch {
    // Diagnostic failure must preserve the original assertion and exit status.
  }
}

function successfulUpdateCheck(value, sanitize = (text) => text) {
  const unavailable = { availability: "unavailable" };
  if (!value || value.availability === "unavailable") {
    return unavailable;
  }
  try {
    if (!["passed", "failed"].includes(value.outcome)) {
      throw new Error();
    }
    const result = {
      availability: "captured",
      outcome: value.outcome,
      ...textFields(value, ["message"], sanitize),
      plugins: null,
    };
    if (value.plugins !== null) {
      try {
        result.plugins = postCoreResult(value.plugins, sanitize);
      } catch {
        omissions["successful update plugins"] = reasons[3];
      }
    }
    return result;
  } catch {
    omissions["successful update check"] = reasons[3];
    return unavailable;
  }
}

export function readPostCoreSnapshot(artifactRoot) {
  try {
    ownedPath(artifactRoot, "diagnostics/post-core.json");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const raw = readOwned(artifactRoot, "diagnostics/post-core.json", "post-core", inputLimit + 1024);
  if (raw === null) {
    throw new Error("Post-core snapshot could not be read safely");
  }
  const snapshot = JSON.parse(raw);
  if (
    snapshot.artifactRoot !== fs.realpathSync(artifactRoot) ||
    !Number.isInteger(snapshot.childExitCode) ||
    snapshot.childExitCode < 0 ||
    snapshot.childExitCode > 255
  ) {
    throw new Error("Post-core snapshot does not belong to this update observation");
  }
  return { childExitCode: snapshot.childExitCode, result: postCoreResult(snapshot.result) };
}

// The published updater discards unknown IPC fields and deletes the file after
// its child exits. Observe the child's existing receipt without changing its lifetime.
function readDoctorResult(
  project = doctorResult,
  resultPath = process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH,
) {
  try {
    if (!resultPath || !path.isAbsolute(resultPath)) {
      return undefined;
    }
    const directory = path.dirname(resultPath);
    const uid = process.getuid?.();
    const fallback = path.join(tmpdir(), uid === undefined ? "openclaw" : `openclaw-${uid}`);
    if (
      ![...(process.platform === "win32" ? [] : ["/tmp/openclaw"]), fallback].includes(directory) ||
      !/^openclaw-update-doctor-\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/iu.test(
        path.basename(resultPath),
      )
    ) {
      return undefined;
    }
    // Mirror only the temp owner's read boundary, never its mkdir/chmod behavior.
    const stat = fs.lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o022) !== 0))
    ) {
      return undefined;
    }
    return project(JSON.parse(readOwned(directory, path.basename(resultPath), "Doctor IPC")));
  } catch {
    return undefined;
  }
}

function doctorResult(value, sanitize = (text) => text) {
  if (
    !["ok", "error", "advisory"].includes(value?.status) ||
    !Array.isArray(value.failureFacts ?? []) ||
    (value.failureFacts?.length ?? 0) > 5
  ) {
    throw new Error();
  }
  return {
    status: value.status,
    failureFacts: (value.failureFacts ?? []).map((fact) => {
      for (const [key, limit] of [
        ["check", 128],
        ["code", 80],
        ["message", 200],
      ]) {
        if (key === "message" && fact?.[key] === undefined) {
          continue;
        }
        if (typeof fact?.[key] !== "string" || !fact[key].trim() || fact[key].length > limit) {
          throw new Error();
        }
      }
      return textFields(fact, ["check", "code", "message"], sanitize);
    }),
  };
}

function doctorObservation({ started, exited }, sanitize = (text) => text) {
  if (
    started?.role !== "doctor" ||
    started.event !== "started" ||
    exited?.role !== "doctor" ||
    exited.event !== "exited" ||
    !Number.isSafeInteger(started.pid) ||
    started.pid <= 0 ||
    !Number.isSafeInteger(started.parentPid) ||
    started.parentPid <= 0 ||
    typeof started.packageVersion !== "string" ||
    !/^\d{4}\.\d{1,2}\.\d{1,3}(?:-(?:\d+|(?:alpha|beta)\.\d+))?$/.test(started.packageVersion) ||
    ["pid", "parentPid", "packageVersion"].some((key) => started[key] !== exited[key]) ||
    !Number.isInteger(exited.exitCode) ||
    exited.exitCode < 0 ||
    exited.exitCode > 255
  ) {
    throw new Error();
  }
  return {
    pid: started.pid,
    parentPid: started.parentPid,
    packageVersion: started.packageVersion,
    exitCode: exited.exitCode,
    ...doctorResult(exited.doctorResult, sanitize),
  };
}

function readDoctorResults(root) {
  const pairs = [];
  for (const name of boundedList(fs.readdirSync(ownedPath(root, "diagnostics")))) {
    const match = /^process-(\d+)-exited\.json$/.exec(name);
    if (!match) {
      continue;
    }
    const exited = JSON.parse(readOwned(root, `diagnostics/${name}`, "Doctor exit"));
    if (exited?.doctorResult === undefined) {
      continue;
    }
    const started = JSON.parse(
      readOwned(root, `diagnostics/process-${match[1]}-started.json`, "Doctor start"),
    );
    const pair = { started, exited };
    doctorObservation(pair);
    if (started.pid !== Number(match[1])) {
      throw new Error();
    }
    pairs.push(pair);
  }
  return pairs;
}

// Project only the existing Doctor IPC contract, never config changes or receipt payloads.
function doctorIpcResult(value, sanitize = (text) => text) {
  // Preserve Main's existing IPC status/fact-count/field limits before adding migration fields.
  doctorResult(value);
  return {
    status: value.status,
    warnings: boundedList(value.warnings ?? []).map(
      (text) => textFields({ text }, ["text"], sanitize).text,
    ),
    failureFacts: boundedList(value.failureFacts ?? []).map((fact) =>
      textFields(fact, ["check", "code", "message", "affectedKey", "pluginId"], sanitize),
    ),
  };
}

function doctorArtifactIdentity(root) {
  return createHash("sha256").update(fs.realpathSync(root)).digest("hex");
}

function captureDoctorIpc(artifactRoot, resultPath, exitCode) {
  if (!resultPath) {
    return;
  }
  // Reuse Main's secure temp-owner boundary; do not add a broader parallel IPC reader.
  const result = readDoctorResult(doctorIpcResult, resultPath);
  if (!result) {
    return;
  }
  writeReport(
    artifactRoot,
    path.join(artifactRoot, "diagnostics"),
    `doctor-${process.pid}.json`,
    {
      artifactRootSha256: doctorArtifactIdentity(artifactRoot),
      pid: process.pid,
      stateDir: process.env.OPENCLAW_STATE_DIR,
      exitCode,
      result,
    },
    inputLimit,
  );
}

function migrationProjection(section, value, sanitize = (text) => text) {
  const fields = (entry, names) => textFields(entry, names, sanitize);
  if (section === "doctor") {
    return {
      processes: boundedList(value.processes).map((observation) => {
        if (
          !Number.isInteger(observation.exitCode) ||
          observation.exitCode < 0 ||
          observation.exitCode > 255
        ) {
          throw new Error();
        }
        return Object.assign(fields(observation, ["stateDir"]), {
          exitCode: observation.exitCode,
          result: doctorIpcResult(observation.result, sanitize),
        });
      }),
    };
  }
  if (section === "sessions") {
    return {
      deferred: boundedList(value.deferred).map((row) =>
        fields(row, ["pluginId", "status", "reason"]),
      ),
      imports: boundedList(value.imports).map((row) => {
        if (typeof row.removedSource !== "boolean") {
          throw new Error();
        }
        return Object.assign(fields(row, ["sourcePath", "sourceSha256", "status"]), {
          removedSource: row.removedSource,
          pluginIds: boundedList(row.pluginIds).map((text) => fields({ text }, ["text"]).text),
          sources: boundedList(row.sources).map((source) => fields(source, ["path", "sha256"])),
        });
      }),
    };
  }
  if (section === "archives") {
    return {
      runs: boundedList(value.runs).map((run) =>
        Object.assign(fields(run, ["runId", "completedAt", "failedAt"]), {
          targets: boundedList(run.targets).map((target) => {
            if (
              !Number.isInteger(target.plannedMoveCount) ||
              target.plannedMoveCount < 0 ||
              !["not_run", "passed", "failed"].includes(target.validationBeforeArchive)
            ) {
              throw new Error();
            }
            return Object.assign(
              fields(target, ["agentId", "storePath", "sqlitePath", "validationBeforeArchive"]),
              {
                plannedMoveCount: target.plannedMoveCount,
                completedMoves: boundedList(target.completedMoves).map((move) =>
                  fields(move, ["kind", "sourcePath", "archivePath"]),
                ),
                issues: boundedList(target.issues).map((issue) =>
                  fields(issue, ["code", "message"]),
                ),
              },
            );
          }),
        }),
      ),
    };
  }
  if (section === "sibling") {
    return {
      registrations: boundedList(value.registrations).map((event) => {
        if (
          !["runtime", "doctor-module", "doctor-contract"].includes(event.surface) ||
          typeof event.updateCanary !== "boolean"
        ) {
          throw new Error();
        }
        return Object.assign(
          fields(event, ["surface", "stateDir", "source", "sharedSource"]),
          {
            updateCanary: event.updateCanary,
          },
          Object.fromEntries(
            ["sourceSha256", "sharedSourceSha256"].flatMap((key) =>
              typeof event[key] === "string" && /^[a-f0-9]{64}$/u.test(event[key])
                ? [[key, event[key]]]
                : [],
            ),
          ),
        );
      }),
    };
  }
  throw new Error();
}

// A native read-only open can create missing WAL sidecars or require journal recovery.
// This bootstrap observer never copies operator databases or imports a migrating runtime reader.
function assertNativeSqliteObservationSafe(handles, label) {
  const database = handles.find(({ file }) =>
    file.endsWith(`${path.sep}state${path.sep}openclaw.sqlite`),
  );
  if (!database) {
    return;
  }
  const header = Buffer.alloc(20);
  if (
    fs.readSync(database.fd, header, 0, header.length, 0) !== header.length ||
    header.subarray(0, 16).toString("utf8") !== "SQLite format 3\0" ||
    !unchangedFile(database.stat, fs.fstatSync(database.fd))
  ) {
    throw new Error();
  }
  const has = (suffix) => handles.some(({ file }) => file === database.file + suffix);
  // Even a complete WAL family can change SHM read marks. Preserve every source byte;
  // richer inspection belongs to the existing artifact-preserving runtime owner, not a new dump.
  if (header[18] !== 1 || header[19] !== 1 || ["-wal", "-shm", "-journal"].some(has)) {
    omissions[label] = reasons[4];
    throw new Error();
  }
}

function readMigrationSessions(stateRoot) {
  const handles = [];
  let db;
  try {
    for (const relative of [
      "state/openclaw.sqlite",
      "state/openclaw.sqlite-wal",
      "state/openclaw.sqlite-shm",
      "state/openclaw.sqlite-journal",
    ]) {
      try {
        const handle = openOwned(stateRoot, relative);
        handles.push(handle);
        if (handle.stat.size > 64 * 1024 * 1024) {
          throw new Error();
        }
      } catch (error) {
        if (relative.endsWith(".sqlite") || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
    assertNativeSqliteObservationSafe(handles, "migration-sessions");
    db = new DatabaseSync(handles[0].file, { readOnly: true });
    db.exec("BEGIN");
    // Read only these two existing receipt owners. No runtime store imports or state bootstrap.
    const read = (table, predicate, columns, parameter) => {
      const lengths = boundedList(
        db
          .prepare(
            `SELECT length(CAST(report_json AS BLOB)) AS bytes FROM ${table} WHERE ${predicate} LIMIT 129`,
          )
          .all(parameter),
      );
      if (
        lengths.some(({ bytes }) => !Number.isInteger(bytes) || bytes < 0 || bytes > inputLimit) ||
        lengths.reduce((sum, row) => sum + row.bytes, 0) > indexLimit
      ) {
        throw new Error();
      }
      return boundedList(
        db
          .prepare(`SELECT ${columns}, report_json FROM ${table} WHERE ${predicate} LIMIT 129`)
          .all(parameter),
      );
    };
    const deferred = read(
      "migration_runs",
      "id LIKE ?",
      "status",
      "deferred-plugin-migration:%",
    ).map(({ status, report_json }) =>
      Object.assign(
        textFields(JSON.parse(report_json), ["pluginId", "reason"], (text) => text),
        { status },
      ),
    );
    const imports = read(
      "migration_sources",
      "migration_kind = ?",
      "source_path, source_sha256, status, removed_source",
      "deferred-plugin-session-import",
    ).map((row) => {
      const value = JSON.parse(row.report_json);
      return {
        sourcePath: row.source_path,
        sourceSha256: row.source_sha256 ?? undefined,
        status: row.status,
        removedSource: row.removed_source === 1,
        pluginIds: value.pluginIds,
        sources: boundedList(value.sources).map((source) => ({
          path: source.path,
          sha256: source.identity?.sha256,
        })),
      };
    });
    db.exec("COMMIT");
    db.close();
    db = undefined;
    for (const { fd, stat, file } of handles) {
      const matches = file.endsWith("-shm") ? sameFileIdentity : unchangedFile;
      if (!matches(stat, fs.fstatSync(fd)) || !matches(stat, fs.lstatSync(file))) {
        throw new Error();
      }
    }
    return { deferred, imports };
  } finally {
    db?.close();
    for (const { fd } of handles) {
      fs.closeSync(fd);
    }
  }
}

function captureMigrationEvidence(stateRoot, artifactRoot, observationRoot) {
  const readJson = (root, relative, label) => {
    const raw = readOwned(root, relative, label);
    if (raw === null) {
      throw new Error();
    }
    return JSON.parse(raw);
  };
  const names = (root, relative, pattern) =>
    boundedList(
      fs.readdirSync(ownedPath(root, relative)).filter((name) => pattern.test(name)),
    ).toSorted((left, right) => left.localeCompare(right));
  const sources = {
    doctor: () => {
      const root = observationRoot || artifactRoot;
      const processes = names(root, "diagnostics", /^doctor-\d+\.json$/u).map((name) => {
        const value = readJson(root, `diagnostics/${name}`, "migration-doctor");
        if (
          value.artifactRootSha256 !== doctorArtifactIdentity(root) ||
          name !== `doctor-${value.pid}.json`
        ) {
          throw new Error();
        }
        return value;
      });
      if (!processes.length) {
        throw new Error();
      }
      return { processes };
    },
    sessions: () => readMigrationSessions(stateRoot),
    archives: () => ({
      runs: names(
        stateRoot,
        "session-sqlite-migration-runs",
        /^(?!.*\.failure\.json$).*\.json$/u,
      ).map((name) => {
        const value = readJson(
          stateRoot,
          `session-sqlite-migration-runs/${name}`,
          "migration-archives",
        );
        return Object.assign(
          textFields(value, ["runId", "completedAt", "failedAt"], (text) => text),
          {
            targets: boundedList(value.targets).map((target) =>
              Object.assign(target, {
                plannedMoveCount: boundedList(target.plannedMoves).length,
              }),
            ),
          },
        );
      }),
    }),
    sibling: () => {
      const raw = readOwned(artifactRoot, "sibling-registrations.jsonl", "migration-sibling");
      if (raw === null) {
        throw new Error();
      }
      return {
        registrations: boundedList(raw.split(/\r?\n/u).filter(Boolean)).map((line) => {
          const event = JSON.parse(line);
          return Object.assign(event, {
            updateCanary: boundedList(event.argv).includes("--update-canary"),
          });
        }),
      };
    },
  };
  return Object.fromEntries(
    Object.entries(sources).map(([section, read]) => {
      try {
        return [section, { availability: "captured", ...migrationProjection(section, read()) }];
      } catch {
        omissions[`migration-${section}`] ??= reasons[3];
        return [section, { availability: "unavailable" }];
      }
    }),
  );
}

function sessionMigrationProjection(raw, kind, runId, sanitize = (text) => text) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > migrationFileLimit) {
    throw new Error();
  }
  const value = JSON.parse(raw);
  const manifest = kind === "manifest";
  const version = manifest ? value.openClawVersion : value.version;
  if (
    value.runId !== runId ||
    typeof version !== "string" ||
    version.length === 0 ||
    version.length > 80 ||
    (manifest && ![1, 2, 3, 4].includes(value.manifestVersion))
  ) {
    throw new Error();
  }
  const targets = boundedList(value.targets).map((target) => {
    if (
      typeof target.agentId !== "string" ||
      target.agentId.length === 0 ||
      target.agentId.length > 128 ||
      !["not_run", "passed", "failed"].includes(target.validationBeforeArchive) ||
      !Array.isArray(target.issues)
    ) {
      throw new Error();
    }
    const histogram = new Map();
    for (const issue of target.issues) {
      if (typeof issue?.code !== "string" || !/^[a-z][a-z0-9_]{0,79}$/.test(issue.code)) {
        throw new Error();
      }
      histogram.set(issue.code, (histogram.get(issue.code) ?? 0) + 1);
    }
    const moves = {};
    for (const field of ["completedMoves", "plannedMoves"]) {
      if (manifest && !Array.isArray(target[field])) {
        throw new Error();
      }
      const count = manifest ? target[field].length : target[field];
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error();
      }
      moves[field] = count;
    }
    return Object.assign(
      {
        agentId: sanitize(target.agentId, migrationLabels[kind]),
        validationBeforeArchive: target.validationBeforeArchive,
        issueCount: target.issues.length,
        issueHistogram: boundedList([...histogram])
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([code, count]) => ({ code: sanitize(code, migrationLabels[kind]), count })),
      },
      moves,
    );
  });
  return { version: sanitize(version, migrationLabels[kind]), targets };
}

function readSessionMigration(stateRoot) {
  const snapshot = { runId: null, manifest: null, failureReport: null };
  let names;
  try {
    names = fs.readdirSync(ownedPath(stateRoot, migrationDirectory));
  } catch {
    omissions["session migration"] = reasons[0];
    return snapshot;
  }
  if (names.length > entryLimit) {
    omissions["session migration"] = reasons[1];
    return snapshot;
  }
  // Pick the latest owned run, never follow paths supplied by its manifest.
  const runs = names
    .filter((name) => /^session-sqlite-\d{1,16}-[0-9a-f]{8}\.json$/.test(name))
    .toSorted(
      (left, right) =>
        Number(right.split("-")[2]) - Number(left.split("-")[2]) || left.localeCompare(right),
    );
  if (!runs.length) {
    omissions["session migration"] = reasons[0];
    return snapshot;
  }
  snapshot.runId = runs[0].slice(0, -5);
  for (const [kind, suffix] of [
    ["manifest", ".json"],
    ["failureReport", ".failure.json"],
  ]) {
    const raw = readOwned(
      stateRoot,
      path.join(migrationDirectory, `${snapshot.runId}${suffix}`),
      migrationLabels[kind],
      migrationFileLimit,
    );
    if (raw === null) {
      continue;
    }
    try {
      sessionMigrationProjection(raw, kind, snapshot.runId);
      snapshot[kind] = raw;
    } catch {
      omissions[migrationLabels[kind]] = reasons[3];
    }
  }
  return snapshot;
}

function publishedSessionMigration(snapshot, sanitize) {
  const report = { availability: "unavailable", manifest: null, failureReport: null };
  if (!snapshot || snapshot.runId === null) {
    return report;
  }
  if (
    typeof snapshot.runId !== "string" ||
    !/^session-sqlite-\d{1,16}-[0-9a-f]{8}$/.test(snapshot.runId)
  ) {
    omissions["session migration"] = reasons[3];
    return report;
  }
  for (const kind of Object.keys(migrationLabels)) {
    if (snapshot[kind] === null) {
      continue;
    }
    try {
      const projected = sessionMigrationProjection(snapshot[kind], kind, snapshot.runId, sanitize);
      if (Buffer.byteLength(JSON.stringify(projected)) > outputLimit) {
        omissions[migrationLabels[kind]] = reasons[1];
        continue;
      }
      report[kind] = projected;
      report.availability = "captured";
    } catch {
      omissions[migrationLabels[kind]] = reasons[3];
    }
  }
  if (report.availability === "captured") {
    report.runId = sanitize(snapshot.runId, "session migration");
  }
  return report;
}

function armUpgradeProcessCapture() {
  const delegatedDoctor =
    process.argv[2] === "--doctor" &&
    path.basename(process.argv[1] ?? "") === "update-migrated-finalize.worker.js";
  const command = delegatedDoctor ? "doctor" : process.argv[2];
  const artifactRoot = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
  if (!isMainThread || !artifactRoot || !["update", "doctor"].includes(command)) {
    return;
  }
  try {
    let directory = path.dirname(fs.realpathSync(process.argv[1]));
    let version;
    // CLI entrypoints live at the package root or in dist. Do not resolve the
    // version again at exit: an old updater can have replaced its own files.
    for (let depth = 0; depth < 3; depth++) {
      try {
        const raw = readOwned(directory, "package.json", "process identity");
        const manifest = JSON.parse(raw);
        if (manifest?.name === "openclaw") {
          version = manifest.version;
          break;
        }
      } catch {}
      directory = path.dirname(directory);
    }
    if (
      typeof version !== "string" ||
      !/^\d{4}\.\d{1,2}\.\d{1,3}(?:-(?:\d+|(?:alpha|beta)\.\d+))?$/.test(version) ||
      !Number.isFinite(performance.timeOrigin)
    ) {
      return;
    }
    const identity = {
      role:
        command === "update" && process.env.OPENCLAW_UPDATE_POST_CORE === "1"
          ? "post-core"
          : command,
      packageVersion: version,
      pid: process.pid,
      parentPid: process.ppid,
      timeOriginUnixMs: performance.timeOrigin,
    };
    const destination = path.join(artifactRoot, "diagnostics");
    writeReport(
      artifactRoot,
      destination,
      `process-${process.pid}-started.json`,
      { ...identity, event: "started" },
      1024,
    );
    const doctorResultPath =
      command === "doctor"
        ? process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH
        : undefined;
    process.once("exit", (exitCode) => {
      try {
        captureDoctorIpc(artifactRoot, doctorResultPath, exitCode);
      } catch {
        // The parent still owns consumption; observation must not alter Doctor exit.
      }
      try {
        const result = identity.role === "doctor" ? readDoctorResult() : undefined;
        writeReport(
          artifactRoot,
          destination,
          `process-${process.pid}-exited.json`,
          { ...identity, event: "exited", exitCode, ...(result ? { doctorResult: result } : {}) },
          outputLimit,
        );
      } catch {
        // Missing exit evidence stays unknown; never alter the observed process.
      }
    });
  } catch {
    // No argv, environment values, paths, or candidate-provided error text.
  }
}

function armPostCoreCapture() {
  if (
    !isMainThread ||
    process.argv[2] !== "update" ||
    process.env.OPENCLAW_UPDATE_POST_CORE !== "1"
  ) {
    return;
  }
  try {
    const tmp = process.env.TMPDIR;
    const resultPath = process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
    const artifactRoot = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
    if (
      !tmp ||
      !resultPath ||
      !artifactRoot ||
      !path.isAbsolute(tmp) ||
      !path.isAbsolute(resultPath)
    ) {
      return;
    }
    const relative = path.relative(tmp, resultPath);
    if (!/^openclaw-update-post-core-[A-Za-z0-9_-]+\/plugins\.json$/.test(relative)) {
      return;
    }
    ownedPath(tmp, path.dirname(relative));
    if (fs.lstatSync(artifactRoot).isSymbolicLink()) {
      return;
    }
    // The old parent can SIGTERM and delete this file without joining. No signal
    // handler or keepalive: only a complete result at normal exit occupies the slot.
    process.once("exit", (code) => {
      try {
        const raw = readOwned(tmp, relative, "post-core");
        if (raw === null) {
          return;
        }
        const result = JSON.parse(raw);
        postCoreResult(result);
        writeReport(
          artifactRoot,
          path.join(artifactRoot, "diagnostics"),
          "post-core.json",
          { artifactRoot: fs.realpathSync(artifactRoot), childExitCode: code, result },
          inputLimit + 1024,
        );
      } catch {
        // Instrumentation must preserve stdout and the original process outcome.
      }
    });
  } catch {
    // Missing/unsafe context is unavailable evidence, never product failure.
  }
}

async function pluginIdentities(stateRoot, artifactRoot) {
  const unavailable = {
    availability: "unknown",
    evidence: "persisted index + current bytes; not observed loaded modules",
    reader: "SQLite or historical fallback; missing/error is not absence",
    plugins: [],
  };
  const handles = [];
  try {
    // The existing reader opens SQLite read-only. Fence every file it may read;
    // disable its config fallback rather than consulting failed-state CLI/config.
    for (const relative of [
      "state/openclaw.sqlite",
      "state/openclaw.sqlite-wal",
      "state/openclaw.sqlite-shm",
      "state/openclaw.sqlite-journal",
      "plugins/installs.json",
    ]) {
      try {
        const handle = openOwned(stateRoot, relative);
        handles.push(handle);
        if (handle.stat.size > (relative.endsWith(".json") ? indexLimit : 64 * 1024 * 1024)) {
          throw new Error();
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
    assertNativeSqliteObservationSafe(handles, "plugin identity");
    const { readPluginInstallIndex } = await import("../plugin-index-sqlite.mjs");
    const index = readPluginInstallIndex({ stateDir: stateRoot, configPath: null });
    for (const { fd, stat, file } of handles) {
      // SQLite readers update SHM read marks: its cache timestamps are not
      // durable index mutations. Keep file identity checks on every source.
      const matches = file.endsWith("-shm") ? sameFileIdentity : unchangedFile;
      if (!matches(stat, fs.fstatSync(fd)) || !matches(stat, fs.lstatSync(file))) {
        throw new Error();
      }
    }
    if (Buffer.byteLength(JSON.stringify(index)) > indexLimit || !Array.isArray(index.plugins)) {
      throw new Error();
    }
    const plugins = boundedList(index.plugins)
      .map((entry) => {
        const root = entry.rootDir;
        if (typeof root !== "string" || !path.isAbsolute(root)) {
          throw new Error();
        }
        const boundary = [stateRoot, artifactRoot].find(
          (base) =>
            base &&
            !path.relative(base, root).startsWith("..") &&
            !path.isAbsolute(path.relative(base, root)),
        );
        if (!boundary) {
          return { pluginId: entry.pluginId, observation: "root outside owned boundary" };
        }
        const rootRelative = path.relative(boundary, root);
        const recordOwner = entry.installOwnerAmbiguous
          ? null
          : (entry.installOwner ?? entry.pluginId);
        const identity = Object.assign(
          textFields(entry, ["pluginId", "packageVersion", "rootDir", "origin"], (text) => text),
          {
            enabled: typeof entry.enabled === "boolean" ? entry.enabled : null,
            recordOwner,
            recorded: textFields(
              recordOwner === null
                ? undefined
                : (index.installRecords?.[recordOwner] ?? entry.installRecord),
              ["version", "resolvedVersion", "integrity", "npmIntegrity"],
              (text) => text,
            ),
          },
        );
        const fingerprint = (relative, recordedSha256, jsonFields = []) => {
          const bytes = readOwned(
            boundary,
            path.join(rootRelative, relative),
            "plugin identity",
            inputLimit,
            true,
          );
          const sha256 = bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
          const result = {
            path: relative,
            sha256,
            recordedSha256: recordedSha256 ?? null,
            matchesRecorded: sha256 && recordedSha256 ? sha256 === recordedSha256 : null,
            observation: bytes === null ? "missing or unsafe current artifact" : "current bytes",
          };
          if (bytes !== null && jsonFields.length) {
            try {
              Object.assign(
                result,
                textFields(JSON.parse(bytes.toString("utf8")), jsonFields, (text) => text),
              );
            } catch {
              result.observation = "invalid JSON; identity unavailable";
            }
          }
          return result;
        };
        const packagePathMatches = entry.packageJson?.path === "package.json";
        const manifestPathMatches = entry.manifestPath === path.join(root, "openclaw.plugin.json");
        identity.package = fingerprint(
          "package.json",
          packagePathMatches ? entry.packageJson.hash : undefined,
          ["name", "version"],
        );
        identity.package.recordedPathMatches = entry.packageJson?.path ? packagePathMatches : null;
        identity.manifest = fingerprint(
          "openclaw.plugin.json",
          manifestPathMatches ? entry.manifestHash : undefined,
          ["id", "version"],
        );
        identity.manifest.recordedPathMatches = entry.manifestPath ? manifestPathMatches : null;
        identity.versionMatchesIndex =
          identity.package.version && entry.packageVersion
            ? identity.package.version === entry.packageVersion
            : null;
        identity.versionMatchesRecord =
          identity.package.version &&
          (identity.recorded.resolvedVersion ?? identity.recorded.version)
            ? identity.package.version ===
              (identity.recorded.resolvedVersion ?? identity.recorded.version)
            : null;
        identity.doctor = {
          path: null,
          sha256: null,
          recordedSha256: entry.doctorContractHash ?? null,
          matchesRecorded: null,
          observation: "no current artifact found",
        };
        // Packaged resolver order from src/plugins/doctor-contract-artifact.ts:
        // basename, JS before TS extension, then root before dist. Never import code.
        for (const basename of ["doctor-contract-api", "contract-api"]) {
          for (const extension of [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]) {
            for (const dir of ["", "dist"]) {
              const relative = path.join(dir, `${basename}${extension}`);
              try {
                ownedPath(boundary, path.join(rootRelative, relative));
              } catch (error) {
                if (error.code === "ENOENT") {
                  continue;
                }
                Object.assign(identity.doctor, {
                  path: relative,
                  observation: "unsafe artifact; selection unavailable",
                });
                return identity;
              }
              identity.doctor = fingerprint(relative, entry.doctorContractHash);
              return identity;
            }
          }
        }
        return entry.doctorContractHash ? identity : null;
      })
      .filter(Boolean);
    return { ...unavailable, availability: plugins.length ? "observed" : "unknown", plugins };
  } catch {
    omissions["plugin identity"] ??= reasons[3];
    return unavailable;
  } finally {
    for (const { fd } of handles) {
      fs.closeSync(fd);
    }
  }
}

function phaseResult(phase, exitStatus, signal) {
  if (
    typeof phase !== "string" ||
    !/^[a-z0-9-]{1,80}$/.test(phase) ||
    !Number.isInteger(exitStatus) ||
    exitStatus < 0 ||
    exitStatus > 255 ||
    ![null, "SIGHUP", "SIGINT", "SIGTERM"].includes(signal)
  ) {
    throw new Error();
  }
  return { phase, outcome: "failed", exitStatus, signal };
}

function childExit(event) {
  if (
    !(
      event?.code === null ||
      (Number.isInteger(event?.code) && event.code >= 0 && event.code <= 255)
    ) ||
    !(
      event.signal === null ||
      (typeof event.signal === "string" && /^SIG[A-Z0-9]{1,16}$/.test(event.signal))
    ) ||
    typeof event.at !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.at)
  ) {
    throw new Error();
  }
  return { code: event.code, signal: event.signal, at: event.at };
}

function environmentKeys(keys = []) {
  if (
    !Array.isArray(keys) ||
    keys.length > 128 ||
    keys.some((key) => typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key))
  ) {
    throw new Error();
  }
  return [...new Set(keys)].toSorted((left, right) => left.localeCompare(right));
}

function writeReport(artifactRoot, directory, name, report, limit) {
  if (fs.lstatSync(artifactRoot).isSymbolicLink()) {
    throw new Error();
  }
  fs.mkdirSync(directory, { recursive: true });
  if (fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error();
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > limit) {
    throw new Error();
  }
  // Root-managed containers must leave the private snapshot readable by the
  // host runner. Its directory stays outside the workflow's upload roots.
  // Publish the complete file exclusively; partial writes cannot take the
  // post-core slot from a later CLI respawn with a complete result.
  const temporary = path.join(directory, `.${name}.${process.pid}.tmp`);
  const fd = fs.openSync(temporary, "wx", 0o644);
  try {
    fs.writeFileSync(fd, serialized);
    fs.linkSync(temporary, path.join(directory, name));
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(temporary);
  }
}

function integrityObservation(value) {
  if (
    typeof value?.readerId !== "string" ||
    !/^[1-9]\d{0,15}:[1-9]\d{0,15}$/.test(value.readerId) ||
    !value.readerId.split(":").every((part) => Number.isSafeInteger(Number(part))) ||
    !Number.isFinite(value.timeOriginUnixMs) ||
    value.timeOriginUnixMs <= 0 ||
    !["reader-started", "reader-settled"].includes(value.event) ||
    !["baseline", "retained", "restored", "transaction"].includes(value.phase) ||
    !Number.isFinite(value.budgetMs) ||
    value.budgetMs <= 0
  ) {
    throw new Error();
  }
  const result = {
    readerId: value.readerId,
    timeOriginUnixMs: value.timeOriginUnixMs,
    event: value.event,
    phase: value.phase,
    budgetMs: value.budgetMs,
  };
  if (value.event === "reader-settled") {
    if (
      !["completed", "failed", "timed-out"].includes(value.outcome) ||
      !Number.isFinite(value.elapsedMs) ||
      value.elapsedMs < 0 ||
      !Number.isSafeInteger(value.pendingIo) ||
      value.pendingIo < 0
    ) {
      throw new Error();
    }
    Object.assign(result, {
      outcome: value.outcome,
      elapsedMs: value.elapsedMs,
      pendingIo: value.pendingIo,
    });
  } else if (
    value.outcome !== undefined ||
    value.elapsedMs !== undefined ||
    value.pendingIo !== undefined
  ) {
    throw new Error();
  }
  return result;
}

function integrityProjection(value) {
  if (
    typeof value?.baselineVersion !== "string" ||
    !/^\d{4}\.\d{1,2}\.\d{1,3}(?:-(?:\d+|(?:alpha|beta)\.\d+))?$/.test(value.baselineVersion)
  ) {
    throw new Error();
  }
  const processes = boundedList(value.processes);
  for (const started of processes) {
    if (
      started?.role !== "update" ||
      started.event !== "started" ||
      started.packageVersion !== value.baselineVersion ||
      !Number.isSafeInteger(started.pid) ||
      started.pid <= 0 ||
      !Number.isFinite(started.timeOriginUnixMs) ||
      started.timeOriginUnixMs <= 0
    ) {
      throw new Error();
    }
  }
  const observations = boundedList(value.observations).map((observation) => {
    const { timeOriginUnixMs, ...projected } = integrityObservation(observation);
    const pid = Number(projected.readerId.split(":")[0]);
    if (
      processes.filter(
        (started) => started.pid === pid && started.timeOriginUnixMs === timeOriginUnixMs,
      ).length !== 1
    ) {
      throw new Error();
    }
    return projected;
  });
  if (!observations.length) {
    throw new Error();
  }
  const report = { availability: "captured", observations };
  if (Buffer.byteLength(JSON.stringify(report)) > outputLimit) {
    omissions["package integrity"] = reasons[1];
    throw new Error();
  }
  return report;
}

function capturePackageIntegrity(observationRoot) {
  const unavailable = { availability: "unavailable" };
  try {
    const raw = readOwned(
      process.env.HOME,
      path.join("openclaw-upgrade-survivor", "gateway.jsonl"),
      "package integrity",
    );
    if (raw === null) {
      return unavailable;
    }
    const baselineVersion = process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION;
    const processes = [];
    // Only the fresh update invocation's baseline receipts can bind a log event.
    for (const name of boundedList(fs.readdirSync(ownedPath(observationRoot, "diagnostics")))) {
      const match = /^process-(\d+)-started\.json$/.exec(name);
      if (!match) {
        continue;
      }
      const started = JSON.parse(
        readOwned(observationRoot, `diagnostics/${name}`, "package integrity"),
      );
      if (started?.role !== "update" || started.packageVersion !== baselineVersion) {
        continue;
      }
      if (started.pid !== Number(match[1])) {
        throw new Error();
      }
      processes.push({
        role: started.role,
        event: started.event,
        packageVersion: started.packageVersion,
        pid: started.pid,
        timeOriginUnixMs: started.timeOriginUnixMs,
      });
    }
    const observations = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const entry = JSON.parse(line);
      if (typeof entry?.[0] !== "string" || !entry[0].startsWith("{")) {
        continue;
      }
      let subsystem;
      try {
        subsystem = JSON.parse(entry[0])?.subsystem;
      } catch {
        continue;
      }
      if (subsystem !== "update/package-integrity") {
        continue;
      }
      if (
        entry._meta?.logLevelName !== "DEBUG" ||
        entry[2] !== entry[1]?.event ||
        entry.message !== entry[2]
      ) {
        throw new Error();
      }
      observations.push(integrityObservation(entry[1]));
      boundedList(observations);
    }
    const snapshot = {
      availability: "captured",
      baselineVersion,
      processes,
      observations: observations.filter((observation) =>
        processes.some(
          (started) =>
            started.pid === Number(observation.readerId.split(":")[0]) &&
            started.timeOriginUnixMs === observation.timeOriginUnixMs,
        ),
      ),
    };
    integrityProjection(snapshot);
    if (Buffer.byteLength(JSON.stringify(snapshot)) > outputLimit) {
      omissions["package integrity"] = reasons[1];
      throw new Error();
    }
    return snapshot;
  } catch {
    omissions["package integrity"] ??= reasons[3];
    return unavailable;
  }
}

async function capture(artifactRoot, phase, exitStatus, signal = "", observationRoot = "") {
  const report = {
    ...phaseResult(phase, Number(exitStatus), signal || null),
    logs: {},
    service: {},
    config: {},
    omissions,
  };
  for (const name of logNames) {
    report.logs[name] =
      name === "gateway-restart.log"
        ? readOwned(process.env.OPENCLAW_STATE_DIR, "logs/gateway-restart.log", name)
        : readOwned(artifactRoot, name, name);
  }
  const stateRoot = process.env.OPENCLAW_STATE_DIR;
  report.packageIntegrity = capturePackageIntegrity(observationRoot);
  report.pluginIdentity = await pluginIdentities(stateRoot, artifactRoot);
  report.migration = captureMigrationEvidence(stateRoot, artifactRoot, observationRoot);
  report.postCore = {
    availability: "unavailable",
    reason: "No complete exit snapshot; original outcome unknown",
  };
  try {
    const snapshot = readPostCoreSnapshot(observationRoot || artifactRoot);
    if (snapshot !== null) {
      report.postCore = { availability: "captured", ...snapshot };
    }
  } catch {
    omissions["post-core"] = reasons[3];
  }
  report.successfulUpdateCheck = { availability: "unavailable" };
  if (observationRoot) {
    try {
      const raw = readOwned(
        observationRoot,
        "diagnostics/successful-update-check.json",
        "successful update check",
      );
      if (raw !== null) {
        const receipt = JSON.parse(raw);
        if (receipt.artifactRoot !== fs.realpathSync(observationRoot)) {
          throw new Error();
        }
        report.successfulUpdateCheck = successfulUpdateCheck(receipt);
      }
    } catch {
      omissions["successful update check"] = reasons[3];
    }
  }
  report.doctorResults = [];
  try {
    report.doctorResults = readDoctorResults(observationRoot || artifactRoot);
  } catch {
    // Missing, interrupted, or mismatched observations remain unknown.
  }
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (stateRoot && configPath) {
    const config = readOwned(stateRoot, path.relative(stateRoot, configPath), "config");
    if (config !== null) {
      report.config.sha256 = createHash("sha256").update(config).digest("hex");
    }
  }
  const unit = readOwned(
    process.env.HOME,
    ".config/systemd/user/openclaw-gateway.service",
    "service unit",
  );
  if (unit !== null) {
    const lines = unit.split("\n");
    for (const field of ["ExecStart", "WorkingDirectory"]) {
      report.service[field] =
        lines.findLast((line) => line.startsWith(`${field}=`))?.slice(field.length + 1) ?? null;
    }
    report.service.environmentKeys = environmentKeys(
      lines.flatMap((line) => {
        const match = /^Environment="?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
        return match ? [match[1]] : [];
      }),
    );
  }
  // Never follow EnvironmentFile paths supplied by a service unit.
  const envFile = readOwned(stateRoot, "gateway.systemd.env", "service environment");
  if (envFile !== null) {
    report.service.environmentFileKeys = environmentKeys(
      [...envFile.matchAll(/^(?:export )?([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((match) => match[1]),
    );
  }
  const observed = readOwned(artifactRoot, "systemctl-shim-gateway.log.exit.json", "child exit");
  if (observed !== null) {
    try {
      const value = JSON.parse(observed);
      report.service.childExits = [childExit(value.first), childExit(value.last)];
      report.service.supervisorWorkingDirectory = value.cwd;
    } catch {
      omissions["child exit"] = reasons[3];
    }
  }
  report.sessionMigration = readSessionMigration(stateRoot);
  if (Buffer.byteLength(`${JSON.stringify(report, null, 2)}\n`) > privateLimit) {
    report.sessionMigration = { runId: null, manifest: null, failureReport: null };
    omissions["session migration"] = reasons[1];
  }
  writeReport(
    artifactRoot,
    path.join(artifactRoot, "diagnostics"),
    "raw.json",
    report,
    privateLimit,
  );
}

function publishedPostCore(snapshot, sanitize) {
  if (snapshot?.availability === "captured") {
    try {
      const code = snapshot.childExitCode;
      if (!Number.isInteger(code) || code < 0 || code > 255) {
        throw new Error();
      }
      return {
        availability: "captured",
        childExitCode: code,
        result: postCoreResult(snapshot.result, sanitize),
      };
    } catch {
      omissions["post-core"] = reasons[3];
    }
  }
  return {
    availability: "unavailable",
    reason: "No complete exit snapshot; original outcome unknown",
  };
}

function publishedSuccessSummary(artifactRoot, sanitize) {
  const raw = readOwned(artifactRoot, "summary.json", "summary");
  if (raw === null) {
    throw new Error();
  }
  const snapshot = JSON.parse(raw);
  if (snapshot.status !== "passed") {
    throw new Error();
  }
  const pluginPolicy = publishedPluginPolicy(snapshot, { sanitize, boundedList });
  for (const value of [
    snapshot.baseline?.spec,
    snapshot.baseline?.version,
    snapshot.candidate?.kind,
    snapshot.candidate?.version,
    snapshot.scenario,
    snapshot.installedVersion,
    snapshot.candidateInstallMode,
    snapshot.updateRestartMode,
    snapshot.updateOutcome,
  ]) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error();
    }
  }
  const timings = {};
  for (const key of [
    "startupSeconds",
    "updateRestartSeconds",
    "idempotenceSeconds",
    "healthzSeconds",
    "readyzSeconds",
    "statusSeconds",
  ]) {
    const value = snapshot.timings?.[key] ?? null;
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error();
    }
    timings[key] = value;
  }
  let baselineCompanion = null;
  const companion = snapshot.baselineCompanion;
  if (companion !== null && companion !== undefined) {
    if (
      !["@openclaw/discord", "@openclaw/msteams"].includes(companion.package) ||
      typeof companion.version !== "string" ||
      !/^\d{4}\.\d{1,2}\.\d{1,3}(?:-(?:\d+|(?:alpha|beta)\.\d+))?$/.test(companion.version) ||
      !["available", "unavailable"].includes(companion.availability) ||
      (companion.availability === "available"
        ? companion.reason !== null
        : typeof companion.reason !== "string" ||
          !companion.reason ||
          companion.reason.length > 200)
    ) {
      throw new Error();
    }
    baselineCompanion = {
      package: sanitize(companion.package, "baseline companion"),
      version: sanitize(companion.version, "baseline companion"),
      availability: companion.availability,
      reason: sanitize(companion.reason, "baseline companion"),
    };
  }
  return {
    status: "passed",
    baseline: textFields(snapshot.baseline, ["spec", "version"], sanitize),
    candidate: textFields(snapshot.candidate, ["kind", "version"], sanitize),
    baselineCompanion,
    ...textFields(
      snapshot,
      [
        "scenario",
        "installedVersion",
        "candidateInstallMode",
        "updateRestartMode",
        "updateOutcome",
      ],
      sanitize,
    ),
    updateRecovery: sanitize(snapshot.updateRecovery, "summary"),
    updateRestartSource: sanitize(snapshot.updateRestartSource, "summary"),
    firstHopPostCore: publishedPostCore(snapshot.firstHopPostCore, sanitize),
    backupRollback: publishedBackupRollback(snapshot, { sanitize, boundedList, textFields }),
    ...(pluginPolicy ? { pluginPolicy } : {}),
    timings,
    phases: boundedList(snapshot.phases).map((event) => {
      if (
        !["started", "passed", "failed"].includes(event?.status) ||
        typeof event.phase !== "string" ||
        !/^[a-z0-9-]{1,80}$/.test(event.phase) ||
        typeof event.at !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.at)
      ) {
        throw new Error();
      }
      return { phase: sanitize(event.phase, "phase"), status: event.status, at: event.at };
    }),
    logs: Object.fromEntries(
      [
        "update.json",
        "repair.json",
        "recovery-update.json",
        ...(snapshot.scenario === "custom-plugin-siblings" ? siblingRefusalLogs : []),
        ...(snapshot.scenario === "legacy-operator-state" ? backupRollbackLogs : []),
        ...(pluginPolicy ? pluginPolicyLogs : []),
        ...(snapshot.scenario === "workshop-doctor-recovery"
          ? [
              "workshop-doctor-recovery.json",
              "baseline-doctor.log",
              "doctor.log",
              "physical-baseline-update.json",
              "physical-baseline-refusal.json",
              "physical-baseline-restoration.json",
              "physical-candidate-doctor.log",
              "physical-candidate-repair.json",
            ]
          : []),
        ...(snapshot.scenario === "update-report-recovery"
          ? [
              "update-report-recovery.json",
              "update-report-baseline.json",
              "update-report-retry-status.log",
              "update-report-pending-status.log",
              "update-report-retry.gh.jsonl",
              "update-report-pending.gh.jsonl",
            ]
          : []),
        ...(snapshot.scenario === "dreaming-cron-doctor" ? ["dreaming-cron-proof.json"] : []),
        ...(snapshot.scenario === "legacy-operator-state" &&
        snapshot.updateRestartMode === "manual" &&
        ["2026.9.3", "2026.9.4"].includes(snapshot.baseline.version)
          ? ["legacy-operator-cron-history-proof.json"]
          : []),
        ...(snapshot.scenario === "legacy-operator-state" &&
        (snapshot.baseline.version === "2026.9.6" ||
          (snapshot.updateRestartMode === "manual" &&
            ["2026.9.3", "2026.9.4"].includes(snapshot.baseline.version)))
          ? [
              "legacy-operator-post-update-cron-history.json",
              "legacy-operator-candidate-cron-history.json",
            ]
          : []),
        ...(snapshot.scenario === "legacy-operator-state" &&
        snapshot.updateRestartMode === "manual" &&
        snapshot.baseline.version === "2026.9.4"
          ? restoredIndexLogs
          : []),
      ].map((name) => [name, sanitize(readOwned(artifactRoot, name, name), name)]),
    ),
    omissions,
  };
}

export function publishDiagnostics(
  artifactRoot,
  destination,
  redactSensitiveText,
  outcome = "failed",
) {
  for (const label of Object.keys(omissions)) {
    delete omissions[label];
  }
  if (outcome === "passed") {
    writeReport(
      artifactRoot,
      destination,
      "summary.json",
      publishedSuccessSummary(artifactRoot, sanitize),
      publicLimit,
    );
    return;
  }
  if (outcome !== "failed") {
    throw new Error();
  }
  const raw = readOwned(artifactRoot, "diagnostics/raw.json", "private snapshot", privateLimit);
  if (raw === null) {
    throw new Error();
  }
  const snapshot = JSON.parse(raw);
  const report = {
    ...phaseResult(snapshot.phase, snapshot.exitStatus, snapshot.signal),
    limits: {
      inputBytesPerFile: inputLimit,
      outputBytesPerLog: outputLimit,
      reportBytes: publicLimit,
      entriesPerCollection: entryLimit,
      indexJsonBytes: indexLimit,
      indexSourceBytesPerFile: 64 * 1024 * 1024,
      migrationBytesPerFile: migrationFileLimit,
    },
    logs: {},
    service: {},
    config: {},
    omissions,
  };
  // Re-project the allowlist: the container cannot add upload fields or supply
  // arbitrary omission text. Redact every permitted free-text field on the host.
  for (const label of [
    ...logNames,
    "config",
    "service unit",
    "service environment",
    "child exit",
    "post-core",
    "successful update check",
    "successful update plugins",
    "plugin identity",
    "package integrity",
    ...["doctor", "sessions", "archives", "sibling"].map((section) => `migration-${section}`),
    "session migration",
    ...Object.values(migrationLabels),
  ]) {
    if (reasons.includes(snapshot.omissions?.[label])) {
      omissions[label] = snapshot.omissions[label];
    }
  }
  function sanitize(text, label) {
    if (text === null || text === undefined) {
      return null;
    }
    if (typeof text !== "string" || Buffer.byteLength(text) > inputLimit) {
      throw new Error();
    }
    const redacted = redactSensitiveText(text, { mode: "tools" });
    // Keep the last completed startup spans, after redacting the whole input.
    const tail = label === "missing-load-path/baseline-gateway.log";
    const lines = redacted.split(/(?<=\n)/u);
    if (tail) {
      lines.reverse();
    }
    let result = "";
    for (const line of lines) {
      const next = tail ? line + result : result + line;
      if (Buffer.byteLength(JSON.stringify(next)) > outputLimit) {
        omissions[label] = "redacted output truncated at a complete line (16 KiB)";
        break;
      }
      result = next;
    }
    return result;
  }
  for (const name of logNames) {
    report.logs[name] = sanitize(snapshot.logs?.[name], name);
  }
  for (const field of ["ExecStart", "WorkingDirectory", "supervisorWorkingDirectory"]) {
    report.service[field] = sanitize(snapshot.service?.[field], field);
  }
  for (const field of ["environmentKeys", "environmentFileKeys"]) {
    report.service[field] = environmentKeys(snapshot.service?.[field]);
  }
  if (snapshot.service?.childExits !== undefined) {
    if (!Array.isArray(snapshot.service.childExits) || snapshot.service.childExits.length !== 2) {
      throw new Error();
    }
    report.service.childExits = snapshot.service.childExits.map(childExit);
  }
  if (snapshot.config?.sha256 !== undefined) {
    if (
      typeof snapshot.config.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(snapshot.config.sha256)
    ) {
      throw new Error();
    }
    report.config.sha256 = snapshot.config.sha256;
  }
  report.postCore = publishedPostCore(snapshot.postCore, sanitize);
  report.packageIntegrity = { availability: "unavailable" };
  if (snapshot.packageIntegrity?.availability === "captured") {
    try {
      report.packageIntegrity = integrityProjection(snapshot.packageIntegrity);
    } catch {
      omissions["package integrity"] ??= reasons[3];
    }
  }
  report.successfulUpdateCheck = successfulUpdateCheck(snapshot.successfulUpdateCheck, sanitize);
  report.sessionMigration = publishedSessionMigration(snapshot.sessionMigration, sanitize);
  report.doctorResults = { availability: "unknown", observations: [] };
  try {
    const observations = boundedList(snapshot.doctorResults).map((pair) =>
      doctorObservation(pair, sanitize),
    );
    if (observations.length > 0) {
      report.doctorResults = { availability: "captured", observations };
    }
  } catch {
    // Do not promote a partial or unbound receipt into a reported Doctor outcome.
  }
  report.pluginIdentity = {
    availability: "unknown",
    evidence: "persisted index + current bytes; not observed loaded modules",
    reader: "SQLite or historical fallback; missing/error is not absence",
    plugins: [],
  };
  if (snapshot.pluginIdentity?.availability === "observed") {
    try {
      const plugins = boundedList(snapshot.pluginIdentity.plugins).map((entry) => {
        const identity = textFields(
          entry,
          ["pluginId", "packageVersion", "rootDir", "origin", "observation"],
          sanitize,
        );
        identity.recordOwner =
          entry.recordOwner == null ? null : sanitize(entry.recordOwner, "plugin identity");
        for (const key of ["enabled", "versionMatchesIndex", "versionMatchesRecord"]) {
          identity[key] = typeof entry[key] === "boolean" ? entry[key] : null;
        }
        identity.recorded = textFields(
          entry.recorded,
          ["version", "resolvedVersion", "integrity", "npmIntegrity"],
          sanitize,
        );
        for (const key of ["package", "manifest", "doctor"]) {
          const value = entry[key];
          identity[key] = textFields(value, ["id", "name", "version", "observation"], sanitize);
          identity[key].path = value?.path == null ? null : sanitize(value.path, "plugin identity");
          for (const field of ["sha256", "recordedSha256"]) {
            identity[key][field] =
              typeof value?.[field] === "string" && /^[a-f0-9]{64}$/.test(value[field])
                ? value[field]
                : null;
          }
          identity[key].matchesRecorded =
            typeof value?.matchesRecorded === "boolean" ? value.matchesRecorded : null;
          identity[key].recordedPathMatches =
            typeof value?.recordedPathMatches === "boolean" ? value.recordedPathMatches : null;
        }
        return identity;
      });
      report.pluginIdentity = { ...report.pluginIdentity, availability: "observed", plugins };
    } catch {
      omissions["plugin identity"] = reasons[3];
    }
  }
  report.migration = Object.fromEntries(
    ["doctor", "sessions", "archives", "sibling"].map((section) => {
      try {
        const value = snapshot.migration?.[section];
        if (value?.availability !== "captured") {
          throw new Error();
        }
        return [
          section,
          { availability: "captured", ...migrationProjection(section, value, sanitize) },
        ];
      } catch {
        omissions[`migration-${section}`] ??= reasons[3];
        return [section, { availability: "unavailable" }];
      }
    }),
  );
  writeReport(artifactRoot, destination, "failure.json", report, publicLimit);
  if (Object.keys(omissions).length) {
    process.stderr.write(
      "Upgrade survivor diagnostics: some inputs omitted; see failure.json omissions.\n",
    );
  }
}

if (import.meta.main) {
  try {
    const [mode, artifactRoot, phase, exitStatus, signal, observationRoot] = process.argv.slice(2);
    if (mode !== "capture") {
      throw new Error();
    }
    await capture(artifactRoot, phase, exitStatus, signal, observationRoot);
  } catch {
    process.stderr.write("Upgrade survivor diagnostics missing: safe capture failed.\n");
    process.exitCode = 1;
  }
} else {
  armUpgradeProcessCapture();
  armPostCoreCapture();
}
