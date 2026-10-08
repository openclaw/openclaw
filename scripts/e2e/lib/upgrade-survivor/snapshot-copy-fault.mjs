// One producer-bound fault implementation for packaged cells and isolated source proofs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import sqlite from "node:sqlite";
import { threadId } from "node:worker_threads";
import {
  observeSnapshotAllocations,
  observeSnapshotWorkerRequests,
  snapshotFailure,
  snapshotFsPath,
} from "./snapshot-capture-binding.mjs";
import { createSnapshotAcquisitionRecorder } from "./snapshot-cleanup-evidence.mjs";

export const snapshotCopyRefusal = "SQLite artifact-preserving copy and cleanup failed";
const denial = "snapshot cleanup refusal fixture";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const write = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });

function family(source) {
  return Object.fromEntries(
    ["", "-wal", "-shm", "-journal"].flatMap((suffix) => {
      const file = source + suffix;
      return fs.existsSync(file) ? [[suffix, hash(fs.readFileSync(file))]] : [];
    }),
  );
}

export function observeSnapshotNativeBackups(sourcePath, onAcquisition) {
  const backup = sqlite.backup;
  sqlite.backup = (source, destination, ...args) => {
    if (source.location() === sourcePath) {
      const target = snapshotFsPath(destination);
      assert(target, "Native backup destination was not a path");
      onAcquisition(path.dirname(target));
    }
    return backup(source, destination, ...args);
  };
  syncBuiltinESMExports();
  return () => {
    sqlite.backup = backup;
    syncBuiltinESMExports();
  };
}

