// Passive release-cell observation. Product ownership, protocol and bytes stay unchanged.
import assert from "node:assert/strict";
import { createHook, executionAsyncId } from "node:async_hooks";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const marker = "--openclaw-sqlite-readonly-child";
const captureStackTrace = Error.captureStackTrace.bind(Error);
const now = () => String(process.hrtime.bigint());

function frames() {
  const previous = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  /** @type {{ stack?: NodeJS.CallSite[] }} */
  const captured = {};
  try {
    Object.defineProperty(Error, "prepareStackTrace", {
      configurable: true,
      writable: true,
      value: (_error, sites) => sites,
    });
    captureStackTrace(captured, frames);
    return (captured.stack ?? []).map((site) => ({
      name: site.getFunctionName(),
      file: site.getFileName(),
      line: site.getLineNumber(),
    }));
  } finally {
    if (previous) {
      Object.defineProperty(Error, "prepareStackTrace", previous);
    } else {
      delete Error.prepareStackTrace;
    }
  }
}

/** @param {unknown} file */
export function snapshotFsPath(file) {
  if (typeof file === "string") {
    return path.resolve(file);
  }
  if (file instanceof URL) {
    return fileURLToPath(file);
  }
  if (Buffer.isBuffer(file)) {
    return path.resolve(file.toString("utf8"));
  }
  return undefined;
}

export function snapshotProcessStart(pid) {
  assert(Number.isSafeInteger(pid) && pid > 1, "Missing native process identity");
  const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  assert.match(start, /^[0-9]+$/u);
  return start;
}

/** @param {unknown} args */
function readRequestArgs(args) {
  if (
    !Array.isArray(args) ||
    args.length !== 3 ||
    args[0] !== "sync" ||
    !args.every((arg) => typeof arg === "string")
  ) {
    return undefined;
  }
  return { source: path.resolve(args[1]), stagingRoot: path.resolve(args[2]) };
}

export function readSnapshotWorkerLaunch(argv) {
  const index = argv.indexOf(marker);
  if (index < 1) {
    return undefined;
  }
  const args = argv.slice(index + 1);
  if (args.length === 1 && args[0] === "session") {
    return { entrypoint: argv[index - 1], transport: "ipc" };
  }
  const request = readRequestArgs(args);
  return request ? { entrypoint: argv[index - 1], transport: "one-shot", ...request } : undefined;
}

/** The lookup key locates an observation; process births and caller facts admit it. */
function snapshotRequestKey(request) {
  return createHash("sha256")
    .update(JSON.stringify([request.stagingRoot, request.transport, request.ipcRequestId ?? null]))
    .digest("hex");
}

/** @param {unknown} result */
export function snapshotFailure(result) {
  return result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    Object.keys(result).length === 2 &&
    "ok" in result &&
    result.ok === false &&
    "message" in result &&
    typeof result.message === "string"
    ? result.message
    : undefined;
}

