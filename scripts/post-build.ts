import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// These scripts write to independent output files; safe to parallelize.
const steps = [
  { cmd: "node", args: ["--import", "tsx", "scripts/copy-hook-metadata.ts"] },
  { cmd: "node", args: ["--import", "tsx", "scripts/copy-export-html-templates.ts"] },
  { cmd: "node", args: ["--import", "tsx", "scripts/write-build-info.ts"] },
  { cmd: "node", args: ["--import", "tsx", "scripts/write-cli-startup-metadata.ts"] },
  { cmd: "node", args: ["--import", "tsx", "scripts/write-cli-compat.ts"] },
];

const results = await Promise.allSettled(steps.map(({ cmd, args }) => execFileAsync(cmd, args)));

let failed = false;
for (const [i, result] of results.entries()) {
  const label = steps[i].args.at(-1);
  if (result.status === "rejected") {
    console.error(`[post-build] FAILED: ${label}`);
    const err = result.reason as { stderr?: string; message?: string };
    if (err.stderr) {
      console.error(err.stderr);
    }
    console.error(err.message ?? result.reason);
    failed = true;
  } else {
    if (result.value.stderr) {
      console.warn(`[post-build] ${label}: ${result.value.stderr.trimEnd()}`);
    }
    console.log(`[post-build] OK: ${label}`);
  }
}

if (failed) {
  process.exit(1);
}
