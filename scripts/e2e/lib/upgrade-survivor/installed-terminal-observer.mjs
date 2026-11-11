// External process and SQLite observation preserves native behavior.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import workerThreads from "node:worker_threads";
import { gzipSync } from "node:zlib";
import {
  fileIdentity,
  installedRecoveryEvidenceMode,
  openInstalledRecoveryEvidence,
  writeInstalledRecoveryEvidence,
} from "./installed-recovery-observations.mjs";
const specPath = process.env.OPENCLAW_INSTALLED_TERMINAL_OBSERVER;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function plainArguments(value) {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > 128) {
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = Array.from({ length: value.length }, (_, index) => descriptors[index]);
  return entries.every((entry) => entry && "value" in entry && typeof entry.value === "string")
    ? entries.map((entry) => entry.value)
    : null;
}

if (specPath) {
  try {
    install(JSON.parse(fs.readFileSync(specPath, "utf8")));
  } catch (error) {
    // Missing startup evidence fails the external reader. A bad preload must
    // not replace the installed CLI's own behavior or failure diagnostics.
    try {
      fs.writeSync(
        2,
        `[installed-terminal-observer] preload failed: ${String(error).slice(0, 4096)}\n`,
      );
    } catch {}
  }
}

function install(spec) {
  const require = createRequire(import.meta.url);
  const sqlite = require("node:sqlite");
  const NativeDatabase = sqlite.DatabaseSync;
  const nativeOpen = Reflect.get(NativeDatabase.prototype, "open");
  const original = {
    spawn: childProcess.spawn,
    spawnSync: childProcess.spawnSync,
    Worker: workerThreads.Worker,
    stdoutWrite: Reflect.get(process.stdout, "write"),
  };
  const maxBytes = 4 * 1024 * 1024;
  const thread = workerThreads.threadId;
  assert(path.isAbsolute(spec.directory) && path.resolve(spec.directory) === spec.directory);
  const filename = path.join(spec.directory, `${process.pid}-${thread}.jsonl`);
  const fd = openInstalledRecoveryEvidence(filename);
  let bytes = 0;
  let sequence = 0;
  let failure;
  let lastRecordAttempt;
  const counts = {};
  const failureFile = path.join(spec.directory, `${process.pid}-${thread}.failure.json`);
  const sharedFailure = path.join(spec.directory, "observer-failed.json");
  const scopeFile = path.join(spec.directory, "handoff.json");
  let scope;
  const persistFailure = () => {
    if (!failure) {
      return;
    }
    try {
      const receipt = {
        ...failure,
        counts,
        bytes,
        sequence,
        lastRecordAttempt,
        limits: { bytes: maxBytes, events: 8192 },
      };
      const encoded = `${JSON.stringify(receipt, null, 2)}\n`;
      assert(Buffer.byteLength(encoded) <= 16 * 1024);
      writeInstalledRecoveryEvidence(failureFile, receipt);
      try {
        const markerFd = openInstalledRecoveryEvidence(sharedFailure);
        try {
          fs.writeFileSync(markerFd, encoded);
        } finally {
          fs.closeSync(markerFd);
        }
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }
      }
    } catch (error) {
      // Reporting failure cannot replace a native return, callback or exception.
      try {
        fs.writeSync(
          2,
          `[installed-terminal-observer] evidence failure: ${String(error).slice(0, 2048)}\n`,
        );
      } catch {}
    }
  };
  const fail = (error, event) => {
    if (!failure) {
      let message = "Observer threw an unprintable value";
      try {
        message = String(error).slice(0, 4096);
      } catch {}
      failure = {
        status: "unqualified",
        pid: process.pid,
        thread,
        event,
        error: message,
      };
      persistFailure();
    }
  };
  const observe = (event, callback) => {
    if (failure) {
      return;
    }
    try {
      callback();
    } catch (error) {
      fail(error, event);
    }
  };
  const report = (event, detail = {}) => {
    counts[event] = (counts[event] ?? 0) + 1;
    return observe(event, () => {
      const line = `${JSON.stringify({
        event,
        pid: process.pid,
        thread,
        sequence,
        time: String(process.hrtime.bigint()),
        ...detail,
      })}\n`;
      const nextBytes = bytes + Buffer.byteLength(line);
      lastRecordAttempt = { event, bytes: Buffer.byteLength(line) };
      assert(
        nextBytes <= maxBytes && sequence < 8192,
        "Installed terminal observer budget exceeded",
      );
      assert.equal(
        fs.writeSync(fd, line, bytes, "utf8"),
        Buffer.byteLength(line),
        "Observer record was only partially written",
      );
      bytes = nextBytes;
      sequence++;
      return true;
    });
  };
  const locationOf = (value) => {
    if (typeof value === "string") {
      if (value.startsWith("file:")) {
        return fileURLToPath(new URL(value));
      }
      return value === ":memory:" || value === "" ? value : path.resolve(value);
    }
    return value instanceof URL
      ? fileURLToPath(value)
      : Buffer.isBuffer(value)
        ? path.resolve(value.toString())
        : "unknown";
  };
  const fileFacts = (location) => {
    if (location === "unknown" || location === ":memory:" || location === "") {
      return { location };
    }
    try {
      return { location, canonical: fs.realpathSync(location), identity: fileIdentity(location) };
    } catch (error) {
      if (error.code === "ENOENT") {
        return { location, canonical: path.resolve(location), identity: null };
      }
      throw error;
    }
  };
  const locations = new WeakMap();
  let operation = 0;
  const beginSqlite = (location) => {
    const intent = { operation: operation++, offset: bytes, sequence };
    report("sqlite-intent", { operation: intent.operation });
    observe("sqlite-location", () => {
      intent.before = fileFacts(location);
    });
    return intent;
  };
  const finishSqlite = (intent, event, detail) => {
    observe(event, () => {
      scope ??= fs.existsSync(scopeFile)
        ? JSON.parse(fs.readFileSync(scopeFile, "utf8"))
        : undefined;
      const relevant = (facts) =>
        facts.location === "unknown" ||
        scope.databases.some(
          (entry) =>
            entry.canonical === facts.canonical ||
            (entry.identity !== null &&
              entry.identity !== undefined &&
              entry.identity === facts.identity),
        );
      // Keep the persisted intent until native completion. Only the exact tail
      // can be removed; reentrant getters/events retain their complete pair.
      if (
        scope &&
        !relevant(intent.before) &&
        !relevant(detail) &&
        sequence === intent.sequence + 1
      ) {
        fs.ftruncateSync(fd, intent.offset);
        bytes = intent.offset;
        sequence = intent.sequence;
      } else {
        report(event, { operation: intent.operation, ...detail });
      }
    });
  };
  sqlite.DatabaseSync = new Proxy(NativeDatabase, {
    construct(target, args, newTarget) {
      let location = "unknown";
      observe("sqlite-location", () => {
        if (typeof args[0] === "string") {
          location = locationOf(args[0]);
        }
      });
      const intent = beginSqlite(location);
      // Native code reads option getters once. Observe only after forwarding the
      // original arguments, receiver and exception; do not inspect options here.
      let result;
      try {
        result = Reflect.construct(target, args, newTarget);
      } catch (error) {
        observe("sqlite-construct-error", () =>
          finishSqlite(intent, "sqlite-construct-error", {
            ...fileFacts(locationOf(args[0])),
            error: String(error),
          }),
        );
        throw error;
      }
      observe("sqlite-construct", () => {
        location = locationOf(args[0]);
        locations.set(result, location);
        finishSqlite(intent, "sqlite-construct", {
          ...fileFacts(location),
          opened: result.isOpen,
        });
      });
      return result;
    },
  });
  NativeDatabase.prototype.open = function (...args) {
    const location = locations.get(this) ?? "unknown";
    const intent = beginSqlite(location);
    let result;
    try {
      result = Reflect.apply(nativeOpen, this, args);
    } catch (error) {
      observe("sqlite-open-error", () =>
        finishSqlite(intent, "sqlite-open-error", {
          ...fileFacts(location),
          error: String(error),
        }),
      );
      throw error;
    }
    observe("sqlite-open", () =>
      finishSqlite(intent, "sqlite-open", { ...fileFacts(location), opened: this.isOpen }),
    );
    return result;
  };
  workerThreads.Worker = new Proxy(original.Worker, {
    construct(target, args, newTarget) {
      const child = Reflect.construct(target, args, newTarget);
      observe("thread", () => {
        const childThread = child.threadId;
        const entry = String(args[0]);
        report("thread", {
          childThread,
          entry,
        });
        child.once("exit", (code) => report("thread-exit", { childThread, code }));
      });
      return child;
    },
  });
  let spawnId = 0;
  childProcess.spawnSync = function (...args) {
    const startedAt = String(process.hrtime.bigint());
    let result;
    try {
      result = Reflect.apply(original.spawnSync, this, args);
    } catch (error) {
      // Node can throw while decoding output after the child already ran.
      // Preserve that exact exception; it proves neither no-start nor settlement.
      fail("Synchronous spawn threw; native completion is unknown", "spawn-sync");
      throw error;
    }
    observe("spawn-sync", () => {
      const id = spawnId++;
      assert(Number.isSafeInteger(result.pid) && result.pid >= 0);
      const child = result.pid || null;
      const command = args[0];
      assert.equal(typeof command, "string");
      const argv = args[1] === undefined ? [] : plainArguments(args[1]);
      // The PID becomes available only on return. This timestamp records the
      // invocation bound, not an invented native start/async exit event.
      report("spawn", {
        api: "spawnSync",
        spawnId: id,
        child,
        time: startedAt,
        command,
        argv,
        nodeChild: command === process.execPath || path.basename(command) === "node",
      });
      report("spawn-sync-return", {
        spawnId: id,
        child,
        spawned: child !== null,
        code: result.status,
        signal: result.signal,
        errorCode: result.error?.code ?? null,
      });
    });
    return result;
  };
  childProcess.spawn = function (...args) {
    const child = Reflect.apply(original.spawn, this, args);
    observe("spawn", () => {
      const id = spawnId++;
      const pid = child.pid ?? null;
      let spawned = false;
      // Failed starts have no PID. Bind closure to this attempt, and observe
      // success without an error listener that would swallow native failures.
      child.once("spawn", () => {
        spawned = true;
      });
      const argv = plainArguments(args[1]);
      const nodeChild = args[0] === process.execPath || path.basename(args[0]) === "node";
      report("spawn", {
        spawnId: id,
        child: pid,
        nodeChild,
        command: args[0],
        argv,
      });
      // Native exit owns process lifetime. Parent-side IPC disconnect can omit
      // aggregate close; selected finalizer output still requires close and EOF.
      child.once("exit", (code, signal) =>
        report("spawn-exit", { spawnId: id, child: pid, spawned, code, signal }),
      );
      child.once("close", (code, signal) =>
        report("spawn-close", { spawnId: id, child: pid, spawned, code, signal }),
      );
    });
    return child;
  };
  process.stdout.write = function (...args) {
    const [value, encoding] = args;
    observe("stdout", () =>
      report("stdout", {
        bytes: Buffer.isBuffer(value)
          ? value.toString("base64")
          : Buffer.from(value, typeof encoding === "string" ? encoding : undefined).toString(
              "base64",
            ),
      }),
    );
    return Reflect.apply(original.stdoutWrite, this, args);
  };
  syncBuiltinESMExports();
  report("startup", {
    ppid: process.ppid,
    argv: process.argv,
    node: process.version,
    entry: process.argv[1],
  });
  process.once("exit", (code) => {
    report("exit", { code });
    persistFailure();
    try {
      fs.closeSync(fd);
    } catch (error) {
      fail(error, "close");
    }
  });
}

