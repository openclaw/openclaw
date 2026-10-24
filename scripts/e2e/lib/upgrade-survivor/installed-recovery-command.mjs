import fs from "node:fs";
import { runManagedCommand } from "../../../lib/managed-child-process.mts";

export async function runInstalledRecoveryCommand({ stdout, stderr, record, ...options }) {
  const out = fs.openSync(stdout, "wx", 0o600);
  let err;
  let status;
  try {
    err = fs.openSync(stderr, "wx", 0o600);
    // Record the selected files before launch: a timeout rejects instead of
    // returning a numeric exit, but its private output still needs publication.
    record({ state: "running" });
    try {
      status = await runManagedCommand({
        ...options,
        stdio: ["ignore", out, err],
        requireProcessTreeExit: true,
        timeoutForceKillOnLeaderExit: true,
      });
    } catch (error) {
      try {
        record({
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
  record({ state: "completed", status, treeJoined: true });
  return {
    status,
    stdout: fs.readFileSync(stdout, "utf8"),
    stderr: fs.readFileSync(stderr, "utf8"),
  };
}
