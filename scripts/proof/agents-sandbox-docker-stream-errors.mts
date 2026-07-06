// Real behavior proof: `execDockerRaw` handles real stdout/stderr stream
// error events without crashing the agent runtime during Docker sandbox
// operations.
//
// The proof prepends a fake `docker` binary to PATH, calls the production
// `execDockerRaw` helper, and patches `child_process.spawn` so the docker child
// is a real process whose stdout/stderr streams emit `error` events after the
// fix's listeners are attached. With the fix the docker command still
// resolves; without the stream error listeners the unhandled errors would
// terminate the process.

import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const originalSpawn = childProcess.spawn;

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-proof-docker-"));
const fakeDocker = path.join(tmpDir, "docker");

// Fake docker that succeeds for any command.
await fs.writeFile(
  fakeDocker,
  `#!/bin/sh
echo '{"status":"ok"}'
`,
  "utf8",
);
await fs.chmod(fakeDocker, 0o755);

process.env.PATH = `${tmpDir}${path.delimiter}${process.env.PATH ?? ""}`;

// Patch spawn so the docker child is a real process whose streams we can make
// emit error events after execDockerRaw attaches listeners.
childProcess.spawn = (...args: Parameters<typeof originalSpawn>) => {
  const child = originalSpawn.apply(childProcess, args);
  const cmd = String(args[0] ?? "");
  if (cmd === fakeDocker || path.basename(cmd) === "docker") {
    setTimeout(() => {
      child.stdout?.emit("error", new Error("docker stdout read failed"));
      child.stderr?.emit("error", new Error("docker stderr read failed"));
    }, 50);
  }
  return child;
};

const { execDockerRaw } = await import(path.join(repoRoot, "src/agents/sandbox/docker.js"));

console.log("=== Proof: agents sandbox docker stream error catch ===\n");

try {
  const result = await execDockerRaw(["version", "--format", "json"]);
  console.log(`Docker exit code: ${result.code}`);
  console.log(`Docker stdout: ${result.stdout.toString("utf8").trim()}`);
  if (result.code === 0) {
    console.log("\nPASS: stream errors were caught and execDockerRaw still resolved.");
  } else {
    console.log(`\nFAIL: unexpected exit code ${result.code}.`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error("\nFAIL: execDockerRaw rejected with:");
  console.error(err);
  process.exitCode = 1;
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}