export function readInstalledTerminalEvents(directory, spec = {}) {
  return readObservation(directory, spec).rows;
}

function readIsolates(directory) {
  const names = fs.readdirSync(directory);
  assert(
    !names.includes("observer-failed.json") &&
      !names.some((name) => name.endsWith(".failure.json") || name.endsWith(".failure.json.tmp")),
    "Observer recording failed; coverage is unqualified",
  );
  const files = names.filter((name) => name.endsWith(".jsonl"));
  assert(files.length > 0, "Observer isolate census is missing");
  assert(
    files.length <= 256 || names.includes("handoff.json"),
    "Observer full-trace isolate census is excessive",
  );
  let total = 0;
  const isolates = files.map((file) => {
    const bytes = fs.readFileSync(path.join(directory, file));
    total += bytes.length;
    assert(bytes.length <= 4 * 1024 * 1024 && total <= 32 * 1024 * 1024);
    assert(bytes.at(-1) === 10, "Observer record was truncated");
    const rows = bytes
      .toString()
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const startup = rows.filter((row) => row.event === "startup");
    assert.equal(startup.length, 1);
    rows.forEach((row, index) => {
      assert.equal(row.sequence, index);
      assert.equal(row.pid, startup[0].pid);
      assert.equal(row.thread, startup[0].thread);
    });
    return rows;
  });
  return { files, isolates };
}

