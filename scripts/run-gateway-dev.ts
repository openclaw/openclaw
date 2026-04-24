import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const forwardedArgs = process.argv.slice(2);
  const cliArgs =
    forwardedArgs[0] === "--" ? forwardedArgs.slice(1) : forwardedArgs;

  const child = spawn(
    process.execPath,
    ["scripts/run-node.mjs", "--dev", "gateway", ...cliArgs],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        // Keep dev gateway startup side-effect free across both OpenClaw and legacy Clawdbot env names.
        OPENCLAW_SKIP_CHANNELS: "1",
        CLAWDBOT_SKIP_CHANNELS: "1",
      },
      stdio: "inherit",
      windowsHide: true,
    },
  );

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    },
  );

  if (result.signal) {
    process.exitCode = 1;
    return;
  }

  process.exitCode = result.code ?? 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
