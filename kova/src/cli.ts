import path from "node:path";
import { fileURLToPath } from "node:url";
import { listCommand } from "./commands/list.js";
import { reportCommand } from "./commands/report.js";
import { runCommand } from "./commands/run.js";

function printHelp() {
  process.stdout.write(
    [
      "Kova",
      "",
      "Usage:",
      "  kova list [inventory|targets|backends [qa]|scenarios [qa]|surfaces [qa]]",
      "  kova run qa [--backend host|multipass] [--provider-mode mock-openai|live-frontier] [--scenario <id>]",
      "  kova report [latest|<run-id>]",
      "",
      "Run exit codes:",
      "  0 = pass or skipped",
      "  2 = degraded",
      "  3 = fail",
      "  4 = flaky",
      "  5 = blocked",
      "",
    ].join("\n"),
  );
  process.stdout.write("\n");
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const [, , command, ...args] = process.argv;

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "run") {
    await runCommand(repoRoot, args);
    return;
  }

  if (command === "list") {
    await listCommand(args);
    return;
  }

  if (command === "report") {
    await reportCommand(repoRoot, args);
    return;
  }

  throw new Error(`unknown Kova command: ${command}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`kova error: ${message}\n`);
  process.exitCode = 1;
});
