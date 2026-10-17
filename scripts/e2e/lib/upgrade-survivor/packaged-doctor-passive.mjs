import childProcess from "node:child_process";
import { createHash } from "node:crypto";
// Diagnostic observations only: no injected caller, owner, result, or cleanup facts.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { threadId } from "node:worker_threads";
const root = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
if (root && fs.existsSync(path.join(root, "snapshot-cleanup-fixture.json"))) {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(root, "snapshot-cleanup-fixture.json"), "utf8"),
  );
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const output = path.join(root, "passive-" + process.pid + "-" + threadId + ".json");
  const report = {
    pid: process.pid,
    threadId,
    parentPid: process.ppid,
    role: process.argv[2] ?? null,
    sourceHash: hash(fixture.source),
    updateInProgress: process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1",
    stateSourceMatches:
      path.join(process.env.OPENCLAW_STATE_DIR ?? "", "state/openclaw.sqlite") === fixture.source,
    targets: [],
    launches: [],
    counts: { targets: 0, launches: 0 },
    overflow: false,
  };
  const save = () => fs.writeFileSync(output, JSON.stringify(report));
  const captureStack = () => {
    const previous = Error.prepareStackTrace;
    try {
      Error.prepareStackTrace = (_error, sites) => sites;
      const value = {};
      Error.captureStackTrace(value, captureStack);
      return value.stack
        .map((site) => ({
          name: site.getFunctionName(),
          line: site.getLineNumber(),
          fileHash: site.getFileName() ? hash(site.getFileName()) : null,
        }))
        .slice(0, 20);
    } finally {
      Error.prepareStackTrace = previous;
    }
  };
  const statSync = fs.lstatSync;
  fs.lstatSync = function (file, ...args) {
    const result = statSync.call(this, file, ...args);
    if (
      typeof file === "string" &&
      file.includes(".pre-startup-migration-") &&
      file.endsWith(".bak")
    ) {
      report.counts.targets++;
      if (report.targets.length < 16) {
        report.targets.push({
          phase: "existing-target",
          targetHash: hash(file),
          exists: result !== undefined,
          originalSource: file.startsWith(fixture.source + ".pre-startup-migration-"),
          frames: captureStack(),
        });
      } else {
        report.overflow = true;
      }
      save();
    }
    return result;
  };
  const lstat = fs.promises.lstat;
  fs.promises.lstat = function (file, ...args) {
    if (
      typeof file === "string" &&
      file.includes(".pre-startup-migration-") &&
      file.endsWith(".bak")
    ) {
      report.counts.targets++;
      if (report.targets.length < 16) {
        report.targets.push({
          phase: "target-admission",
          targetHash: hash(file),
          originalSource: file.startsWith(fixture.source + ".pre-startup-migration-"),
          scoped: file.endsWith(".scoped.bak"),
          frames: captureStack(),
        });
      } else {
        report.overflow = true;
      }
      save();
    }
    return lstat.call(this, file, ...args);
  };
  for (const method of ["spawn", "execFile"]) {
    const original = childProcess[method];
    childProcess[method] = function (file, argv, ...args) {
      const child = original.call(this, file, argv, ...args);
      if (Array.isArray(argv) && argv.includes("--openclaw-sqlite-readonly-child")) {
        report.counts.launches++;
        if (report.launches.length >= 32) {
          report.overflow = true;
          save();
          return child;
        }
        const marker = argv.indexOf("--openclaw-sqlite-readonly-child");
        const observed = {
          method,
          pid: child.pid,
          mode: argv[marker + 1],
          requests: [],
          close: null,
        };
        const recordRequest = (source, id) => {
          let gatewayPresent;
          try {
            process.kill(fixture.gatewayPid, 0);
            gatewayPresent = true;
          } catch (error) {
            gatewayPresent = error.code === "ESRCH" ? false : "unknown:" + error.code;
          }
          if (observed.requests.length < 32) {
            observed.requests.push({
              ...(id === undefined ? {} : { id }),
              sourceMatches: source === fixture.source,
              gatewayPresent,
            });
          } else {
            report.overflow = true;
          }
          save();
        };
        report.launches.push(observed);
        if (observed.mode === "sync") {
          // One-shot requests carry their facts in argv, without an IPC identity.
          recordRequest(argv[marker + 2], undefined);
        } else {
          save();
        }
        if (observed.mode === "session" && child.send) {
          const send = child.send.bind(child);
          child.send = function (message, ...rest) {
            if (
              message &&
              typeof message === "object" &&
              Array.isArray(message.args) &&
              message.args[0] === "sync"
            ) {
              recordRequest(message.args[1], message.id);
            }
            return send(message, ...rest);
          };
        }
        child.once("close", (code, signal) => {
          observed.close = { code, signal };
          save();
        });
      }
      return child;
    };
  }
  syncBuiltinESMExports();
  save();
}
