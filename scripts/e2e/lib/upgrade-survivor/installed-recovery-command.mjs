import fs from "node:fs";
import { parseTimeoutMs } from "../../../lib/docker-e2e-watchdog.mjs";
import { runManagedCommand } from "../../../lib/managed-child-process.mts";
import { openInstalledRecoveryEvidence } from "./installed-recovery-observations.mjs";

export async function runInstalledRecoveryCommand({ stdout, stderr, record, timeout, ...options }) {
  // Match openclaw_e2e_maybe_timeout's disabled sentinel; the outer lane remains bounded.
  const timeoutMs = timeout === "" || timeout === "0" ? undefined : parseTimeoutMs(timeout);
  console.log(`[installed-recovery] command timeout ms: ${timeoutMs ?? "disabled"}`);
  const startedAt = Date.now();
  const start = performance.now();
  const observation = (state) =>
    record({ ...state, startedAt, elapsedMs: Math.round(performance.now() - start) });
  const out = openInstalledRecoveryEvidence(stdout);
  let err;
  let status;
  try {
    err = openInstalledRecoveryEvidence(stderr);
    // Record the selected files before launch: a timeout rejects instead of
    // returning a numeric exit, but its private output still needs publication.
    observation({ state: "running" });
    try {
      status = await runManagedCommand({
        ...options,
        timeoutMs,
        stdio: ["ignore", out, err],
        requireProcessTreeExit: true,
        timeoutForceKillOnLeaderExit: true,
      });
    } catch (error) {
      try {
        observation({
          state: "rejected",
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        console.error("Installed recovery command evidence could not be updated.");
      }
      throw error;
    }
  } finally {
    fs.closeSync(out);
    if (err !== undefined) {
      fs.closeSync(err);
    }
  }
  observation({ state: "completed", status, treeJoined: true });
  return {
    status,
    stdout: fs.readFileSync(stdout, "utf8"),
    stderr: fs.readFileSync(stderr, "utf8"),
  };
}
