import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

// A lifecycle update can finish core activation before its plugin step exists.
// Never substitute a successful older run or stop the Gateway while maintenance runs.
export async function settlePluginUpdate(entry, pending, targetVersion, evidencePath) {
  assert(pending.runId, "expected an update invocation with a run ID");
  assert.equal(pending.target?.version, targetVersion);
  const env = {
    ...process.env,
    OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT || "18789",
    OPENCLAW_GATEWAY_TOKEN: randomBytes(24).toString("hex"),
  };
  let gateway;
  let stopped;
  const logPath = evidencePath + ".gateway.log";
  try {
    if (pending.status === "running") {
      assert.equal(pending.phase, "activating", "update did not prepare a release for activation");
      const log = fs.openSync(logPath, "w", 0o600);
      try {
        gateway = spawn(
          process.execPath,
          [entry, "gateway", "run", "--bind", "loopback", "--allow-unconfigured"],
          {
            env,
            stdio: ["ignore", log, log],
          },
        );
        stopped = once(gateway, "exit");
        // The status loop also checks early exit. Retain spawn errors without an unhandled rejection.
        stopped.catch(() => {});
      } finally {
        fs.closeSync(log);
      }
    }
    const deadline = performance.now() + 660_000;
    let statusError = "";
    while (performance.now() < deadline) {
      assert(
        !gateway || (gateway.pid && gateway.exitCode === null && gateway.signalCode === null),
        "fixture Gateway exited before plugin settlement; see " + logPath,
      );
      let statusReport;
      try {
        const { stdout } = await run(process.execPath, [entry, "update", "status", "--json"], {
          env,
          timeout: 15_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        statusReport = JSON.parse(stdout.slice(stdout.indexOf("{")));
      } catch (error) {
        statusError = String(error);
        await delay(1000);
        continue;
      }
      const receipt = [statusReport.activeRun, statusReport.lastRun].find(
        (candidate) => candidate?.runId === pending.runId,
      );
      if (receipt) {
        fs.writeFileSync(evidencePath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
        if (receipt.phase === "finished") {
          assert(
            ["succeeded", "skipped"].includes(receipt.status),
            "core update failed; see " + evidencePath,
          );
          if (receipt.status === "skipped") {
            assert.equal(receipt.reason, "already-current");
            assert.equal(receipt.before?.version, targetVersion);
            assert.equal(receipt.target?.version, targetVersion);
          } else {
            assert.equal(receipt.after?.version, targetVersion);
          }
          if (gateway) {
            assert.equal(receipt.status, "succeeded");
            assert.equal(receipt.verification?.runningVersion, targetVersion);
            assert.ok(receipt.after?.buildId);
            assert.equal(receipt.verification.runningBuildId, receipt.after.buildId);
            assert.equal(receipt.verification.booted, true);
            assert.equal(receipt.verification.serviceRunning, true);
            assert.equal(receipt.verification.coreReady, true);
            assert(
              receipt.steps.some(
                ({ step, status }) => step === "activating" && status === "completed",
              ),
            );
          }
          const pluginStep = receipt.steps.find(({ step }) => step === "plugins");
          if (pluginStep?.status === "completed" || pluginStep?.status === "failed") {
            return { receipt, pluginStep };
          }
        }
      }
      await delay(1000);
    }
    throw new Error(
      "No terminal plugin step for update " +
        pending.runId +
        "; see " +
        evidencePath +
        " and " +
        logPath +
        " " +
        statusError,
    );
  } finally {
    if (gateway?.pid && gateway.exitCode === null && gateway.signalCode === null) {
      gateway.kill("SIGTERM");
      // The resident launcher needs its own 15s child shutdown budget first.
      const timeout = setTimeout(() => gateway.kill("SIGKILL"), 20_000);
      try {
        await stopped;
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}
