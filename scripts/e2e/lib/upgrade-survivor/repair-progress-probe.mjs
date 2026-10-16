// Opt-in Docker fixture: hold native integrity work, never synthesize product output.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import sqlite from "node:sqlite";
import { isMainThread, threadId } from "node:worker_threads";
import {
  readWorkerCellPackageIdentity,
  assertWorkerCellPackageIdentity,
} from "./worker-cell-package.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value) + "\n", { flag: "wx" });

export function observeRepairProgressIntegrity(onIntegrity) {
  const NativeDatabase = sqlite.DatabaseSync;
  sqlite.DatabaseSync = class extends NativeDatabase {
    prepare(sql, ...args) {
      const statement = super.prepare(sql, ...args);
      if (/^PRAGMA\s+integrity_check\s*;?$/iu.test(sql.trim())) {
        onIntegrity();
      }
      return statement;
    }
  };
  syncBuiltinESMExports();
  return () => {
    sqlite.DatabaseSync = NativeDatabase;
    syncBuiltinESMExports();
  };
}

// Observe only native phase sends; preserve their payload, callback, return and errors.
export function observeRepairProgressPhases(onPhase) {
  const send = process.send?.bind(process);
  if (!send) {
    return () => {};
  }
  process.send = function (message, ...args) {
    const result = Reflect.apply(send, this, [message, ...args]);
    if (message?.type === "phase" && ["opening", "checking", "closing"].includes(message.phase)) {
      onPhase(message.phase);
    }
    return result;
  };
  return () => {
    process.send = send;
  };
}

export function resolveRepairProgressEntrypoint(entry, identities, observe = () => {}) {
  observe({ gate: "package-not-found" });
  let root = path.dirname(entry);
  for (let depth = 0; depth < 8; depth++, root = path.dirname(root)) {
    const manifest = path.join(root, "package.json");
    const build = path.join(root, "dist/build-info.json");
    if (!fs.existsSync(manifest) || !fs.existsSync(build)) {
      continue;
    }
    if (readJson(manifest).name !== "openclaw") {
      continue;
    }
    const relative = path.relative(root, entry).split(path.sep).join("/");
    // Lifecycle scripts inherit NODE_OPTIONS during npm staging, but are not
    // runtime entries in the frozen application inventory. Never instrument them.
    if (relative !== "openclaw.mjs" && !relative.startsWith("dist/")) {
      observe({ gate: "lifecycle-entry" });
      return undefined;
    }
    const role =
      relative === "dist/infra/sqlite-integrity.worker.js"
        ? "integrity"
        : relative === "dist/infra/update-migrated-finalize.worker.js"
          ? "finalizer"
          : relative === "openclaw.mjs"
            ? "launcher"
            : "runtime";
    const expected = identities.find(
      (candidate) =>
        candidate.files["package.json"].sha256 === hash(fs.readFileSync(manifest)) &&
        candidate.files["dist/build-info.json"].sha256 === hash(fs.readFileSync(build)),
    );
    // npm and the published driver's code are not part of the candidate probe.
    observe({
      role,
      identityMatched: Boolean(expected),
      gate: expected ? "entry-check" : "identity-mismatch",
    });
    if (!expected) {
      return undefined;
    }
    const entryHash = hash(fs.readFileSync(entry));
    const entryHashMatched = entryHash === expected.files[relative]?.sha256;
    observe({ entryHashMatched, gate: entryHashMatched ? "identity-admitted" : "entry-mismatch" });
    assert.equal(entryHash, expected.files[relative]?.sha256);
    const identity = {
      root,
      entry: relative,
      build: expected.buildInfo,
      payload: hash(JSON.stringify(expected)),
    };
    return { identity, expected };
  }
  return undefined;
}

