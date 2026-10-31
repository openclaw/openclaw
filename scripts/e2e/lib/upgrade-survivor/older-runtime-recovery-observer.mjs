// Test-only preload: insert a concurrent notice after the real updater settles.
// Forward its original close event only after the canonical writer commits it.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDatabase } from "./observations.mjs";

const specPath = process.env.OPENCLAW_SURVIVOR_OLDER_RUNTIME;
if (specPath && path.basename(process.argv[2] ?? "") === "handoff.json") {
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const params = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  assert.equal(params.updateLeaseKey, spec.root);
  assert.equal(params.runId, spec.runId);
  assert.equal(params.handoffId, spec.handoffId);
  assert.equal(params.action, "update");
  assert(params.commandArgv.includes(path.join(spec.root, "openclaw.mjs")));
  const snapshot = () =>
    readDatabase(params.stateDatabasePath, (db) =>
      db
        .prepare(
          "SELECT payload_json, updated_at_ms FROM gateway_restart_sentinel WHERE sentinel_key = 'current'",
        )
        .get(),
    );
  const spawn = childProcess.spawn;
  const appendFileSync = fs.appendFileSync;
  fs.appendFileSync = function (file, data, options) {
    const result = appendFileSync.call(this, file, data, options);
    // The canonical refusal has committed before this diagnostic. Recovery may
    // already be healthy, so no later native restart or inspection is required.
    if (
      file === params.logPath &&
      typeof data === "string" &&
      data.endsWith(
        " Update notice changed or belongs to another handoff; it was not replaced.\n",
      ) &&
      fs.existsSync(spec.noticeReceipt) &&
      !fs.existsSync(spec.preservedNotice)
    ) {
      let row;
      try {
        row = snapshot() ?? null;
      } catch (error) {
        row = { observerError: String(error) };
      }
      fs.writeFileSync(spec.preservedNotice, JSON.stringify(row));
    }
    return result;
  };
  let observed = false;
  childProcess.spawn = function (command, args, options) {
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
            // The published writer commits in its own runtime, before the
            // candidate helper observes close and begins restoration.
            const written = JSON.parse(
              childProcess.execFileSync(
                process.execPath,
                [
                  fileURLToPath(new URL("./older-runtime-recovery.mjs", import.meta.url)),
                  path.dirname(specPath),
                  spec.candidateRoot,
                  spec.root,
                  spec.tarball,
                  "notice",
                  specPath,
                ],
                {
                  env: process.env,
                  encoding: "utf8",
                  stdio: ["ignore", "pipe", "pipe"],
                  timeout: 90_000,
                  maxBuffer: 1024 * 1024,
                },
              ),
            );
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