// Call only after the command owner joins. ESRCH proves current absence, not an
// exit code or an earlier death; the reader keeps these processes' full traces.
export function captureInstalledTerminalProcessAbsence(directory) {
  assert.equal(process.platform, "linux");
  // Receipts must share the observed Node processes' monotonic clock;
  // Bun's process-origin timer cannot bound those events.
  assert.equal(
    process.versions.bun,
    undefined,
    "Kernel absence capture requires the Node monotonic clock",
  );
  const rows = readIsolates(directory).isolates.flat();
  const missing = rows.filter(
    (row) =>
      row.event === "spawn" &&
      row.api !== "spawnSync" &&
      Number.isSafeInteger(row.child) &&
      row.child > 0 &&
      !rows.some(
        (exit) =>
          exit.event === "spawn-exit" &&
          exit.pid === row.pid &&
          exit.thread === row.thread &&
          exit.spawnId === row.spawnId,
      ),
  );
  assert.equal(
    new Set(missing.map((row) => row.child)).size,
    missing.length,
    "Ambiguous absent PID identity",
  );
  return missing.map(({ pid, thread, spawnId, child }) => {
    let errorCode = null;
    try {
      process.kill(child, 0);
    } catch (error) {
      errorCode =
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : "UNKNOWN";
    }
    return {
      pid,
      thread,
      spawnId,
      child,
      sourceKind: "linux-pid-absence",
      observerPid: process.pid,
      time: process.hrtime.bigint().toString(),
      errorCode,
      ownExitCode: null,
    };
  });
}

