import childProcess from "node:child_process";
// Diagnostic-only phase/fsync attribution for session-delete-measure.ts. Never delays syscalls.
// Async phases overlap: CPU/memory are context, and phase totals must not be summed.
import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { getHeapStatistics } from "node:v8";
import { isMainThread, threadId } from "node:worker_threads";
import { parse } from "acorn";

const output = process.env.OPENCLAW_DELETE_PHASE_OUTPUT;
if (output) {
  // Diagnostic pass only. Native SQLite sync/unlink calls bypass node:fs; transaction
  // and checkpoint timings include that native IO without pretending to count syscalls.
  const record = (row) =>
    fs.appendFileSync(
      `${output}/io-${threadId}.jsonl`,
      `${JSON.stringify({ threadId, at: Date.now(), ...row })}\n`,
    );
  const size = (file) => fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  const spawn = childProcess.spawn;
  childProcess.spawn = function (file, args, ...options) {
    const started = performance.now();
    const child = spawn.call(this, file, args, ...options);
    if (file === "git" || file.endsWith("/git")) {
      const argumentsList = Array.isArray(args) ? args : [];
      const subcommand = argumentsList.find((arg) =>
        [
          "rev-parse",
          "update-ref",
          "ls-files",
          "read-tree",
          "write-tree",
          "diff",
          "worktree",
          "status",
        ].includes(arg),
      );
      child.once("close", (code) =>
        record({
          operation: "git.spawn",
          subcommand: subcommand ?? "other",
          head: argumentsList.includes("HEAD"),
          code,
          ms: performance.now() - started,
        }),
      );
    }
    return child;
  };
  const classify = (file) =>
    String(file).endsWith("jsonl-stage")
      ? "stage"
      : String(file).endsWith(".stage")
        ? "encoded-stage"
        : String(file).includes("/fixture-worktrees/")
          ? "worktree"
          : "other";
  const files = new Map();
  const open = fs.openSync;
  const close = fs.closeSync;
  const sync = fs.fsyncSync;
  fs.openSync = function (file, ...args) {
    const fd = open.call(this, file, ...args);
    files.set(fd, String(file));
    return fd;
  };
  fs.closeSync = function (fd, ...args) {
    files.delete(fd);
    return close.call(this, fd, ...args);
  };
  fs.fsyncSync = function (fd, ...args) {
    const started = performance.now();
    try {
      return sync.call(this, fd, ...args);
    } finally {
      const file = files.get(fd);
      if (file) {
        const row = {
          threadId,
          at: Date.now(),
          kind: file.endsWith("jsonl-stage") ? "stage" : "other",
          ms: performance.now() - started,
        };
        fs.appendFileSync(`${output}/fsync-${threadId}.jsonl`, `${JSON.stringify(row)}\n`);
      }
    }
  };
  for (const method of ["unlinkSync", "rmSync"]) {
    const original = fs[method];
    fs[method] = function (file, ...args) {
      const bytes = size(file);
      const started = performance.now();
      try {
        return original.call(this, file, ...args);
      } finally {
        record({ operation: method, kind: classify(file), bytes, ms: performance.now() - started });
      }
    };
  }
  for (const method of ["unlink", "rm"]) {
    const original = fs.promises[method];
    fs.promises[method] = async function (file, ...args) {
      const bytes = size(file);
      const started = performance.now();
      try {
        return await original.call(this, file, ...args);
      } finally {
        record({ operation: method, kind: classify(file), bytes, ms: performance.now() - started });
      }
    };
  }
  const openAsync = fs.promises.open;
  fs.promises.open = async function (file, ...args) {
    const handle = await openAsync.call(this, file, ...args);
    for (const method of ["sync", "datasync"]) {
      const original = handle[method];
      handle[method] = async function (...callArgs) {
        const started = performance.now();
        try {
          return await original.apply(this, callArgs);
        } finally {
          record({ operation: method, kind: classify(file), ms: performance.now() - started });
        }
      };
    }
    return handle;
  };
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (
      !/^\s*(?:BEGIN|COMMIT|ROLLBACK|PRAGMA\s+(?:wal_checkpoint|incremental_vacuum))/i.test(sql)
    ) {
      return exec.call(this, sql);
    }
    const database = this.location();
    const walBytesBefore = database ? size(`${database}-wal`) : 0;
    const started = performance.now();
    try {
      return exec.call(this, sql);
    } finally {
      record({
        operation: "sqlite.exec",
        sql,
        ms: performance.now() - started,
        walBytesBefore,
        walBytesAfter: database ? size(`${database}-wal`) : 0,
      });
    }
  };
  const prepare = DatabaseSync.prototype.prepare;
  const counters = new WeakMap();
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    const statement = prepare.call(this, sql, ...args);
    if (!/^\s*(?:DELETE\b|PRAGMA\s+(?:wal_checkpoint|incremental_vacuum))/i.test(sql)) {
      return statement;
    }
    const database = this.location();
    let changes = counters.get(this);
    if (!changes) {
      changes = prepare.call(this, "SELECT total_changes() AS count");
      counters.set(this, changes);
    }
    for (const method of ["run", "all", "get"]) {
      const original = statement[method];
      statement[method] = function (...params) {
        const changesBefore = changes.get().count;
        const started = performance.now();
        let result;
        try {
          result = original.apply(this, params);
          return result;
        } finally {
          const ms = performance.now() - started;
          record({
            operation: "sqlite.statement",
            sql,
            method,
            ms,
            totalChanges: changes.get().count - changesBefore,
            affectedRows: result?.changes === undefined ? undefined : Number(result.changes),
            returnedRows: Array.isArray(result) ? result.length : undefined,
            checkpoint: /wal_checkpoint/i.test(sql) ? result : undefined,
            walBytesAfter: database ? size(`${database}-wal`) : 0,
          });
        }
      };
    }
    return statement;
  };
  syncBuiltinESMExports();
}
if (output) {
  const names = new Set([
    "deleteGatewaySessionInScope",
    "prepareSessionLifecycleDrain",
    "cleanupSessionBeforeMutation",
    "ensureSessionRuntimeCleanup",
    "runPluginHostCleanup",
    "closeAcpRuntimeForSession",
    "closeChildAcpRuntimesForParent",
    "listAcpSessionEntries",
    "resetSessionAgentHarnesses",
    "deleteSqliteSessionEntryLifecycleInternal",
    "materializeSessionStateDeletePlans",
    "runSessionDeletionPlanning",
    "runSqliteSessionReclamation",
    "publishSessionStateArchives",
    "handleSessionStateSessionDeleted",
    "removeSessionWorktree",
    "emitSessionUnboundLifecycleEvent",
    "stageTranscriptArchiveContent",
    "encodeStagedTranscriptArchive",
    "snapshotWorktree",
    "collectSnapshotInventory",
    "prepareSnapshotIndex",
    "publishPreparedSessionStateArchives",
    "reserveWorktreeCapacityInWorker",
    "reserveWorktreeCapacity",
    "inspectOtherPaths",
    "listCollapsedOtherPaths",
    "walkCollapsedPaths",
    "containsGitMarker",
    "parseGitTreePaths",
    "parseGitIndexPaths",
    "executeGitCommandBuffered",
  ]);
  let rows = [];
  const installed = new Set();
  const key = Symbol.for("openclaw.benchmark.deletePhases");
  const syncKey = Symbol.for("openclaw.benchmark.deletePhasesSync");
  const beginPhase = (name) => ({
    wall: performance.now(),
    cpu: process.cpuUsage(),
    threadCpu: process.threadCpuUsage?.(),
    memory: process.memoryUsage(),
    allocated: name === "snapshotWorktree" ? getHeapStatistics().total_allocated_bytes : undefined,
  });
  const recordPhase = (name, started, result, gitArgs) => {
    const ms = performance.now() - started.wall;
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage(started.cpu);
    const threadCpu = started.threadCpu && process.threadCpuUsage(started.threadCpu);
    const row = {
      name,
      ms,
      at: Date.now(),
      threadId,
      cpuUs: cpu.user + cpu.system,
      threadCpuUs: threadCpu ? threadCpu.user + threadCpu.system : undefined,
      rssBefore: started.memory.rss,
      rssAfter: memory.rss,
      heapBefore: started.memory.heapUsed,
      heapAfter: memory.heapUsed,
      allocatedBytes:
        started.allocated === undefined
          ? undefined
          : getHeapStatistics().total_allocated_bytes - started.allocated,
      ...(name === "executeGitCommandBuffered"
        ? {
            subcommand:
              gitArgs?.find((arg) =>
                [
                  "rev-parse",
                  "ls-tree",
                  "ls-files",
                  "diff-files",
                  "status",
                  "config",
                  "read-tree",
                  "update-index",
                  "write-tree",
                  "commit-tree",
                  "update-ref",
                ].includes(arg),
              ) ?? "other",
            stdoutBytes:
              result?.stdout === undefined ? undefined : Buffer.byteLength(result.stdout),
            stderrBytes:
              result?.stderr === undefined ? undefined : Buffer.byteLength(result.stderr),
          }
        : {}),
    };
    if (isMainThread) {
      rows.push(row);
    }
    fs.appendFileSync(`${output}/phases-${threadId}.jsonl`, `${JSON.stringify(row)}\n`);
  };
  globalThis[key] = async (name, run, gitArgs) => {
    const started = beginPhase(name);
    let result;
    try {
      result = await run();
      return result;
    } finally {
      recordPhase(name, started, result, gitArgs);
    }
  };
  globalThis[syncKey] = (name, run) => {
    const started = beginPhase(name);
    try {
      return run();
    } finally {
      recordPhase(name, started);
    }
  };
  registerHooks({
    load(url, context, next) {
      const loaded = next(url, context);
      if (!url.includes("/dist/") || loaded.source == null) {
        return loaded;
      }
      let source =
        typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
      if (![...names].some((name) => source.includes(`function ${name}(`))) {
        return loaded;
      }
      const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
      const edits = [];
      function visit(node) {
        if (!node || typeof node !== "object") {
          return;
        }
        if (node.type === "FunctionDeclaration" && names.has(node.id?.name)) {
          installed.add(node.id.name);
          const gitArgs =
            node.id.name === "executeGitCommandBuffered" && node.params[1]?.type === "Identifier"
              ? `,${node.params[1].name}`
              : "";
          edits.push(
            [
              node.body.start + 1,
              `return ${node.async ? "await " : ""}globalThis[Symbol.for("openclaw.benchmark.deletePhases${node.async ? "" : "Sync"}")](${JSON.stringify(node.id.name)},${node.async ? "async" : ""}()=>{`,
            ],
            [node.body.end - 1, `}${gitArgs});`],
          );
        }
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) {
            value.forEach(visit);
          } else if (value && typeof value === "object") {
            visit(value);
          }
        }
      }
      visit(ast);
      for (const [at, text] of edits.toSorted((a, b) => b[0] - a[0])) {
        source = source.slice(0, at) + text + source.slice(at);
      }
      return { ...loaded, source };
    },
  });
  if (isMainThread) {
    process.on("message", (message) => {
      if (message?.channel !== "delete-phase") {
        return;
      }
      if (message.action === "reset") {
        rows = [];
      }
      if (message.action === "snapshot") {
        process.send?.({ channel: "delete-phase", rows, installed: [...installed] });
      }
    });
  }
}