function installProbe() {
  const directory = process.env.OPENCLAW_REPAIR_PROGRESS_PROBE;
  if (!directory) {
    return;
  }
  assert.equal(process.platform, "linux");
  assert(fs.existsSync("/.dockerenv"), "Progress probe requires disposable Docker state");
  assert.equal(os.userInfo().homedir, "/home/appuser");
  const doctor = process.argv.includes("doctor") || process.argv.includes("--doctor");
  const observation = {
    pid: process.pid,
    ppid: process.ppid,
    threadId,
    role: isMainThread && doctor ? "doctor" : "other",
    preloadPresent: (process.env.NODE_OPTIONS ?? "").includes(import.meta.url),
    selectorPresent: Boolean(directory),
    identityMatched: null,
    entryHashMatched: null,
    gate: "loaded",
    nativePhases: { opening: 0, checking: 0, closing: 0 },
  };
  const record = (facts = {}) => {
    Object.assign(observation, facts);
    if (isMainThread && doctor) {
      observation.role = "doctor";
    }
    try {
      // Never add rejected processes to process-*.json: those records own the
      // original ancestry gate. A killed partial diagnostic remains unknown.
      fs.writeFileSync(
        path.join(directory, `probe-${process.pid}-${threadId}.json`),
        JSON.stringify(observation) + "\n",
      );
    } catch {
      // Observation failure must not change the native check or its hold policy.
    }
  };
  record();
  const fixture = readJson(path.join(directory, "fixture.json"));
  const entry =
    process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]);
  if (!entry) {
    record({ gate: "no-entry" });
    return;
  }
  const resolved = resolveRepairProgressEntrypoint(entry, fixture.identities, record);
  if (!resolved) {
    return;
  }
  const { identity, expected } = resolved;
  if (isMainThread && doctor) {
    record({ gate: "doctor-package-check" });
    assertWorkerCellPackageIdentity(readWorkerCellPackageIdentity(identity.root), expected);
    record({ gate: "identity-admitted" });
    const statfs = fs.statfsSync;
    // Only the real Doctor contribution receives the synthetic low-space fact;
    // updater admission and every actual filesystem write remain unchanged.
    fs.statfsSync = (...args) => {
      const stats = statfs(...args);
      if (!(new Error().stack ?? "").includes("collectDiskSpaceWarnings")) {
        return stats;
      }
      const blocks = Math.floor((50 * 1024 * 1024) / Number(stats.bsize));
      stats.bavail = typeof stats.bavail === "bigint" ? BigInt(blocks) : blocks;
      return stats;
    };
  }
  if (isMainThread) {
    writeJson(path.join(directory, "process-" + process.pid + ".json"), {
      pid: process.pid,
      ppid: process.ppid,
      identity,
      doctor,
      migrated:
        identity.entry === "dist/infra/update-migrated-finalize.worker.js" &&
        process.argv.length === 2,
    });
  }
  if (fixture.quiet) {
    const interval = globalThis.setInterval;
    globalThis.setInterval = (callback, delay, ...args) => {
      if (
        delay !== 10_000 ||
        !Function.prototype.toString
          .call(callback)
          .includes("SQLite integrity check still running:")
      ) {
        return interval(callback, delay, ...args);
      }
      const callbackSha256 = hash(Function.prototype.toString.call(callback));
      return interval(
        function (...values) {
          Reflect.apply(callback, this, values);
          const heldFile = path.join(directory, "held.json");
          if (!fs.existsSync(heldFile) || fs.existsSync(path.join(directory, "heartbeat.json"))) {
            return;
          }
          const held = readJson(heldFile);
          if (!held.ancestors.some((ancestor) => ancestor.pid === process.pid)) {
            return;
          }
          // Observe the real producer callback even when its logger correctly emits
          // nothing. Release native work only after that callback actually ran.
          writeJson(path.join(directory, "heartbeat.json"), {
            pid: process.pid,
            at: Date.now(),
            callbackSha256,
            identity,
          });
          const gate = fs.openSync(path.join(directory, "release.fifo"), "w");
          try {
            fs.writeSync(gate, Buffer.from([1]));
          } finally {
            fs.closeSync(gate);
          }
        },
        delay,
        ...args,
      );
    };
  }
  if (identity.entry !== "dist/infra/sqlite-integrity.worker.js") {
    record({ gate: "not-integrity" });
    return;
  }
  // Arm before ancestry decisions so an intact but refused worker still reports
  // its real native phases. This never creates a phase or changes the hold gate.
  observeRepairProgressPhases((phase) => {
    observation.nativePhases[phase] = Math.min(65_535, observation.nativePhases[phase] + 1);
    record();
  });
  const ancestors = [];
  for (let pid = process.ppid, depth = 0; pid > 1 && depth < 16; depth++) {
    const file = path.join(directory, "process-" + pid + ".json");
    if (!fs.existsSync(file)) {
      break;
    }
    const ancestor = readJson(file);
    ancestors.push(ancestor);
    pid = ancestor.ppid;
  }
  if (!ancestors.some((ancestor) => ancestor.doctor)) {
    record({ gate: "doctor-ancestor-missing" });
    return;
  }
  if (fixture.migrated && !ancestors.some((ancestor) => ancestor.migrated)) {
    record({ gate: "finalizer-ancestor-missing" });
    return;
  }
  record({ gate: "hold-armed" });
  observeRepairProgressIntegrity(() => {
    record({ gate: "integrity-observed" });
    try {
      writeJson(path.join(directory, "held.json"), {
        pid: process.pid,
        identity,
        ancestors,
        at: Date.now(),
      });
    } catch (error) {
      if (error.code === "EEXIST") {
        record({ gate: "already-held" });
        return;
      }
      throw error;
    }
    record({ gate: "held" });
    // The worker already flushed its real checking phase. The real Doctor's
    // heartbeat must traverse its actual parents before the harness releases us.
    const gate = fs.openSync(path.join(directory, "release.fifo"), "r");
    try {
      const byte = Buffer.alloc(1);
      assert.equal(fs.readSync(gate, byte, 0, 1, null), 1);
      assert.equal(byte[0], 1);
    } finally {
      fs.closeSync(gate);
    }
    writeJson(path.join(directory, "released.json"), { pid: process.pid, at: Date.now() });
    record({ gate: "released" });
  });
}
installProbe();