function snapshotResultDigest(result) {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

export function observeSnapshotAllocations(source, currentRequest, onAcquisition) {
  const allocate = fs.mkdtempSync;
  fs.mkdtempSync = (...args) => {
    const directory = allocate(...args);
    const request = currentRequest();
    if (
      request?.source === source &&
      path.dirname(directory) === request.stagingRoot &&
      path.basename(directory).startsWith("openclaw-sqlite-readonly-")
    ) {
      onAcquisition(directory);
    }
    return directory;
  };
  syncBuiltinESMExports();
  return () => {
    fs.mkdtempSync = allocate;
    syncBuiltinESMExports();
  };
}

// Both transports consume the same target-admission continuation and request recorder.
export function observeRequiredSnapshotRequests({
  source,
  verifyFrame,
  onRequest,
  onUpdate = () => {},
}) {
  const contexts = new Map();
  const requests = [];
  let sequence = 0;
  const stat = fs.promises.lstat;
  const execFile = childProcess.execFile;
  const spawn = childProcess.spawn;
  const parentStart = snapshotProcessStart(process.pid);
  const update = (request) => {
    try {
      onUpdate(request);
    } catch (error) {
      request.observationError = error instanceof Error ? error.message : "Observation failed";
    }
  };
  const stackLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = Math.max(stackLimit, 32);
  const hook = createHook({
    init(id, _type, trigger) {
      const context = contexts.get(executionAsyncId()) ?? contexts.get(trigger);
      if (context) {
        assert(contexts.size < 65536, "Snapshot caller context observation overflow");
        contexts.set(id, context);
      }
    },
    destroy(id) {
      contexts.delete(id);
    },
  }).enable();
  fs.promises.lstat = function (file, ...args) {
    // The shipped snapshot producer uses a string pathname at this boundary.
    if (
      typeof file === "string" &&
      file.startsWith(source + ".pre-startup-migration-") &&
      file.endsWith(".bak")
    ) {
      const sites = frames();
      const owner = sites.find((site) => site.name === "backupDoctorSqliteDatabases");
      const snapshot = sites.find((site) => site.name === "createVerifiedSqliteSnapshot");
      const absent = sites.find((site) => site.name === "assertTargetAbsent");
      if (owner && snapshot && absent) {
        for (const site of [owner, snapshot, absent]) {
          assert(site.file, "Missing capture caller location");
          if (site.file.startsWith("file:")) {
            site.file = fileURLToPath(site.file);
          }
          verifyFrame(site, "caller");
        }
        const group = file.slice(source.length + ".pre-startup-migration-".length, -4);
        assert.match(group, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u);
        const captureMarker = file + ".capturing";
        const markerStat = fs.lstatSync(captureMarker, { bigint: true });
        assert(markerStat.isFile() && markerStat.size === 0n, "Required capture group is not open");
        const sourceStat = fs.lstatSync(source, { bigint: true });
        const operation = ++sequence;
        contexts.set(executionAsyncId(), {
          operation,
          operationId: process.pid + ":" + parentStart + ":" + operation,
          owner,
          snapshot,
          source,
          sourceIdentity: { dev: String(sourceStat.dev), ino: String(sourceStat.ino) },
          target: file,
          marker: captureMarker,
          markerIdentity: {
            dev: String(markerStat.dev),
            ino: String(markerStat.ino),
            mtimeNs: String(markerStat.mtimeNs),
          },
        });
      }
    }
    return stat.call(this, file, ...args);
  };
  const record = (launch, args, ipcRequestId = null) => {
    const context = contexts.get(executionAsyncId());
    const binding = context && args.source === context.source ? context : undefined;
    if (binding) {
      const identity = fs.statSync(args.source, { bigint: true });
      assert.deepEqual(
        { dev: String(identity.dev), ino: String(identity.ino) },
        binding.sourceIdentity,
      );
    }
    assert(requests.length < 1024, "Snapshot native request observation overflow");
    const request = {
      ...args,
      entrypoint: launch.entrypoint,
      transport: launch.transport,
      ipcRequestId,
      request: requests.length + 1,
      parentPid: process.pid,
      parentStart,
      at: now(),
      binding,
      operationId: binding?.operationId,
      stops: [],
    };
    request.key = snapshotRequestKey(request);
    requests.push(request);
    return request;
  };
  const attach = (child, launch, initial) => {
    const birth = child.pid && snapshotProcessStart(child.pid);
    const worker = {
      child,
      launch,
      birth,
      requests: initial ? [initial] : [],
      active: initial,
      failureDispatch: undefined,
    };
    const bindChild = (request) => {
      assert(child.pid && birth, "Native child birth was not observed");
      request.pid = child.pid;
      request.childStart = birth;
    };
    if (initial) {
      bindChild(initial);
      update(initial);
    }
    const kill = child.kill.bind(child);
    child.kill = (...args) => {
      const request = worker.active;
      let owner;
      try {
        if (request && worker.failureDispatch === request) {
          owner = frames().find((site) => site.name === "retire");
          if (owner?.file) {
            if (owner.file.startsWith("file:")) {
              owner.file = fileURLToPath(owner.file);
            }
            verifyFrame(owner, "retirement");
          } else {
            owner = undefined;
          }
        }
      } catch {
        // An observer failure must never block the existing owner from retiring its child.
        owner = undefined;
      }
      const accepted = kill(...args);
      if (request && !request.close) {
        request.stops.push({
          signal: args[0] ?? "SIGTERM",
          accepted,
          at: now(),
          kind: owner ? "failed-reply-retirement" : "external-or-unobserved",
          owner,
        });
        update(request);
      }
      return accepted;
    };
    if (launch.transport === "ipc") {
      const send = child.send.bind(child);
      child.send = function (message, ...args) {
        // Scope is selected for each real request, never inherited from worker startup.
        const parsed =
          message && typeof message === "object" && "args" in message
            ? readRequestArgs(message.args)
            : undefined;
        if (parsed && "id" in message && Number.isSafeInteger(message.id)) {
          const request = record(launch, parsed, message.id);
          bindChild(request);
          worker.requests.push(request);
          worker.active = request;
          onRequest(request);
        }
        return send(message, ...args);
      };
      child.prependListener("message", (message) => {
        const request = worker.active;
        if (
          !request ||
          !message ||
          typeof message !== "object" ||
          message.id !== request.ipcRequestId ||
          !message.result
        ) {
          return;
        }
        try {
          const failure = snapshotFailure(message.result);
          request.reply = {
            id: message.id,
            ok: message.result.ok,
            sha256: snapshotResultDigest(message.result),
            receivedAt: now(),
          };
          if (failure !== undefined) {
            request.reply.failure = failure;
            // Product's synchronous message handler retires this failed request.
            // An abort/kill in any later turn is not attributed to this reply.
            worker.failureDispatch = request;
            queueMicrotask(() => {
              if (worker.failureDispatch === request) {
                worker.failureDispatch = undefined;
              }
            });
          } else {
            queueMicrotask(() => {
              if (worker.active === request) {
                worker.active = undefined;
              }
            });
          }
          update(request);
        } catch (error) {
          request.observationError =
            error instanceof Error ? error.message : "Reply observation failed";
          update(request);
        }
      });
    }
    child.once("close", (code, signal) => {
      for (const request of worker.requests) {
        request.close = { code, signal };
        request.closedAt = now();
        update(request);
      }
      worker.active = undefined;
      worker.failureDispatch = undefined;
    });
    return child;
  };
  childProcess.execFile = function (file, argv, ...args) {
    const launch = Array.isArray(argv) ? readSnapshotWorkerLaunch(argv) : undefined;
    const request = launch?.transport === "one-shot" ? record(launch, launch) : undefined;
    if (request) {
      onRequest(request);
    } // source/staging observation exists before the child starts
    const child = execFile.call(this, file, argv, ...args);
    return request ? attach(child, launch, request) : child;
  };
  childProcess.spawn = function (file, argv, ...args) {
    const launch = Array.isArray(argv) ? readSnapshotWorkerLaunch(argv) : undefined;
    const child = spawn.call(this, file, argv, ...args);
    return launch?.transport === "ipc" ? attach(child, launch) : child;
  };
  syncBuiltinESMExports();
  return {
    requests,
    currentBinding: () => contexts.get(executionAsyncId()),
    restore() {
      fs.promises.lstat = stat;
      childProcess.execFile = execFile;
      childProcess.spawn = spawn;
      syncBuiltinESMExports();
      hook.disable();
      contexts.clear();
      Error.stackTraceLimit = stackLimit;
    },
  };
}

// Child-side request lifetime mirrors the existing wire protocol, without changing it.
export function observeSnapshotWorkerRequests({ onRequest, onReply, onFinished = () => {} }) {
  const launch = readSnapshotWorkerLaunch(process.argv.slice(1));
  if (!launch) {
    return { current: () => undefined, restore() {} };
  }
  const childStart = snapshotProcessStart(process.pid);
  const parentStart = snapshotProcessStart(process.ppid);
  let active;
  const accept = (args, ipcRequestId = null) => {
    active = args
      ? {
          ...args,
          transport: launch.transport,
          entrypoint: launch.entrypoint,
          ipcRequestId,
          pid: process.pid,
          childStart,
          parentPid: process.ppid,
          parentStart,
        }
      : undefined;
    if (active) {
      active.key = snapshotRequestKey(active);
      onRequest(active);
    }
  };
  const receive = (message) => {
    if (message === "close" || (message && typeof message === "object" && "transfer" in message)) {
      return;
    }
    const args =
      message &&
      typeof message === "object" &&
      "args" in message &&
      "id" in message &&
      Number.isSafeInteger(message.id)
        ? readRequestArgs(message.args)
        : undefined;
    accept(args, args ? message.id : null);
  };
  const reply = (request, result) => {
    if (!request) {
      return;
    }
    onReply({ request, result, sha256: snapshotResultDigest(result), at: now() });
    if (active === request) {
      active = undefined;
      onFinished();
    }
  };
  const send = process.send?.bind(process);
  const write = process.stdout.write.bind(process.stdout);
  if (launch.transport === "ipc") {
    assert(send, "Persistent worker lacks its native IPC channel");
    process.prependListener("message", receive);
    process.send = (message, ...args) => {
      const request = active;
      if (
        request &&
        message &&
        typeof message === "object" &&
        "id" in message &&
        message.id === request.ipcRequestId &&
        "result" in message
      ) {
        reply(request, message.result);
      }
      return send(message, ...args);
    };
  } else {
    accept(launch);
    let output = "";
    process.stdout.write = (...args) => {
      const chunk = args[0];
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      assert(output.length <= 1048576, "Snapshot reply observation overflow");
      let result;
      try {
        result = JSON.parse(output);
      } catch {
        /* Await the rest of the actual protocol output. */
      }
      if (result) {
        reply(active, result);
      }
      return write(...args);
    };
  }
  return {
    current: () => active,
    restore() {
      process.removeListener("message", receive);
      if (send) {
        process.send = send;
      }
      process.stdout.write = write;
    },
  };
}
