// External process and SQLite observation preserves native behavior.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath, URL, URLSearchParams } from "node:url";
import { types } from "node:util";
import workerThreads from "node:worker_threads";
import { gzipSync } from "node:zlib";
import {
  fileIdentity,
  installedRecoveryEvidenceMode,
  openInstalledRecoveryEvidence,
  writeInstalledRecoveryEvidence,
} from "./installed-recovery-observations.mjs";
import {
  assertInstalledTerminalDependencyTree,
  readInstalledTerminalMetadata,
} from "./installed-terminal-contracts.mjs";
import {
  assertWorkerCellPackageIdentity,
  readWorkerCellPackageIdentity,
} from "./worker-cell-package.mjs";

const specPath = process.env.OPENCLAW_INSTALLED_TERMINAL_OBSERVER;
// Published 2026.10.9 uses this exact builtin-only inline package hash worker.
// Its empty environment intentionally prevents all ambient preloads.
const historicalHasherSha256 = "27908b03b67e1b9a820228dd69a1938eef0a1444f1d5ad2d4239010fb140b3c7";
const hasherRelativePath = "dist/infra/package-update-integrity-hasher.worker.js";
const heartbeatRelativePath = "dist/state/openclaw-state-lease-heartbeat.worker.js";
const closedEntryPaths = {
  "sqlite-session": "dist/infra/sqlite-readonly-location.worker.js",
  "finalizer-check": "dist/infra/update-migrated-finalize.worker.js",
};
const currentProbeSha256 = "8700a6c51bb2bd0040ec85d263d81ab1fd34057fa290290d568187ed945da1dc";
// Fixed 2026.10.9/SRI fixture: runtime-paths-CNOx8gw6 + node-sqlite-C2ThNhQ8
// emit this exact Node -e script. Its no-op selector and memory probe join locally.
const publishedProbeSha256 = "954fe0502bbd8beb9de99ca78dced72c87b9a8ebd6110dd62fc25ee19eeb61ce";
// These root modules are outside the dist inventory. Bind their complete published
// bytes separately; the same-named current helpers have different contracts.
const publishedWorkerRoots = {
  "published-sqlite-probe": {
    relativePath: "node-sqlite.mjs",
    sha256: "3f5dafe79cbd8d4b601a48ed8c0248ee7d15ee3f96800269617cd7e24fc39087",
  },
  "published-compile-cache": {
    relativePath: "node-compile-cache.mjs",
    sha256: "4b8842b79af6812f2e895ef458777db43591e96048859e3412717c28462fa9f7",
  },
};
const publishedSqliteWorkerSha256 =
  "59e299b2d4e33c5cc0aef06eb87fc986906d69cae24d2f72daa0f179da75a322";
const publishedProgressSha256 = "3f74e8b47c704a23722b1d6d444bfc189b15b36c88314a7e92d1943bcbc284c0";
const reviewedRevision = "7ef902d3b4126b2f1f5d58aaad3d1340b1e0315d";
const publishedRevision = "8b18b5578f66eab1501cba4cef2310d88bfb9a41";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const workerUrlDescriptors = Object.getOwnPropertyDescriptors(URL.prototype);
const workerSearchParamsDescriptors = Object.getOwnPropertyDescriptors(URLSearchParams.prototype);
const nativeArraySpecies = Object.getOwnPropertyDescriptor(Array, Symbol.species);
function nativePrototypeMatches(prototype, expected) {
  const actual = Object.getOwnPropertyDescriptors(prototype);
  return (
    Object.getPrototypeOf(prototype) === Object.prototype &&
    Reflect.ownKeys(actual).length === Reflect.ownKeys(expected).length &&
    Reflect.ownKeys(expected).every((key) =>
      ["get", "set", "value", "writable", "enumerable", "configurable"].every(
        (field) => actual[key]?.[field] === expected[key][field],
      ),
    )
  );
}

function inertNativeSlots(value) {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).every(
    (key) =>
      typeof key === "symbol" &&
      ![Symbol.toPrimitive, Symbol.toStringTag, Symbol.for("nodejs.util.inspect.custom")].includes(
        key,
      ) &&
      "value" in descriptors[key] &&
      typeof descriptors[key].value === "number",
  );
}

function workerEntrySnapshot(entry) {
  // Native URL detection reads inherited properties before consuming execArgv.
  // Only inert built-in URL inputs can bind a pre-construction launch snapshot.
  const hooks = ["href", "protocol", "auth", "path", Symbol.toPrimitive];
  if (
    hooks.some(
      (key) => Object.hasOwn(Object.prototype, key) || Object.hasOwn(String.prototype, key),
    )
  ) {
    return undefined;
  }
  if (typeof entry === "string") {
    return entry;
  }
  if (
    !entry ||
    types.isProxy(entry) ||
    Object.getPrototypeOf(entry) !== URL.prototype ||
    !nativePrototypeMatches(URL.prototype, workerUrlDescriptors) ||
    !inertNativeSlots(entry)
  ) {
    return undefined;
  }
  try {
    // URL serialization can consult the exposed searchParams object when dirty.
    // Inspect its descriptors before allowing native serialization to touch it.
    const params = Reflect.apply(workerUrlDescriptors.searchParams.get, entry, []);
    if (
      Object.getPrototypeOf(params) !== URLSearchParams.prototype ||
      !inertNativeSlots(params) ||
      !nativePrototypeMatches(URLSearchParams.prototype, workerSearchParamsDescriptors)
    ) {
      return undefined;
    }
    return Reflect.apply(workerUrlDescriptors.toString.value, entry, []);
  } catch {
    return undefined;
  }
}

