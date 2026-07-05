import { resetProcessRegistryForTests } from "../src/agents/bash-process-registry.js";
import { runExecProcess } from "../src/agents/bash-tools.exec-runtime.js";

function currentEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] != null),
  );
}

async function main() {
  resetProcessRegistryForTests();

  const command =
    "node -e \"process.stdout.write('\\x1b[1;32mHello from OpenClaw exec\\x1b[0m\\x07\\x00\\n')\"";

  const run = await runExecProcess({
    command,
    workdir: process.cwd(),
    env: currentEnv(),
    usePty: true,
    warnings: [],
    maxOutput: 20_000,
    pendingMaxOutput: 20_000,
    notifyOnExit: false,
    timeoutSec: 5,
  });

  const outcome = await run.promise;

  console.log("=== Command ===");
  console.log(command);
  console.log();
  console.log("=== Exit status ===");
  console.log(outcome.status);
  console.log();
  console.log("=== Aggregated output after sanitizeBinaryOutput ===");
  console.log(outcome.aggregated);
  console.log();
  console.log("=== Checks ===");
  const aggregated = outcome.aggregated;
  console.log(`Contains readable text: ${aggregated.includes("Hello from OpenClaw exec")}`);
  console.log(`ANSI ESC stripped: ${!aggregated.includes("\x1b")}`);
  console.log(`BEL escaped: ${aggregated.includes("\\x07")}`);
  console.log(`NUL escaped: ${aggregated.includes("\\x00")}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