// A native shell has no preload startup. Combine recorded spawn edges with
// startup PPIDs so its observed Node descendants keep their real ancestry.
// This classification does not replace the separate lifetime/coverage gates.
export function installedTerminalDescendants(rows, root) {
  const found = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) {
      const parent = row.event === "spawn" ? row.pid : row.event === "startup" ? row.ppid : null;
      const child = row.event === "spawn" ? row.child : row.pid;
      if (found.has(parent) && Number.isSafeInteger(child) && child > 0 && !found.has(child)) {
        found.add(child);
        changed = true;
      }
    }
  }
  return found;
}

function readObservation(directory, spec = {}) {
  const { files, isolates } = readIsolates(directory);
  const rows = isolates.flat();
  const startups = rows.filter((row) => row.event === "startup");
  const handoffs = rows.filter((row) => row.event === "handoff");
  assert(handoffs.length <= 1, "Multiple installed handoffs");
  const handoff = handoffs[0];
  if (handoff) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "handoff.json"), "utf8")), {
      time: handoff.time,
      child: handoff.child,
      databases: handoff.databases,
    });
  }
  const candidate = handoff ? installedTerminalDescendants(rows, handoff.child) : new Set();
  const lifetimeBounds = new Map();
  const fullTraceProcesses = new Set();
  const ownerExit = (owner) =>
    rows.find(
      (event) => event.event === "exit" && event.pid === owner.pid && event.thread === owner.thread,
    ) ??
    (owner.thread === 0
      ? undefined
      : (() => {
          const created = rows.filter(
            (event) =>
              event.event === "thread" &&
              event.pid === owner.pid &&
              event.childThread === owner.thread,
          );
          return created.length === 1 ? threadEnd(created[0]) : undefined;
        })());
  const spawnIds = new Set();
  const identity = ({
    event,
    pid,
    thread,
    spawnId,
    child,
    childThread,
    time,
    code,
    signal,
    spawned,
  }) => ({ event, pid, thread, spawnId, child, childThread, time, code, signal, spawned });
  const nativeExits = (created) =>
    rows.filter((event) =>
      created.event === "spawn"
        ? event.event ===
            (created.api === "spawnSync"
              ? "spawn-sync-return"
              : created.child === null
                ? "spawn-close"
                : "spawn-exit") &&
          event.pid === created.pid &&
          event.thread === created.thread &&
          event.spawnId === created.spawnId
        : event.event === "thread-exit" &&
          event.pid === created.pid &&
          event.thread === created.thread &&
          event.childThread === created.childThread,
    );
  const requireUniqueExit = (created, exits) => {
    assert.equal(
      exits.length,
      1,
      `Child has no unique native exit: ${JSON.stringify({
        created: identity(created),
        matches: exits.slice(0, 8).map(identity),
        omitted: Math.max(0, exits.length - 8),
      })}`,
    );
    return exits[0];
  };
  const processEnd = (created) => {
    const direct = nativeExits(created);
    if (direct.length || created.child === null || created.api === "spawnSync") {
      return requireUniqueExit(created, direct);
    }
    const receipts = (spec.processAbsence ?? []).filter(
      (receipt) =>
        receipt.pid === created.pid &&
        receipt.thread === created.thread &&
        receipt.spawnId === created.spawnId,
    );
    const receipt = requireUniqueExit(created, receipts);
    assert(
      receipt.sourceKind === "linux-pid-absence" &&
        Number.isSafeInteger(created.child) &&
        created.child > 0 &&
        receipt.child === created.child &&
        Number.isSafeInteger(receipt.observerPid) &&
        receipt.observerPid > 0 &&
        receipt.observerPid !== created.child &&
        receipt.errorCode === "ESRCH" &&
        receipt.ownExitCode === null,
      "OS child has no strict kernel absence receipt",
    );
    const started = startups.filter((start) => start.pid === created.child && start.thread === 0);
    assert(
      created.nodeChild === true && started.length === 1 && started[0].ppid === created.pid,
      "OS child absence requires exact preload startup",
    );
    assert(
      BigInt(created.time) < BigInt(receipt.time) &&
        rows.every((event) => BigInt(event.time) < BigInt(receipt.time)),
      "OS child observation exceeds kernel absence bound",
    );
    fullTraceProcesses.add(created.child);
    lifetimeBounds.set(created, receipt);
    return receipt;
  };
  const threadEnds = new Map();
  function threadEnd(created, ancestors = new Set()) {
    assert.equal(
      rows.filter(
        (event) =>
          event.event === "thread" &&
          event.pid === created.pid &&
          event.childThread === created.childThread,
      ).length,
      1,
      "Duplicate Worker creation identity",
    );
    const direct = nativeExits(created);
    if (direct.length !== 0) {
      return requireUniqueExit(created, direct);
    }
    if (threadEnds.has(created)) {
      return threadEnds.get(created);
    }
    assert(!ancestors.has(created), "Cyclic Worker creation ancestry");
    const next = new Set(ancestors).add(created);
    assert.equal(
      startups.filter((start) => start.pid === created.pid && start.thread === created.childThread)
        .length,
      1,
      "Child has no unique native exit; enclosing bound requires unique Worker startup",
    );
    const owners = rows.filter((event) =>
      created.thread === 0
        ? event.event === "spawn" && event.child === created.pid
        : event.event === "thread" &&
          event.pid === created.pid &&
          event.childThread === created.thread,
    );
    assert.equal(owners.length, 1, "Child has no unique native exit or enclosing owner");
    assert.equal(
      startups.filter((start) => start.pid === created.pid && start.thread === created.thread)
        .length,
      1,
      "Child has no unique native exit; enclosing owner startup is missing",
    );
    const owner = owners[0];
    const end =
      owner.event === "spawn"
        ? requireUniqueExit(owner, nativeExits(owner))
        : threadEnd(owner, next);
    const before = handoff && BigInt(end.time) < BigInt(handoff.time);
    assert(before || candidate.has(created.pid), "Enclosing native bound spans predecessor window");
    // Node disables JS callbacks before recursively joining Workers at teardown.
    // A recorded enclosing native exit is an upper bound, never the child's exit code.
    const subtree = new Set([created.childThread]);
    for (let changed = true; changed;) {
      changed = false;
      for (const event of rows) {
        if (
          event.event === "thread" &&
          event.pid === created.pid &&
          subtree.has(event.thread) &&
          !subtree.has(event.childThread)
        ) {
          subtree.add(event.childThread);
          changed = true;
        }
      }
    }
    assert(
      BigInt(created.time) < BigInt(end.time) &&
        rows.every(
          (event) =>
            event.pid !== created.pid ||
            !subtree.has(event.thread) ||
            BigInt(event.time) < BigInt(end.time),
        ),
      "Worker observation exceeds enclosing native bound",
    );
    lifetimeBounds.set(created, {
      sourceKind: end.event === "thread-exit" ? "worker-native-exit" : "process-native-exit",
      source: identity(end),
      time: end.time,
      ownExitCode: null,
      reason: before ? "settled-before-handoff" : "candidate-subtree",
    });
    threadEnds.set(created, end);
    return end;
  }
  for (const row of rows) {
    let nativeExit;
    if (row.event === "spawn") {
      assert(
        Number.isSafeInteger(row.spawnId) && row.spawnId >= 0,
        "Missing spawn observation identity",
      );
      const key = `${row.pid}:${row.thread}:${row.spawnId}`;
      assert(!spawnIds.has(key), "Duplicate spawn observation identity");
      spawnIds.add(key);
    }
    if (row.event === "spawn" || row.event === "thread") {
      nativeExit = row.event === "thread" ? threadEnd(row) : processEnd(row);
      if (row.event === "spawn" && !lifetimeBounds.has(row)) {
        assert.equal(nativeExit.child, row.child, "Spawn PID changed before closure");
        assert(
          row.child === null
            ? nativeExit.spawned === false &&
                (row.api === "spawnSync"
                  ? nativeExit.code === null && typeof nativeExit.errorCode === "string"
                  : Number.isInteger(nativeExit.code) && nativeExit.code < 0) &&
                nativeExit.signal === null
            : Number.isInteger(row.child) &&
                row.child > 0 &&
                nativeExit.spawned === true &&
                ((Number.isInteger(nativeExit.code) &&
                  nativeExit.code >= 0 &&
                  nativeExit.signal === null) ||
                  (nativeExit.code === null && typeof nativeExit.signal === "string")),
          "Spawn has no qualified native start outcome",
        );
      }
      if (!lifetimeBounds.has(row)) {
        const parentExit = ownerExit(row);
        assert(
          parentExit &&
            (row.event !== "thread" || Number.isInteger(nativeExit.code)) &&
            BigInt(row.time) < BigInt(nativeExit.time) &&
            BigInt(nativeExit.time) < BigInt(parentExit.time),
          "Child settlement is outside parent custody",
        );
      }
    }
    if (row.event === "spawn" && row.nodeChild && row.child !== null) {
      assert(row.argv !== null, "Node child argv observation is unqualified");
      assert(
        startups.some((start) => start.pid === row.child),
        "Missing Node child preload coverage",
      );
      if (row.api === "spawnSync") {
        const started = startups.filter((start) => start.pid === row.child && start.thread === 0);
        assert(
          rows.filter((event) => event.event === "spawn" && event.child === row.child).length ===
            1 &&
            started.length === 1 &&
            started[0].ppid === row.pid &&
            BigInt(row.time) < BigInt(started[0].time) &&
            rows.every(
              (event) => event.pid !== row.child || BigInt(event.time) < BigInt(nativeExit.time),
            ),
          "Synchronous child observation exceeds its native lifetime or lacks startup",
        );
      }
    }
    if (
      row.event !== "thread" ||
      startups.some((start) => start.pid === row.pid && start.thread === row.childThread)
    ) {
      continue;
    }
    assert.fail("Missing worker-thread preload coverage");
  }
  for (const isolate of isolates) {
    if (isolate.at(-1).event === "exit") {
      continue;
    }
    const { pid, thread } = isolate[0];
    if (thread === 0) {
      // SIGKILL cannot run the child's JS exit hook. Reuse the direct native
      // lifetime validated above; later absence is not this settlement fact.
      const created = rows.filter((row) => row.event === "spawn" && row.child === pid);
      assert.equal(created.length, 1, "Observer isolate has no unique process creation");
      const end = requireUniqueExit(created[0], nativeExits(created[0]));
      assert(
        isolate[0].ppid === created[0].pid &&
          BigInt(created[0].time) < BigInt(isolate[0].time) &&
          isolate.every((row) => BigInt(row.time) < BigInt(end.time)),
        "Observer isolate exceeds its direct native lifetime",
      );
      fullTraceProcesses.add(pid);
      continue;
    }
    // Native teardown can suppress the isolate's JS exit hook. Every creation
    // above already has a direct exit or qualified enclosing native bound.
    assert(
      thread !== 0 &&
        rows.some((row) => row.event === "thread" && row.pid === pid && row.childThread === thread),
      "Observer isolate did not settle",
    );
  }
  const excluded = new Map();
  for (const [index, isolate] of isolates.entries()) {
    const { pid, thread } = isolate[0];
    const created = rows.filter(
      (row) => row.event === "thread" && row.pid === pid && row.childThread === thread,
    );
    const exits =
      thread === 0
        ? rows.filter((row) => row.event === "spawn" && row.child === pid).flatMap(nativeExits)
        : created.length === 1
          ? [threadEnd(created[0])]
          : [];
    // Native settlement excludes only this lifetime, never its descendants.
    // Keep every ancestry edge even when its SQL history predates the handoff.
    const before = handoff && exits.length === 1 && BigInt(exits[0].time) < BigInt(handoff.time);
    // Preserve every SQL record when settlement lacks the isolate's own hook.
    if (!fullTraceProcesses.has(pid) && (before || candidate.has(pid))) {
      excluded.set(files[index], before ? "settled-before-handoff" : "candidate-subtree");
    }
    const pending = new Set();
    for (const row of isolate) {
      if (row.event === "sqlite-intent") {
        assert(!pending.has(row.operation));
        pending.add(row.operation);
      } else if (row.event.startsWith("sqlite-")) {
        assert(pending.delete(row.operation), "SQLite result has no operation intent");
      }
    }
    if (!before) {
      assert.equal(pending.size, 0, "SQLite observation interrupted; no-reopen proof is unknown");
    }
  }
  assert(files.length - excluded.size <= 256, "Observer full-trace isolate census is excessive");
  return {
    files,
    isolates,
    excluded,
    rows: rows
      .map((row) =>
        lifetimeBounds.has(row)
          ? Object.assign({}, row, {
              lifetimeBound: lifetimeBounds.get(row),
            })
          : row,
      )
      .toSorted((a, b) =>
        BigInt(a.time) < BigInt(b.time) ? -1 : BigInt(a.time) > BigInt(b.time) ? 1 : 0,
      ),
  };
}