// Snapshot metadata without invoking getters or Proxy traps. Unsupported shapes
// remain ordinary unqualified launches with their original native arguments.
// Child-process normalization spreads options, ignoring non-enumerable fields;
// Worker options retain their separate own-data contract.
function plainData(value, enumerableOnly = false) {
  if (!value || typeof value !== "object" || types.isProxy(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    return undefined;
  }
  if (
    prototype &&
    Object.values(Object.getOwnPropertyDescriptors(prototype)).some((entry) => entry.enumerable)
  ) {
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== "string" || !("value" in descriptors[key]),
    )
  ) {
    return undefined;
  }
  return Object.setPrototypeOf(
    Object.fromEntries(
      Object.entries(descriptors)
        .filter(([, entry]) => !enumerableOnly || entry.enumerable)
        .map(([key, entry]) => [key, entry.value]),
    ),
    null,
  );
}

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

function workerOptionsData(options) {
  const data = plainData(options);
  if (!data) {
    return undefined;
  }
  // Worker reads these properties directly, including non-enumerable inherited
  // values. Refuse hooks that could change argv before native initialization.
  const prototype = Object.getPrototypeOf(options);
  const nativeKeys = [
    "execArgv",
    "argv",
    "eval",
    "env",
    "name",
    "resourceLimits",
    "trackUnmanagedFds",
    "stdin",
    "stdout",
    "stderr",
    "transferList",
    "workerData",
  ];
  if (prototype && nativeKeys.some((key) => Object.hasOwn(prototype, key))) {
    return undefined;
  }
  return data;
}

function isolatedWorkerLaunch(data) {
  if (!data) {
    return undefined;
  }
  const env = plainData(data.env);
  const execArgv = plainArguments(data.execArgv);
  const keys = Object.keys(data).toSorted();
  if (
    !env ||
    Object.keys(env).length !== 0 ||
    !execArgv ||
    execArgv.length !== 0 ||
    (data.eval !== undefined && typeof data.eval !== "boolean") ||
    keys.some((key) => !["eval", "env", "execArgv", "workerData"].includes(key))
  ) {
    return undefined;
  }
  return { environment: "empty", execArgv, eval: data.eval === true, keys };
}

function publishedWorkerOptions(data) {
  if (!data) {
    return undefined;
  }
  const env = plainData(data.env);
  const execArgv = plainArguments(data.execArgv);
  const workerData = data.workerData === undefined ? undefined : plainData(data.workerData);
  return env && execArgv && (data.workerData === undefined || workerData)
    ? { ...data, env, execArgv, workerData }
    : undefined;
}

function isolatedWorkerRole(launch, role) {
  const allowed = ["eval", "env", "execArgv", "workerData"];
  return (
    launch?.environment === "empty" &&
    Array.isArray(launch.execArgv) &&
    launch.execArgv.length === 0 &&
    launch.eval === (role === "published-inline") &&
    Array.isArray(launch.keys) &&
    launch.keys.includes("env") &&
    launch.keys.includes("execArgv") &&
    launch.keys.every((key) => allowed.includes(key))
  );
}

function childLaunchSnapshot(argv, options, synchronous = false) {
  try {
    const values = argv === undefined ? [] : plainArguments(argv);
    const safeArguments =
      values &&
      (argv === undefined ||
        (Object.getPrototypeOf(argv) === Array.prototype &&
          !Object.hasOwn(argv, "constructor") &&
          Object.getOwnPropertyDescriptor(Array.prototype, "constructor")?.value === Array &&
          Object.getOwnPropertyDescriptor(Array, Symbol.species)?.get === nativeArraySpecies?.get));
    const data = plainData(options, true);
    const env = data && plainData(data.env);
    // Node slices argv, spreads options, then coerces cwd before reading env.
    // Copy inert launch facts now; getters must never become safe after consumption.
    const scalarKeys = [
      "cwd",
      "argv0",
      "detached",
      "uid",
      "gid",
      "shell",
      "windowsHide",
      "windowsVerbatimArguments",
      "timeout",
      "killSignal",
      "encoding",
      "serialization",
    ];
    // Async spawn ignores maxBuffer; Execa retains a per-stream array here.
    // Only spawnSync consumes it, so do not inspect async nested values.
    if (synchronous) {
      scalarKeys.push("maxBuffer");
    }
    const safeOptions =
      safeArguments &&
      data &&
      env &&
      Object.values(env).every((value) => value === undefined || typeof value === "string") &&
      scalarKeys.every(
        (key) => data[key] == null || ["string", "number", "boolean"].includes(typeof data[key]),
      ) &&
      (data.stdio == null || typeof data.stdio === "string" || plainArguments(data.stdio)) &&
      data.signal == null &&
      (data.input == null || typeof data.input === "string");
    return {
      argv: safeArguments ? values : null,
      options: safeOptions ? { ...data, env } : undefined,
    };
  } catch {
    return { argv: null, options: undefined };
  }
}

