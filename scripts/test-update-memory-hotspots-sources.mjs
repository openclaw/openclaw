import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function loadHotspotInputTexts({
  logPaths = [],
  ghJobs = [],
  readFileSyncImpl = fs.readFileSync,
  execFileSyncImpl = execFileSync,
}) {
  const inputs = [];
  for (const logPath of logPaths) {
    inputs.push({
      sourceName: path.basename(logPath, path.extname(logPath)),
      text: readFileSyncImpl(logPath, "utf8"),
    });
  }
  for (const ghJobId of ghJobs) {
    inputs.push({
      sourceName: `gh-job-${String(ghJobId)}`,
      text: execFileSyncImpl("gh", ["run", "view", "--job", String(ghJobId), "--log"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    });
  }
  return inputs;
}
