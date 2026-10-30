// Test-only preload: insert a concurrent notice after the real updater settles.
// Forward its original close event only after the canonical writer commits it.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readDatabase } from "./observations.mjs";
import { resolveWorkerCellExport } from "./worker-cell-package.mjs";

const specPath = process.env.OPENCLAW_SURVIVOR_OLDER_RUNTIME;
if (specPath && path.basename(process.argv[2] ?? "") === "handoff.json") {
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const params = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  assert.equal(params.updateLeaseKey, spec.root);
  assert.equal(params.runId, spec.runId);
  assert.equal(params.handoffId, spec.handoffId);
  assert.equal(params.action, "update");
  assert(params.commandArgv.includes(path.join(spec.root, "openclaw.mjs")));
  const writers = [];
  for (const name of fs.readdirSync(path.join(spec.root, "dist")).toSorted()) {
    if (!name.startsWith("restart-sentinel-") || !name.endsWith(".mjs")) {
      continue;
    }
    const file = path.join(spec.root, "dist", name);
    const alias = resolveWorkerCellExport(fs.readFileSync(file, "utf8"), "writeRestartSentinel");
    if (alias) {
      writers.push((await import(pathToFileURL(file).href))[alias]);
    }
  }
  const unique = [...new Set(writers)];
  assert.equal(unique.length, 1, "one published notice writer must own the concurrent notice");
  const writeNotice = unique[0];
  assert.equal(typeof writeNotice, "function");
  const snapshot = () =>
    readDatabase(params.stateDatabasePath, (db) =>
      db
        .prepare(
          "SELECT payload_json, updated_at_ms FROM gateway_restart_sentinel WHERE sentinel_key = 'current'",
        )
        .get(),
    );
  const spawn = childProcess.spawn;
  let observed = false;
  childProcess.spawn = function (command, args, options) {
    if (
      command === "systemctl" &&
      args[0] === "--user" &&
      args[1] === "show" &&
      args[2] === params.serviceRecovery?.unit &&
      args[3] ===
        "--property=Id,LoadState,ActiveState,MainPID,ExecMainStartTimestampMonotonic,InvocationID,FragmentPath" &&
      fs.existsSync(spec.noticeReceipt) &&
      !fs.existsSync(spec.recoveryNotice)
    ) {
      fs.writeFileSync(spec.recoveryNotice, JSON.stringify(snapshot()));
    }
    const child = spawn.call(this, command, args, options);
    if (
      !observed &&
      options?.env?.OPENCLAW_UPDATE_RUN_HANDOFF === "1" &&
      options.detached === true &&
      Array.isArray(options.stdio) &&
      options.stdio.length === 5 &&
      options.stdio[0] === "pipe" &&
      options.stdio[1] === "pipe" &&
      options.stdio[3] === "ipc" &&
      options.stdio[4] === "pipe" &&
      args.includes(path.join(spec.root, "openclaw.mjs")) &&
      args.includes("update")
    ) {
      observed = true;
      const chunks = [];
      let bytes = 0;
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        assert(bytes <= 4 * 1024 * 1024, "updater result exceeds the owning helper's bound");
        chunks.push(chunk);
      });
      const emit = child.emit.bind(child);
      child.emit = (event, ...values) => {
        if (event !== "close") {
          return emit(event, ...values);
        }
        void (async () => {
          try {
            const result = JSON.parse(
              Buffer.concat(chunks)
                .toString()
                .replace(/^park\n/u, ""),
            );
            const written = await writeNotice(spec.notice, process.env);
            fs.writeFileSync(
              spec.noticeReceipt,
              JSON.stringify({
                code: values[0],
                signal: values[1],
                result,
                written,
                row: snapshot(),
              }),
            );
          } catch (error) {
            fs.writeFileSync(spec.noticeReceipt, JSON.stringify({ observerError: String(error) }));
          } finally {
            emit(event, ...values);
          }
        })();
        return true;
      };
    }
    return child;
  };
  syncBuiltinESMExports();
}