function closedLaunchEnvironment(data, role) {
  if (!data || (data.shell !== undefined && data.shell !== false)) {
    return false;
  }
  const env = data.env;
  if (
    !env ||
    Object.values(env).some((value) => typeof value !== "string" && value !== undefined)
  ) {
    return false;
  }
  const keys = Object.keys(env).filter((key) => env[key] !== undefined);
  if (role === "finalizer-check") {
    return keys.length === 1 && keys[0] === "OPENCLAW_CLI" && env.OPENCLAW_CLI === "1";
  }
  const allowed =
    role === "sqlite-session"
      ? [
          "OPENCLAW_STATE_DIR",
          "OPENCLAW_SUPERVISOR_MODE",
          "NODE_COMPILE_CACHE",
          "NODE_DISABLE_COMPILE_CACHE",
        ]
      : [
          "PATH",
          "SystemRoot",
          "SYSTEMROOT",
          "WINDIR",
          "TEMP",
          "TMP",
          "TMPDIR",
          "HOMEBREW_PREFIX",
          "OPENCLAW_SQLITE_LIBRARY",
          "OPENCLAW_CLI",
        ];
  return keys.every((key) => allowed.includes(key));
}
function containsPath(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function physicalAncestors(target) {
  if (typeof target !== "string" || !path.isAbsolute(target) || path.resolve(target) !== target) {
    return false;
  }
  // Reject an external hop even if a later symlink returns inside the cache.
  // Missing descendants may be created by the published maintenance owner.
  for (let current = target; ; current = path.dirname(current)) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || fs.realpathSync(current) !== current) {
        return false;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        return false;
      }
    }
    if (current === path.dirname(current)) {
      return true;
    }
  }
}

function publishedCacheScope(directory, spec) {
  const base = spec.compileCacheBase;
  if (!physicalAncestors(base) || !physicalAncestors(directory) || !containsPath(base, directory)) {
    return undefined;
  }
  for (const file of [spec.stateDatabase, spec.agentDatabase, spec.journal]) {
    if (
      !physicalAncestors(file) ||
      containsPath(base, path.dirname(file)) ||
      containsPath(path.dirname(file), base)
    ) {
      return undefined;
    }
  }
  return { base, directory, ancestorsPhysical: true, stateDisjoint: true };
}

function publishedEnvironment(options, spec, progress = false) {
  const env = plainData(options.env);
  if (
    !env ||
    Object.values(env).some((value) => typeof value !== "string" && value !== undefined)
  ) {
    return undefined;
  }
  for (const [key, value] of Object.entries(env)) {
    if (!value) {
      continue;
    }
    if (key.toUpperCase() === "NODE_OPTIONS") {
      if (
        !progress ||
        key !== "NODE_OPTIONS" ||
        value !== `--import=${fileURLToPath(import.meta.url)}` ||
        env.OPENCLAW_INSTALLED_TERMINAL_OBSERVER !== specPath
      ) {
        return undefined;
      }
    } else if (
      /^(BUN_OPTIONS|NODE_V8_COVERAGE|NODE_REDIRECT_WARNINGS)$/iu.test(key) ||
      (progress && /^(LD_|OPENSSL_CONF$|OPENSSL_MODULES$)/iu.test(key))
    ) {
      return undefined;
    }
  }
  const cache =
    env.NODE_COMPILE_CACHE === undefined ? null : publishedCacheScope(env.NODE_COMPILE_CACHE, spec);
  return cache === undefined ? undefined : { environmentQualified: true, inheritedCache: cache };
}

