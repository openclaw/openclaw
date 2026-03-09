import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  if (result.status === "rejected") {
    console.error(`[post-build] FAILED: ${steps[i].args.at(-1)}`);
    console.error(result.reason);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
