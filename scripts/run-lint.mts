// Runs the complete lint pipeline with the selected installed toolchain.
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { main as runLitRatchet } from "./check-control-ui-lit-ratchet.mts";
import { booleanFlag, parseFlagArgs, stringFlag } from "./lib/arg-utils.mts";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import { resolveRepoToolBinPath } from "./lib/local-check-runtime.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import { main as runOxlintShards } from "./run-oxlint-shards.mts";
import { runStylelint } from "./run-stylelint.mts";

await runWithFailedTrailer("lint", async () => {
  const args = parseFlagArgs(
    process.argv.slice(2),
    { base: "", staged: false, oxlint: new Array<string>() },
    [stringFlag("--base", "base"), booleanFlag("--staged", "staged")],
    {
      onUnhandledArg(arg, parsed) {
        parsed.oxlint.push(arg);
        return "handled";
      },
    },
  );
  const base = args.base || (!args.staged && process.env.CHECKOUT_BASE_SHA);
  process.exitCode = runLitRatchet(process.cwd(), [
    ...(args.staged ? ["--staged"] : []),
    ...(base ? ["--base", base] : []),
  ]);
  if (process.exitCode !== 0) {
    return;
  }
  const tsxPath = resolveRepoToolBinPath("tsx");
  const tsxImportSpecifier = pathToFileURL(createRequire(tsxPath).resolve("tsx")).href;

  // Invoke directly: pnpm through a linked node_modules can reconcile its owner's install.
  process.exitCode = await runManagedCommand({
    bin: process.execPath,
    args: [
      "--import",
      tsxImportSpecifier,
      path.resolve("scripts", "control-ui-i18n-verify.ts"),
      "verify",
    ],
    env: process.env,
    requireProcessTreeExit: process.platform !== "win32",
  });
  if (process.exitCode !== 0) {
    return;
  }
  // Compose the batch so cancellation and final reporting remain with this process.
  process.exitCode = await runOxlintShards(args.oxlint);
  if (process.exitCode !== 0) {
    return;
  }
  // Oxlint cannot see plain stylesheets or css`` templates in Lit components.
  process.exitCode = await runStylelint([
    "ui/src/**/*.css",
    "ui/src/**/*.{ts,tsx}",
    "ui/public/themes/*.css",
  ]);
});