function isHeartbeatPackageRoot(root, spec) {
  // prepareStagedPackageInstall owns this npm prefix beneath the task's global
  // root. A foreign identical entry is not an admitted source of shared chunks.
  return (
    typeof root === "string" &&
    typeof spec.root === "string" &&
    path.resolve(root) === root &&
    (root === spec.root ||
      /^\.openclaw\.update-stage-[^/]+\/lib\/node_modules\/openclaw$/u.test(
        path.relative(path.dirname(spec.root), root),
      ))
  );
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
  for (const key of [
    "directory",
    "root",
    "bin",
    "journal",
    "stateDatabase",
    "agentDatabase",
    "escrow",
  ]) {
    assert(path.isAbsolute(spec[key]) && path.resolve(spec[key]) === spec[key]);
  }
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
  const heartbeatFacts = (root) => {
    assert(isHeartbeatPackageRoot(root, spec), "Heartbeat package root is outside task custody");
    assert.equal(fs.realpathSync(root), root);
    const manifest = path.join(root, "package.json");
    const stat = fs.lstatSync(manifest);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024);
    return {
      rootIdentity: fileIdentity(root),
      manifestIdentity: fileIdentity(manifest),
      manifestSha256: digest(fs.readFileSync(manifest)),
    };
  };
  const heartbeatReceipt = (facts) =>
    path.join(spec.directory, `heartbeat-${digest(JSON.stringify(facts))}.json`);
  const readHeartbeatReceipt = (root, facts) => {
    const file = heartbeatReceipt(facts);
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8192);
    const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(heartbeatFacts(root), facts);
    assert.deepEqual(
      {
        rootIdentity: receipt.rootIdentity,
        manifestIdentity: receipt.manifestIdentity,
        manifestSha256: receipt.manifestSha256,
      },
      facts,
    );
    assert(isHeartbeatPackageRoot(receipt.qualifiedRoot, spec));
    assert(
      spec.heartbeatWorkers.some(
        (contract) =>
          contract.sha256 === receipt.sha256 &&
          contract.inventorySha256 === receipt.inventorySha256 &&
          contract.sourceCommit === receipt.sourceCommit &&
          contract.dependencies.sha256 === receipt.dependencySha256 &&
          contract.dependencyReferenceSha256 === receipt.dependencyReferenceSha256,
      ),
    );
    assert.equal(fileIdentity(path.join(root, "node_modules")), receipt.dependencyIdentity);
    return receipt;
  };
  let qualifiedApplication;
  const qualifyHeartbeatPackage = () => {
    if (!spec.heartbeatWorkers || !workerThreads.isMainThread || !process.argv[1]) {
      return;
    }
    let entry = path.resolve(process.argv[1]);
    if (entry === spec.bin) {
      // The installed CLI enters through this one journal-bound npm launcher.
      entry = fs.realpathSync(entry);
      assert.equal(
        entry,
        path.join(spec.root, "openclaw.mjs"),
        "Installed launcher does not select the admitted package",
      );
    }
    let root = path.dirname(entry);
    while (root !== path.dirname(root) && !isHeartbeatPackageRoot(root, spec)) {
      root = path.dirname(root);
    }
    if (!isHeartbeatPackageRoot(root, spec)) {
      return;
    }
    // npm lifecycle children inherit this preload, including extensionless
    // entries. Only application mains can qualify the inventoried package.
    const relativeEntry = path.relative(root, entry);
    if (relativeEntry !== "openclaw.mjs" && !relativeEntry.startsWith(`dist${path.sep}`)) {
      return;
    }
    assert.equal(fs.realpathSync(entry), entry);
    const facts = heartbeatFacts(root);
    const file = heartbeatReceipt(facts);
    if (!fs.existsSync(file)) {
      // Qualify before any product code or Worker starts. Activation renames
      // the same physical package; its receipt follows identity, not a path.
      const actual = readWorkerCellPackageIdentity(root);
      const inventorySha256 = digest(JSON.stringify(actual.files));
      const contract = spec.heartbeatWorkers.find(
        (item) => item.inventorySha256 === inventorySha256,
      );
      assert(contract, "Unqualified heartbeat package root");
      const inventoryStat = fs.lstatSync(contract.inventory.path);
      assert(
        inventoryStat.isFile() &&
          !inventoryStat.isSymbolicLink() &&
          inventoryStat.size <= 4 * 1024 * 1024,
      );
      const inventory = fs.readFileSync(contract.inventory.path);
      assert.equal(digest(inventory), contract.inventory.sha256);
      assertWorkerCellPackageIdentity(actual, JSON.parse(inventory));
      const dependencies = assertInstalledTerminalDependencyTree(root, contract.dependencies);
      const metadata = readInstalledTerminalMetadata(root, actual);
      assert.deepEqual(heartbeatFacts(root), facts);
      const receipt = {
        qualifiedRoot: root,
        ...facts,
        sha256: contract.sha256,
        inventorySha256,
        sourceCommit: contract.sourceCommit,
        dependencyIdentity: dependencies.identity,
        dependencySha256: dependencies.sha256,
        dependencyReferenceSha256: contract.dependencyReferenceSha256,
        metadata,
      };
      const temporary = `${file}.${process.pid}-${thread}.tmp`;
      const receiptFd = openInstalledRecoveryEvidence(temporary);
      try {
        fs.writeFileSync(receiptFd, JSON.stringify(receipt));
      } finally {
        fs.closeSync(receiptFd);
      }
      try {
        // A hard link publishes only completed bytes. A racing preload reads
        // and validates the completed same-identity receipt; it never overwrites.
        try {
          fs.linkSync(temporary, file);
        } catch (error) {
          if (error.code !== "EEXIST") {
            throw error;
          }
        }
      } finally {
        fs.unlinkSync(temporary);
      }
    }
    qualifiedApplication = { root, ...readHeartbeatReceipt(root, facts) };
    report("heartbeat-package", qualifiedApplication);
  };
  const publishedWorker = (entry, options) => {
    if (!spec.historical || qualifiedApplication?.sourceCommit !== publishedRevision) {
      return undefined;
    }
    const data = plainData(options);
    const execArgv = data && plainArguments(data.execArgv);
    if (
      !data ||
      !execArgv ||
      Object.keys(data).some((key) => !["eval", "env", "execArgv", "workerData"].includes(key))
    ) {
      return undefined;
    }
    const environment = publishedEnvironment(data, spec);
    if (!environment) {
      return undefined;
    }
    let role;
    let cache;
    if (
      data.eval === true &&
      data.workerData === undefined &&
      digest(entry) === publishedSqliteWorkerSha256 &&
      (execArgv.length === 0 || (execArgv.length === 1 && execArgv[0] === "--experimental-sqlite"))
    ) {
      role = "published-sqlite-probe";
    } else if (
      (data.eval === undefined || data.eval === false) &&
      execArgv.length === 0 &&
      locationOf(entry) === path.join(qualifiedApplication.root, "node-compile-cache.mjs")
    ) {
      const workerData = plainData(data.workerData);
      if (!workerData || Object.keys(workerData).length !== 1) {
        return undefined;
      }
      cache = publishedCacheScope(workerData.openclawCompileCacheDirectory, spec);
      if (
        !cache ||
        path.dirname(path.dirname(cache.directory)) !== path.join(cache.base, "openclaw") ||
        !/^[A-Za-z0-9._-]+$/u.test(path.basename(path.dirname(cache.directory))) ||
        !/^(?:[a-f0-9]{16}|\d+-\d+|no-package-json|build-[A-Za-z0-9._-]+)$/u.test(
          path.basename(cache.directory),
        )
      ) {
        return undefined;
      }
      role = "published-compile-cache";
    } else {
      return undefined;
    }
    const expected = publishedWorkerRoots[role];
    const helperFile = path.join(qualifiedApplication.root, expected.relativePath);
    const stat = fs.lstatSync(helperFile);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16 * 1024);
    assert.equal(fs.realpathSync(helperFile), helperFile);
    const source = fs.readFileSync(helperFile, "utf8");
    assert.equal(digest(source), expected.sha256, "Published root helper changed");
    return {
      ...qualifiedApplication,
      role,
      ...environment,
      cache,
      launch: { eval: data.eval ?? false, execArgv, workerDataDirectory: cache?.directory ?? null },
      rootEntry: { ...expected, identity: fileIdentity(helperFile), source },
    };
  };
  workerThreads.Worker = new Proxy(original.Worker, {
    construct(target, args, newTarget) {
      // Native construction can invoke workerData clone getters after consuming
      // loader flags. Capture inert descriptors first; forward original inputs.
      const entry = workerEntrySnapshot(args[0]);
      const options = workerOptionsData(args[1]);
      const launch = entry === undefined ? undefined : isolatedWorkerLaunch(options);
      const publishedOptions = entry === undefined ? undefined : publishedWorkerOptions(options);
      const child = Reflect.construct(target, args, newTarget);
      observe("thread", () => {
        const childThread = child.threadId;
        let packageHasher;
        if (
          isolatedWorkerRole(launch, "installed-file") &&
          spec.hashWorker &&
          locationOf(entry) === spec.hashWorker.path
        ) {
          const workerBytes = fs.readFileSync(spec.hashWorker.path);
          assert(workerBytes.length <= 64 * 1024);
          packageHasher = { kind: "installed-file", sha256: digest(workerBytes), launch };
        } else if (
          isolatedWorkerRole(launch, "published-inline") &&
          spec.historical &&
          digest(entry) === historicalHasherSha256
        ) {
          packageHasher = { kind: "published-inline", sha256: historicalHasherSha256, launch };
        }
        report("thread", {
          childThread,
          entry: entry ?? "unknown",
          packageHasher,
          packageEntry: entry === undefined ? undefined : publishedWorker(entry, publishedOptions),
        });
        child.once("exit", (code) => report("thread-exit", { childThread, code }));
      });
      return child;
    },
  });
  let spawnId = 0;
  const nativeOperation = (command, argv, data) => {
    const env = data?.env;
    // Node's sole --version operation returns in native initialization, before
    // JS or preloads. An explicit empty environment excludes native loaders too.
    return !process.versions.bun &&
      command === process.execPath &&
      argv?.length === 1 &&
      argv[0] === "--version" &&
      data &&
      (data.shell === undefined || data.shell === false) &&
      env &&
      Object.keys(env).length === 0
      ? { kind: "node-version", executable: process.execPath, version: process.version }
      : undefined;
  };
  childProcess.spawnSync = function (...args) {
    const launch = childLaunchSnapshot(args[1], args[2], true);
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
      const { argv } = launch;
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
        nativeOperation: nativeOperation(command, argv, launch.options),
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
  const closedEntry = (argv, options) => {
    if (!spec.heartbeatWorkers || !Array.isArray(argv) || types.isProxy(argv)) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(argv);
    if (
      argv.length > 3 ||
      !Array.from({ length: argv.length }, (_, index) => descriptors[index]).every(
        (entry) => entry && "value" in entry && typeof entry.value === "string",
      )
    ) {
      return undefined;
    }
    const values = Array.from({ length: argv.length }, (_, index) => descriptors[index].value);
    if (
      spec.historical &&
      qualifiedApplication?.sourceCommit === publishedRevision &&
      values.length === 2 &&
      values[0] === "-e" &&
      Buffer.byteLength(values[1]) <= 64 * 1024 &&
      digest(values[1]) === publishedProbeSha256
    ) {
      return {
        ...qualifiedApplication,
        role: "published-node-probe",
        sha256: publishedProbeSha256,
        environmentQualified: closedLaunchEnvironment(options, "published-node-probe"),
      };
    }
    if (
      spec.historical &&
      qualifiedApplication?.sourceCommit === publishedRevision &&
      values.length === 3 &&
      values[0] === "--input-type=commonjs" &&
      values[1] === "--eval" &&
      digest(values[2]) === publishedProgressSha256
    ) {
      const data = options;
      const environment =
        data &&
        (data.shell === undefined || data.shell === false) &&
        publishedEnvironment(data, spec, true);
      return environment
        ? {
            ...qualifiedApplication,
            role: "published-copy-progress",
            sha256: publishedProgressSha256,
            ...environment,
          }
        : undefined;
    }
    if (
      values.length === 3 &&
      values[1] === "node" &&
      values[2] === "" &&
      path.basename(values[0]) === "daemon-runtime-probe.mjs"
    ) {
      const stat = fs.lstatSync(values[0]);
      assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024);
      assert.equal(fs.realpathSync(values[0]), values[0]);
      const probeBytes = fs.readFileSync(values[0]);
      const source = probeBytes.toString("utf8");
      assert(probeBytes.equals(Buffer.from(source)));
      return {
        role: "node-runtime-probe",
        sha256: digest(probeBytes),
        source,
        environmentQualified: closedLaunchEnvironment(options, "node-runtime-probe"),
      };
    }
    const role =
      values.length === 3 &&
      values[1] === "--openclaw-sqlite-readonly-child" &&
      values[2] === "session"
        ? "sqlite-session"
        : values.length === 2 && values[1] === "--check"
          ? "finalizer-check"
          : undefined;
    const relativePath = closedEntryPaths[role];
    if (!relativePath || !values[0].endsWith(`/${relativePath}`)) {
      return undefined;
    }
    const root = values[0].slice(0, -relativePath.length - 1);
    // Snapshot children retain ordinary startup/lifetime coverage. Only an
    // admitted installed root may supply the missing-startup qualification.
    if (!isHeartbeatPackageRoot(root, spec)) {
      return undefined;
    }
    const receipt = readHeartbeatReceipt(root, heartbeatFacts(root));
    const contract = spec.heartbeatWorkers
      .find(
        (item) =>
          item.inventorySha256 === receipt.inventorySha256 &&
          item.sourceCommit === receipt.sourceCommit,
      )
      ?.closedEntries?.find((item) => item.role === role);
    if (!contract) {
      return undefined;
    }
    const stat = fs.lstatSync(values[0]);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024);
    assert.equal(fs.realpathSync(values[0]), values[0]);
    const entrySha256 = digest(fs.readFileSync(values[0]));
    assert.equal(entrySha256, contract.sha256);
    return {
      root,
      ...receipt,
      role,
      relativePath,
      entrySha256,
      contractRevision: contract.contractRevision,
      environmentQualified: closedLaunchEnvironment(options, role),
    };
  };
  childProcess.spawn = function (...args) {
    const launch = childLaunchSnapshot(args[1], args[2]);
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
      const { argv } = launch;
      const nodeChild = args[0] === process.execPath || path.basename(args[0]) === "node";
      const packageEntry =
        args[0] === process.execPath ? closedEntry(argv, launch.options) : undefined;
      report("spawn", {
        spawnId: id,
        child: pid,
        nodeChild,
        command: args[0],
        argv,
        packageEntry,
        nativeOperation: nativeOperation(args[0], argv, launch.options),
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
  observe("heartbeat-package", qualifyHeartbeatPackage);
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

// A single source-qualified builtin leaf may lack the ambient preload. Reject
// unexpected emitted edges before any installed cell; never follow a new graph.
export function readInstalledTerminalHasher(root, identity, capture) {
  const file = path.join(root, hasherRelativePath);
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024);
  assert.equal(fs.realpathSync(file), file);
  const bytes = fs.readFileSync(file);
  const sha256 = digest(bytes);
  assert.equal(sha256, identity.files[hasherRelativePath]?.sha256);
  const source = bytes.toString("utf8");
  const contract = { path: file, sha256, source };
  capture?.(contract);
  const imports = [];
  const body = source
    .replace(/\bimport\s*([^;"']+?)\s*from\s*["']([^"']+)["']\s*;?/gu, (whole, clause, name) => {
      imports.push(name);
      return "";
    })
    // The emitted worker ends with this inert ESM marker, not a loader edge.
    .replace(/\nexport \{\};\n$/u, "\n");
  assert.deepEqual(
    imports.toSorted((a, b) => a.localeCompare(b)),
    ["node:crypto", "node:fs", "node:worker_threads"],
  );
  assert(
    !/\b(?:import|export|require|eval|Function|process|globalThis)\b/u.test(body),
    "Package hash worker has an unqualified emitted edge",
  );
  return contract;
}

export function readInstalledTerminalEvents(directory, spec = {}) {
  return readObservation(directory, spec).rows;
}

// This state-capable worker deliberately has no ambient preload. Its selected
// Linux/Node SQLite closure has no escaping subprocess; native exit joins any
// nested Workers. Package bytes alone never exempt an in-window predecessor.
export function readInstalledTerminalHeartbeat(root, identity) {
  const file = path.join(root, heartbeatRelativePath);
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024);
  assert.equal(fs.realpathSync(file), file);
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.length, stat.size);
  const sha256 = digest(bytes);
  assert.equal(sha256, identity.files[heartbeatRelativePath]?.sha256);
  const source = bytes.toString("utf8");
  assert(bytes.equals(Buffer.from(source)), "Heartbeat entry is not complete UTF-8 source");
  return {
    relativePath: heartbeatRelativePath,
    sha256,
    source,
    sourceCommit: identity.buildInfo.commit,
    inventorySha256: digest(JSON.stringify(identity.files)),
  };
}