export function installSnapshotCopyFault({
  source,
  artifacts,
  identity,
  loadRequest,
  canInject,
  describeContext = () => ({}),
  currentBinding = () => undefined,
}) {
  const descriptors = new Map();
  const open = fs.openSync.bind(fs),
    close = fs.closeSync.bind(fs);
  const sync = fs.fsyncSync.bind(fs),
    read = fs.readSync.bind(fs);
  const remove = fs.rmSync.bind(fs),
    removeAsync = fs.promises.rm.bind(fs.promises);
  let native;
  let observed;
  let injecting = false;
  const save = () =>
    write(path.join(artifacts, "snapshot-cleanup-copy-" + observed.native.key + ".json"), observed);
  const record = createSnapshotAcquisitionRecorder(artifacts, {
    identity,
    pid: process.pid,
    threadId,
    operationId: () => native?.operationId ?? currentBinding()?.operationId,
  });
  const requestObserver = observeSnapshotWorkerRequests({
    onRequest(request) {
      native = loadRequest(request);
      if (!native?.binding) {
        native = undefined;
        return;
      }
      for (const field of [
        "key",
        "source",
        "stagingRoot",
        "transport",
        "ipcRequestId",
        "pid",
        "childStart",
        "parentPid",
        "parentStart",
      ]) {
        assert.equal(native[field], request[field], "Capture request identity changed: " + field);
      }
      assert.equal(native.source, source);
      const stat = fs.statSync(source, { bigint: true });
      assert.deepEqual(native.binding.sourceIdentity, {
        dev: String(stat.dev),
        ino: String(stat.ino),
      });
    },
    onReply({ request, result, sha256, at }) {
      const message = snapshotFailure(result);
      if (
        !observed ||
        observed.native.key !== request.key ||
        observed.terminalRefusal ||
        message === undefined
      ) {
        return;
      }
      if (
        !message.includes(snapshotCopyRefusal) ||
        observed.cleanupDenials === 0 ||
        !message.includes(observed.staging) ||
        !/SQLite (?:journal state|journal mode|WAL generation|WAL|main database).*changed/u.test(
          message,
        )
      ) {
        return;
      }
      observed.terminalRefusal = true;
      observed.retainedAtRefusal = fs.existsSync(observed.staging);
      observed.failure = {
        message: message.slice(-2500),
        sha256: hash(message),
        resultSha256: sha256,
        truncated: message.length > 2500,
        channel: request.transport === "ipc" ? "process.send" : "stdout",
        ipcRequestId: request.ipcRequestId,
        at,
      };
      observed.groupIncompleteAtRefusal =
        fs.existsSync(observed.native.binding.marker) &&
        !fs.existsSync(observed.native.binding.target);
      observed.unpublishedAtRefusal = !fs.existsSync(
        path.join(observed.staging, "database.sqlite"),
      );
      observed.sourcePreservedAtRefusal =
        JSON.stringify(family(source)) === JSON.stringify(observed.afterWriter);
      save();
    },
    onFinished() {
      native = undefined;
    },
  });
  const restoreAllocations = observeSnapshotAllocations(source, requestObserver.current, record);
  const restoreBackup = observeSnapshotNativeBackups(source, record);
  const inject = () => {
    if (observed || injecting || !native?.binding) {
      return;
    }
    injecting = true;
    try {
      if (!canInject(native)) {
        return;
      }
      const target = [...descriptors.values()].find(
        (file) =>
          /(?:^|\/)(?:first|database\.sqlite\.partial)$/u.test(file) &&
          path.dirname(file).startsWith(native.stagingRoot + path.sep) &&
          path.basename(path.dirname(file)).startsWith("openclaw-sqlite-readonly-") &&
          fs.existsSync(file) &&
          fs.statSync(file).size > 0,
      );
      if (!target || ![...descriptors.values()].includes(source)) {
        return;
      }
      try {
        fs.writeFileSync(path.join(artifacts, "snapshot-cleanup-fault-claim"), native.key, {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if (error.code === "EEXIST") {
          return;
        }
        throw error;
      }
      // The fixture writer intentionally commits then self-terminates to retain WAL.
      // This is not a silence timeout or a substitute for joining the snapshot child.
      const writer = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE); UPDATE snapshot_cleanup_witness SET value=value+1;'); process.kill(process.pid, 'SIGKILL');",
          source,
        ],
        { env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8", timeout: 30000 },
      );
      assert.equal(
        writer.signal,
        "SIGKILL",
        "Fixture writer did not commit and settle: " + writer.stderr,
      );
      observed = {
        pid: process.pid,
        threadId,
        parentPid: process.ppid,
        identity,
        ...describeContext(),
        native,
        injectedAt: String(process.hrtime.bigint()),
        writer: { pid: writer.pid, signal: writer.signal },
        staging: path.dirname(target),
        afterWriter: family(source),
        cleanupDenials: 0,
        terminalRefusal: false,
        sourcePreservedAtRefusal: false,
        removed: false,
      };
      save();
    } finally {
      injecting = false;
    }
  };
  fs.openSync = (file, flags, mode) => {
    const fd = open(file, flags, mode);
    const pathname = snapshotFsPath(file);
    if (pathname) {
      descriptors.set(fd, pathname);
    }
    return fd;
  };
  fs.closeSync = (fd) => {
    try {
      return close(fd);
    } finally {
      descriptors.delete(fd);
    }
  };
  fs.fsyncSync = (fd) => {
    const value = sync(fd);
    inject();
    return value;
  };
  fs.readSync = (...args) => {
    const value = read(...args);
    inject();
    return value;
  };
  const owns = (file) => {
    const pathname = snapshotFsPath(file);
    return (
      observed &&
      pathname &&
      (pathname === observed.staging || pathname.startsWith(observed.staging + path.sep))
    );
  };
  const beforeRemove = (file) => {
    if (owns(file) && !observed.terminalRefusal) {
      observed.cleanupDenials++;
      save();
      throw Object.assign(new Error(denial), { code: "EACCES", path: snapshotFsPath(file) });
    }
  };
  const afterRemove = (file) => {
    if (owns(file)) {
      observed.removed = !fs.existsSync(observed.staging);
      save();
    }
  };
  fs.rmSync = (file, options) => {
    beforeRemove(file);
    const value = remove(file, options);
    afterRemove(file);
    return value;
  };
  fs.promises.rm = async (file, options) => {
    beforeRemove(file);
    await removeAsync(file, options);
    afterRemove(file);
  };
  syncBuiltinESMExports();
  return {
    restore() {
      fs.openSync = open;
      fs.closeSync = close;
      fs.fsyncSync = sync;
      fs.readSync = read;
      fs.rmSync = remove;
      fs.promises.rm = removeAsync;
      restoreAllocations();
      restoreBackup();
      requestObserver.restore();
      syncBuiltinESMExports();
    },
  };
}