// This bounded header census diagnoses rejected traces; it never substitutes
// for complete operation pairs, isolate coverage or the no-reopen oracle.
function readIsolateCensus(directory, files) {
  const census = {
    diagnosticOnly: true,
    status: "complete",
    files: files.length,
    bytes: 0,
    inspected: 0,
    unknown: 0,
    readBytes: 0,
    groups: [],
    failures: [],
    omissions: 0,
  };
  const groups = new Map();
  const readPrefix = (file) => {
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink());
    const size = Math.min(stat.size, 16 * 1024);
    if (census.readBytes + size > 4 * 1024 * 1024) {
      census.status = "capped";
      census.omissions++;
      return { size: stat.size };
    }
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(size);
    try {
      const count = fs.readSync(fd, buffer, 0, size, 0);
      census.readBytes += count;
      return { size: stat.size, bytes: buffer.subarray(0, count) };
    } finally {
      fs.closeSync(fd);
    }
  };
  for (const name of files) {
    try {
      const prefix = readPrefix(path.join(directory, name));
      census.bytes += prefix.size;
      if (!prefix.bytes) {
        continue;
      }
      census.inspected++;
      const newline = prefix.bytes.indexOf(10);
      assert(newline >= 0, "Startup header incomplete");
      const row = JSON.parse(prefix.bytes.subarray(0, newline).toString());
      assert(row.event === "startup" && Number.isInteger(row.pid) && Number.isInteger(row.thread));
      assert.equal(name, `${row.pid}-${row.thread}.jsonl`);
      const entry = typeof row.entry === "string" ? row.entry : null;
      const key = JSON.stringify([entry, row.thread === 0]);
      let group = groups.get(key);
      if (!group && groups.size < 64 && Buffer.byteLength(key) <= 1024) {
        group = { entry, mainThread: row.thread === 0, isolates: 0, bytes: 0 };
        groups.set(key, group);
      }
      if (group) {
        group.isolates++;
        group.bytes += prefix.size;
      } else {
        census.status = "capped";
        census.omissions++;
      }
      const failurePath = path.join(directory, `${row.pid}-${row.thread}.failure.json`);
      if (fs.existsSync(failurePath)) {
        const failure = readPrefix(failurePath);
        if (failure.bytes && failure.bytes.length === failure.size && census.failures.length < 16) {
          const detail = JSON.parse(failure.bytes.toString());
          assert.equal(detail.pid, row.pid);
          assert.equal(detail.thread, row.thread);
          census.failures.push(detail);
        } else {
          census.status = "capped";
          census.omissions++;
        }
      }
    } catch {
      census.unknown++;
    }
  }
  census.groups = [...groups.values()];
  if (census.unknown > 0 && census.status === "complete") {
    census.status = "partial";
  }
  const bytes = Buffer.from(`${JSON.stringify(census, null, 2)}\n`);
  // Bound even hostile diagnostic strings without claiming a partial census.
  if (bytes.length > 128 * 1024) {
    return Buffer.from(
      `${JSON.stringify({
        diagnosticOnly: true,
        status: "capped",
        files: census.files,
        bytes: census.bytes,
        inspected: census.inspected,
        unknown: census.unknown,
        censusBytes: bytes.length,
        detailsOmitted: true,
      })}\n`,
    );
  }
  return bytes;
}

