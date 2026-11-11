import fs from "node:fs";
import path from "node:path";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";

export function writeFakeContainerExecutable(directory: string, name: string, source: string) {
  fs.writeFileSync(path.join(directory, name), `#!${resolveTestNodeExecPath()}\n${source}`, {
    mode: 0o700,
  });
}

// Model the external launcher's scope receipt and default argument expansion;
// the delegated Linux proof separately exercises the real systemd manager.
export function writeFakeSystemdScope(directory: string) {
  writeFakeContainerExecutable(
    directory,
    "systemd-run",
    `const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const boundary = args.indexOf("--");
const options = args.slice(0, boundary);
let [command, ...commandArgs] = args.slice(boundary + 1);
if (!options.includes("--expand-environment=no")) {
  commandArgs = commandArgs.map(arg => arg.replace(/\\$\\{?(\\w+)\\}?/g, (_, key) => process.env[key] ?? ""));
}
if (!options.includes("--quiet")) process.stderr.write("scope started\\n");
const result = spawnSync(command, commandArgs, {
  stdio: "inherit",
  env: { ...process.env, OPENCLAW_TEST_USER_SCOPE: String(options.includes("--user") && options.includes("--scope")) },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`,
  );
}