// These are reviewed Linux/Node owners, not a filename permitlist. SQLite's
// finite session handlers join synchronous snapshot descendants; current --check
// initializes only bookkeeping/lazy owners, including the empty disk-budget pool.
export function readInstalledTerminalClosedEntries(root, identity, historical = false) {
  if (historical) {
    assert.equal(identity.buildInfo.commit, publishedRevision);
  }
  return Object.entries(closedEntryPaths)
    .filter(([role]) => !historical || role === "sqlite-session")
    .map(([role, relativePath]) => {
      const file = path.join(root, relativePath);
      const stat = fs.lstatSync(file);
      assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024);
      assert.equal(fs.realpathSync(file), file);
      const bytes = fs.readFileSync(file);
      const sha256 = digest(bytes);
      assert.equal(bytes.length, stat.size);
      assert.equal(sha256, identity.files[relativePath]?.sha256);
      const source = bytes.toString("utf8");
      assert(bytes.equals(Buffer.from(source)));
      return {
        role,
        relativePath,
        sha256,
        source,
        contractRevision: historical ? publishedRevision : reviewedRevision,
      };
    });
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
  const heartbeatCoverage = new Map();
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
  const qualifiedPackageEntry = (entry, row, own = false) => {
    const packageContract = spec.heartbeatWorkers?.find(
      (item) =>
        entry &&
        item.inventorySha256 === entry.inventorySha256 &&
        item.sourceCommit === entry.sourceCommit,
    );
    return (
      entry &&
      /^[a-f0-9]{64}$/u.test(entry.dependencySha256) &&
      /^[a-f0-9]{64}$/u.test(entry.dependencyReferenceSha256) &&
      /^\d+:\d+$/u.test(entry.dependencyIdentity) &&
      packageContract?.dependencies?.sha256 === entry.dependencySha256 &&
      packageContract?.dependencyReferenceSha256 === entry.dependencyReferenceSha256 &&
      isHeartbeatPackageRoot(entry.root, spec) &&
      /^\d+:\d+$/u.test(entry.rootIdentity) &&
      rows.some(
        (qualified) =>
          qualified.event === "heartbeat-package" &&
          (!own || (qualified.pid === row.pid && qualified.thread === row.thread)) &&
          BigInt(qualified.time) < BigInt(row.time) &&
          [
            "qualifiedRoot",
            "rootIdentity",
            "manifestIdentity",
            "manifestSha256",
            "inventorySha256",
            "sourceCommit",
            "dependencyIdentity",
            "dependencySha256",
            "dependencyReferenceSha256",
          ].every((key) => qualified[key] === entry[key]),
      )
    );
  };
  const recordedCache = (cache) =>
    cache === null ||
    (cache &&
      cache.base === spec.compileCacheBase &&
      typeof cache.directory === "string" &&
      cache.ancestorsPhysical === true &&
      cache.stateDisjoint === true &&
      containsPath(cache.base, cache.directory));
  const publishedParent = (entry, row) =>
    spec.historical === true &&
    entry?.sourceCommit === publishedRevision &&
    entry.environmentQualified === true &&
    recordedCache(entry.inheritedCache) &&
    qualifiedPackageEntry(entry, row, true);
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
      const ownerStarts = startups.filter(
        (start) => start.pid === row.pid && start.thread === row.thread,
      );
      const operation = row.nativeOperation;
      if (
        operation?.kind === "node-version" &&
        ownerStarts.length === 1 &&
        operation.executable === ownerStarts[0].argv[0] &&
        operation.version === ownerStarts[0].node &&
        row.command === operation.executable &&
        row.argv?.length === 1 &&
        row.argv[0] === "--version" &&
        nativeExit?.code === 0 &&
        nativeExit.signal === null &&
        (row.api !== "spawnSync" || nativeExit.errorCode === null) &&
        !lifetimeBounds.has(row) &&
        handoff &&
        BigInt(nativeExit.time) < BigInt(handoff.time) &&
        rows.filter((event) => event.event === "spawn" && event.child === row.child).length === 1 &&
        rows.every((event) => event.pid !== row.child)
      ) {
        heartbeatCoverage.set(row, { role: "node-version", reason: "native-before-js" });
      }
      const entry = row.packageEntry;
      const packageContract = spec.heartbeatWorkers?.find(
        (item) =>
          entry &&
          item.inventorySha256 === entry.inventorySha256 &&
          item.sourceCommit === entry.sourceCommit,
      );
      const contract = packageContract?.closedEntries?.find((item) => item.role === entry.role);
      const mode =
        entry?.role === "sqlite-session"
          ? ["--openclaw-sqlite-readonly-child", "session"]
          : ["--check"];
      const qualifiedPackage = qualifiedPackageEntry(entry, row);
      const boundPackageEntry =
        contract &&
        entry.environmentQualified === true &&
        contract.relativePath === closedEntryPaths[entry.role] &&
        contract.contractRevision === entry.contractRevision &&
        (entry.contractRevision === reviewedRevision ||
          (entry.role === "sqlite-session" &&
            entry.contractRevision === publishedRevision &&
            entry.sourceCommit === publishedRevision)) &&
        entry.entrySha256 === contract.sha256 &&
        qualifiedPackage &&
        row.argv?.length === mode.length + 1 &&
        row.argv[0] === path.join(entry.root, contract.relativePath) &&
        mode.every((value, index) => row.argv[index + 1] === value);
      const boundProbe =
        entry?.role === "node-runtime-probe" &&
        entry.environmentQualified === true &&
        typeof entry.source === "string" &&
        Buffer.byteLength(entry.source) <= 64 * 1024 &&
        entry.sha256 === currentProbeSha256 &&
        digest(entry.source) === currentProbeSha256 &&
        row.argv?.length === 3 &&
        path.basename(row.argv[0]) === "daemon-runtime-probe.mjs" &&
        row.argv[1] === "node" &&
        row.argv[2] === "";
      const boundPublishedProbe =
        spec.historical === true &&
        qualifiedPackage &&
        entry.role === "published-node-probe" &&
        entry.environmentQualified === true &&
        entry.sourceCommit === publishedRevision &&
        entry.sha256 === publishedProbeSha256 &&
        rows.some(
          (qualified) =>
            qualified.event === "heartbeat-package" &&
            qualified.pid === row.pid &&
            qualified.thread === row.thread &&
            qualified.sourceCommit === publishedRevision &&
            qualified.inventorySha256 === entry.inventorySha256 &&
            BigInt(qualified.time) < BigInt(row.time),
        ) &&
        spec.heartbeatWorkers?.some(
          (item) =>
            item.sourceCommit === publishedRevision &&
            item.inventorySha256 === entry.inventorySha256,
        ) &&
        row.argv?.length === 2 &&
        row.argv[0] === "-e" &&
        typeof row.argv[1] === "string" &&
        Buffer.byteLength(row.argv[1]) <= 64 * 1024 &&
        digest(row.argv[1]) === publishedProbeSha256;
      // The published I/O monitor reads directory metadata only and joins its
      // cancellation. SIGKILL bounds that exact script, not a successful result
      // or a general missing-preload child.
      const boundProgress =
        publishedParent(entry, row) &&
        entry.role === "published-copy-progress" &&
        entry.sha256 === publishedProgressSha256 &&
        row.argv?.length === 3 &&
        row.argv[0] === "--input-type=commonjs" &&
        row.argv[1] === "--eval" &&
        digest(row.argv[2]) === publishedProgressSha256;
      const closes = rows.filter(
        (event) =>
          event.event === "spawn-close" &&
          event.pid === row.pid &&
          event.thread === row.thread &&
          event.spawnId === row.spawnId,
      );
      const close = closes[0];
      const settledBefore =
        handoff &&
        nativeExit?.event === "spawn-exit" &&
        ((nativeExit.code === 0 && nativeExit.signal === null) ||
          (boundProgress && nativeExit.code === null && nativeExit.signal === "SIGKILL")) &&
        nativeExit.spawned === true &&
        closes.length === 1 &&
        close.child === row.child &&
        close.spawned === true &&
        close.code === nativeExit.code &&
        close.signal === nativeExit.signal &&
        BigInt(close.time) >= BigInt(nativeExit.time) &&
        BigInt(close.time) < BigInt(handoff.time) &&
        BigInt(close.time) < BigInt(ownerExit(row).time);
      if (
        !startups.some((start) => start.pid === row.child) &&
        (boundPackageEntry || boundProbe || boundPublishedProbe || boundProgress) &&
        settledBefore
      ) {
        heartbeatCoverage.set(row, {
          role: entry.role,
          reason: "settled-before-handoff",
          contractRevision:
            entry.contractRevision ??
            (boundPublishedProbe || boundProgress ? publishedRevision : reviewedRevision),
          sourceCommit: entry.sourceCommit,
          sha256: entry.entrySha256 ?? entry.sha256,
        });
      }
      assert(
        startups.some((start) => start.pid === row.child) || heartbeatCoverage.has(row),
        "Missing Node child preload coverage",
      );
      if (row.api === "spawnSync" && !heartbeatCoverage.has(row)) {
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
    const admittedFile =
      isolatedWorkerRole(row.packageHasher?.launch, "installed-file") &&
      row.packageHasher?.kind === "installed-file" &&
      spec.hashWorker &&
      locationFromEntry(row.entry) === spec.hashWorker.path &&
      row.packageHasher.sha256 === spec.hashWorker.sha256;
    const admittedInline =
      isolatedWorkerRole(row.packageHasher?.launch, "published-inline") &&
      spec.historical === true &&
      row.packageHasher?.kind === "published-inline" &&
      row.packageHasher.sha256 === historicalHasherSha256 &&
      digest(row.entry) === historicalHasherSha256;
    const entry = row.packageEntry;
    const rootEntry = entry?.rootEntry;
    const expectedRoot = publishedWorkerRoots[entry?.role];
    const publishedWorker =
      publishedParent(entry, row) &&
      expectedRoot &&
      rootEntry?.relativePath === expectedRoot.relativePath &&
      rootEntry.sha256 === expectedRoot.sha256 &&
      typeof rootEntry.source === "string" &&
      Buffer.byteLength(rootEntry.source) <= 16 * 1024 &&
      digest(rootEntry.source) === expectedRoot.sha256 &&
      /^\d+:\d+$/u.test(rootEntry.identity) &&
      ((entry.role === "published-sqlite-probe" &&
        digest(row.entry) === publishedSqliteWorkerSha256 &&
        entry.launch?.eval === true &&
        entry.launch.workerDataDirectory === null &&
        Array.isArray(entry.launch.execArgv) &&
        (entry.launch.execArgv.length === 0 ||
          (entry.launch.execArgv.length === 1 &&
            entry.launch.execArgv[0] === "--experimental-sqlite"))) ||
        (entry.role === "published-compile-cache" &&
          entry.launch?.eval === false &&
          Array.isArray(entry.launch.execArgv) &&
          entry.launch.execArgv.length === 0 &&
          entry.launch.workerDataDirectory === entry.cache?.directory &&
          locationFromEntry(row.entry) === path.join(entry.root, expectedRoot.relativePath) &&
          entry.cache &&
          recordedCache(entry.cache) &&
          path.dirname(path.dirname(entry.cache.directory)) ===
            path.join(entry.cache.base, "openclaw")));
    const before = handoff && BigInt(nativeExit.time) < BigInt(handoff.time);
    if (
      publishedWorker &&
      before &&
      nativeExit.event === "thread-exit" &&
      nativeExit.code === 0 &&
      !lifetimeBounds.has(row)
    ) {
      heartbeatCoverage.set(row, {
        role: entry.role,
        reason: "settled-before-handoff",
        sourceCommit: publishedRevision,
        sha256: rootEntry.sha256,
      });
    } else {
      assert(admittedFile || admittedInline, "Missing worker-thread preload coverage");
    }
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
        heartbeatCoverage.has(row) || lifetimeBounds.has(row)
          ? Object.assign({}, row, {
              ...(heartbeatCoverage.has(row) ? { coverage: heartbeatCoverage.get(row) } : {}),
              ...(lifetimeBounds.has(row) ? { lifetimeBound: lifetimeBounds.get(row) } : {}),
            })
          : row,
      )
      .toSorted((a, b) =>
        BigInt(a.time) < BigInt(b.time) ? -1 : BigInt(a.time) > BigInt(b.time) ? 1 : 0,
      ),
  };
}

function locationFromEntry(entry) {
  return entry.startsWith("file:") ? fileURLToPath(new URL(entry)) : path.resolve(entry);
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
