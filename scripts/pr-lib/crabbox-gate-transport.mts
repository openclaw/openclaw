import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export function buildCrabboxGateTransport({
  bootstrap,
  command,
  headSha,
}: {
  bootstrap: string;
  command: string;
  headSha: string;
}) {
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const bootstrapSha256 = digest(bootstrap);
  const commandSha256 = digest(command);
  const delimiter = `OPENCLAW_GATE_${commandSha256}`;
  if (!/^[0-9a-f]{40}$/u.test(headSha) || `${command}\n`.split("\n").includes(delimiter)) {
    throw new Error("Crabbox gate transport head or command delimiter is invalid");
  }
  // Parse the gate before installation, but materialize it only at handoff. A named
  // command file could be replaced by same-UID install hooks; argv also has a size cap.
  const input = `#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 4 || "$1" != '${headSha}' || "$2" != '${bootstrapSha256}' || "$3" != '${commandSha256}' || ! "$4" =~ ^[0-9a-f]{64}$ ]]; then
  echo 'Crabbox gate transport identity mismatch' >&2
  exit 2
fi
printf '%s  %s\\n' "$4" "$0" | /usr/bin/sha256sum --check --status
openclaw_gate() {
  /bin/bash -l /dev/fd/3 3<<'${delimiter}'
${command}
${delimiter}
}
openclaw_bootstrap() {
${bootstrap}
}
# Invoke directly: a conditional function call would disable bootstrap errexit.
openclaw_bootstrap "$1" openclaw_gate
`;
  const launcherSha256 = digest(input);
  return {
    args: [headSha, bootstrapSha256, commandSha256, launcherSha256],
    input,
    uploadPath: `.crabbox/scripts/${launcherSha256.slice(0, 12)}-script.sh`,
  };
}

export function appendCrabboxOutputTail(current: Uint8Array, chunk: Uint8Array | string) {
  return Buffer.concat([current, typeof chunk === "string" ? Buffer.from(chunk) : chunk]).subarray(
    -64 * 1024,
  );
}

export async function executeCrabbox({
  args,
  bin,
  env,
  input,
  stream = false,
}: {
  args: string[];
  bin: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  stream?: boolean;
}): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: process.cwd(),
      env,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let inputError: Error | undefined;
    child.stdout!.on("data", (chunk) => {
      if (stream) {
        process.stdout.write(chunk);
      } else {
        stdout = appendCrabboxOutputTail(stdout, chunk);
      }
    });
    child.stderr!.on("data", (chunk) => {
      stderr = appendCrabboxOutputTail(stderr, chunk);
      if (stream) {
        process.stderr.write(chunk);
      }
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      // Join before rejecting delivery: the caller disposes its private home on return.
      if (exitCode === 0 && input !== undefined && (inputError || !child.stdin!.writableFinished)) {
        reject(inputError ?? new Error("Crabbox script input was not completely delivered"));
      } else {
        resolve({ exitCode, stderr: stderr.toString(), stdout: stdout.toString() });
      }
    });
    if (input !== undefined) {
      child.stdin!.on("error", (error) => {
        inputError = error;
      });
      child.stdin!.end(input);
    }
  });
}
