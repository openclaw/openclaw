import { execFileSync } from "node:child_process";
import fs from "node:fs";

export function extractPackedRecoveryHelper(tarball, destination) {
  const output = fs.openSync(destination, "wx", 0o600);
  let complete = false;
  try {
    // The sealed helper exceeds Node's buffered stdout cap. Write its actual
    // archive bytes to the owned file and wait for tar to close before use.
    execFileSync("tar", ["-xOf", tarball, "package/dist/package-update-activation-recovery.mjs"], {
      stdio: ["ignore", output, "pipe"],
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    complete = true;
  } finally {
    try {
      fs.closeSync(output);
    } finally {
      if (!complete) {
        fs.unlinkSync(destination);
      }
    }
  }
}