// Export complete bounded evidence, not one artifact per Node isolate. The raw
// files stay private; a failed export still leaves its census and exact error.
export function publishInstalledTerminalEvidence(directory, summary) {
  const destination = path.join(directory, "export");
  const mode = installedRecoveryEvidenceMode(directory, true);
  fs.mkdirSync(destination, { mode });
  fs.chmodSync(destination, mode);
  const manifest = { status: "running", files: [], bytes: 0, omissions: [] };
  const read = (relative, limit) => {
    const file = path.join(directory, relative);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) {
      manifest.omissions.push(relative);
      assert.notEqual(summary.status, "passed", `Missing evidence: ${relative}`);
      return undefined;
    }
    assert(stat.isFile() && !stat.isSymbolicLink(), `Unsafe evidence: ${relative}`);
    assert(stat.size <= limit, `Evidence input exceeds ${limit} bytes: ${relative}`);
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.length, stat.size);
    return bytes;
  };
  const publish = (name, bytes, sources) => {
    assert(manifest.files.length < 94, "Evidence export exceeds 96 files including receipts");
    // Reserve 1 MiB for the manifest/summary and native tar framing. The native
    // 256-file/10-MiB cap remains authoritative, including outer phase reports.
    assert(manifest.bytes + bytes.length <= 7 * 1024 * 1024, "Evidence export exceeds 7 MiB");
    const fd = openInstalledRecoveryEvidence(path.join(destination, name));
    try {
      fs.writeFileSync(fd, bytes);
    } finally {
      fs.closeSync(fd);
    }
    manifest.files.push({ name, bytes: bytes.length, sha256: digest(bytes), sources });
    manifest.bytes += bytes.length;
  };
  const source = (name, bytes) => ({ name, bytes: bytes.length, sha256: digest(bytes) });
  let failure;
  try {
    for (const name of [
      "candidate-package-identity.json",
      "package-hasher-contract.json",
      "package-heartbeat-contracts.json",
      "installed-terminal-contracts.json",
      ...summary.cells.map(({ name: cellName }) => `${cellName}-dependencies.json`),
    ]) {
      const bytes = read(name, 4 * 1024 * 1024);
      if (bytes) {
        publish(name, bytes, [source(name, bytes)]);
      }
    }
    assert(summary.commands.length <= 24);
    for (const { name } of summary.commands) {
      assert(/^[a-z0-9-]+$/u.test(name));
      for (const suffix of ["out", "err"]) {
        const relative = `${name}.${suffix}`;
        const bytes = read(relative, 8 * 1024 * 1024);
        if (bytes) {
          publish(`${relative}.gz`, gzipSync(bytes), [source(relative, bytes)]);
        }
      }
    }
    for (const cell of summary.cells) {
      assert(["healthy", "late-failure", "historical-control"].includes(cell.name));
      const cellDirectory = fs.lstatSync(path.join(directory, cell.name));
      assert(cellDirectory.isDirectory() && !cellDirectory.isSymbolicLink());
      for (const name of [
        "observer.json",
        "observer-failed.json",
        "handoff.json",
        "launcher-intent.json",
        "launcher-replaced.json",
      ]) {
        const relative = `${cell.name}/${name}`;
        if (!fs.existsSync(path.join(directory, relative))) {
          continue;
        }
        const bytes = read(relative, 1024 * 1024);
        publish(`${cell.name}-${name}`, bytes, [source(relative, bytes)]);
      }
      const files = fs
        .readdirSync(path.join(directory, cell.name))
        .filter((name) => /^\d+-\d+\.jsonl$/u.test(name))
        .toSorted((a, b) => a.localeCompare(b));
      publish(
        `${cell.name}-isolate-census.json`,
        readIsolateCensus(path.join(directory, cell.name), files),
        [],
      );
      let selectedFiles = files;
      if (files.length > 256) {
        // Preserve launch identities before coverage can reject them. This is
        // diagnostic evidence only; exclusions still require the strict reader.
        const lifecycle = [];
        let lifecycleBytes = 0;
        let inputBytes = 0;
        let projectionError;
        for (const name of files) {
          try {
            const bytes = read(
              `${cell.name}/${name}`,
              Math.min(4 * 1024 * 1024, 32 * 1024 * 1024 - inputBytes),
            );
            inputBytes += bytes.length;
            const events = [];
            const lines = bytes.toString().split("\n");
            const terminated = lines.pop() === "";
            let parsedRecords = 0;
            let parseError;
            for (const line of lines) {
              try {
                const row = JSON.parse(line);
                parsedRecords++;
                if (
                  [
                    "startup",
                    "exit",
                    "spawn",
                    "spawn-exit",
                    "spawn-sync-return",
                    "spawn-close",
                    "thread",
                    "thread-exit",
                    "heartbeat-package",
                    "stdout",
                  ].includes(row.event)
                ) {
                  events.push(row);
                }
              } catch (error) {
                parseError = String(error).slice(0, 2048);
                break;
              }
            }
            const recordsComplete = terminated && !parseError;
            const line = Buffer.from(
              `${JSON.stringify({
                ...source(name, bytes),
                diagnosticOnly: true,
                qualification: "unaccepted",
                recordsComplete,
                parsedRecords,
                error: parseError ?? (terminated ? undefined : "Truncated record"),
                events,
              })}\n`,
            );
            // Leave space for a truthful footer even when the projection stops.
            assert(
              lifecycleBytes + line.length <= 4 * 1024 * 1024 - 4096,
              "Observer lifecycle evidence exceeds 4 MiB",
            );
            lifecycle.push(line);
            lifecycleBytes += line.length;
            if (!recordsComplete) {
              projectionError ??= "Observer lifecycle records are incomplete";
            }
          } catch (error) {
            projectionError ??= String(error).slice(0, 2048);
            break;
          }
        }
        const footer = Buffer.from(
          `${JSON.stringify({
            diagnosticOnly: true,
            qualification: "unaccepted",
            status: projectionError ? "incomplete" : "complete",
            files: files.length,
            projectedFiles: lifecycle.length,
            omittedFiles: files.length - lifecycle.length,
            sourceBytes: inputBytes,
            projectionBytes: lifecycleBytes,
            error: projectionError,
          })}\n`,
        );
        publish(
          `${cell.name}-lifetimes.jsonl.gz`,
          gzipSync(Buffer.concat([...lifecycle, footer])),
          [],
        );
        assert(
          fs.existsSync(path.join(directory, cell.name, "handoff.json")),
          `Observer export has ${files.length} isolates in ${cell.name}; limit 256`,
        );
        const observation = readObservation(
          path.join(directory, cell.name),
          JSON.parse(fs.readFileSync(path.join(directory, cell.name, "observer.json"), "utf8")),
        );
        assert(!projectionError, projectionError);
        selectedFiles = files.filter((name) => !observation.excluded.has(name));
      }
      const parts = [];
      const sources = [];
      let size = 0;
      for (const name of selectedFiles) {
        const relative = `${cell.name}/${name}`;
        const bytes = read(relative, 4 * 1024 * 1024);
        size += bytes.length;
        assert(size <= 32 * 1024 * 1024, `Observer export exceeds 32 MiB: ${cell.name}`);
        parts.push(bytes);
        sources.push(source(relative, bytes));
      }
      publish(`${cell.name}-observer.jsonl.gz`, gzipSync(Buffer.concat(parts)), sources);
    }
    manifest.status = "complete";
  } catch (error) {
    manifest.status = "failed";
    manifest.error = String(error);
    failure = { error };
  } finally {
    const censusBytes = Buffer.byteLength(`${JSON.stringify(manifest, null, 2)}\n`);
    const capError =
      censusBytes > 128 * 1024 ? new Error("Evidence manifest exceeds 128 KiB") : undefined;
    const report = capError
      ? {
          status: "failed",
          files: [],
          bytes: manifest.bytes,
          fileCount: manifest.files.length,
          censusOmitted: true,
          censusBytes,
          omissionCount: manifest.omissions.length,
          error: (manifest.error ?? String(capError)).slice(0, 16 * 1024),
          errorTruncated: (manifest.error ?? String(capError)).length > 16 * 1024,
        }
      : manifest;
    writeInstalledRecoveryEvidence(path.join(destination, "manifest.json"), report);
    console.error(`[installed-terminal] evidence-export ${JSON.stringify(report)}`);
    if (capError && !failure) {
      failure = { error: capError };
    }
  }
  if (failure) {
    throw failure.error;
  }
}
