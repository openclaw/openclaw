// Runs the complete lint pipeline with the selected installed toolchain.
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { main as runControllerGuard } from "./check-control-ui-controllers.mts";
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
  let failure = 0;
  const collect = (status: number) => {
    // Timeouts and cancellation deliberately stop admitting new work.
    const stopped = status === 124 || status >= 128;
    failure = stopped ? status : failure || status;
    process.exitCode = failure;
    return stopped;
  };
  if (
    collect(
      runControllerGuard(process.cwd(), [
        ...(args.staged ? ["--staged"] : []),
        ...(base ? ["--base", base] : []),
        // The CI checkout owner supplies the actual tested tree's comparison
        // commit. An explicit caller base still means a local branch fork.
        ...(!args.base && !args.staged && base ? ["--no-merge-base"] : []),
      ]),
    )
  ) {
    return;
  }
  const tsxPath = resolveRepoToolBinPath("tsx");
  const tsxImportSpecifier = pathToFileURL(createRequire(tsxPath).resolve("tsx")).href;

  // Invoke directly: pnpm through a linked node_modules can reconcile its owner's install.
  if (
    collect(
      await runManagedCommand({
        bin: process.execPath,
        args: [
          "--import",
          tsxImportSpecifier,
          path.resolve("scripts", "control-ui-i18n-verify.ts"),
          "verify",
        ],
        env: process.env,
        requireProcessTreeExit: process.platform !== "win32",
      }),
    )
  ) {
    return;
  }
  // Compose the batch so cancellation and final reporting remain with this process.
  if (collect(await runOxlintShards(args.oxlint))) {
    return;
  }
  // Oxlint does not check stylesheets.
  collect(await runStylelint(["ui/src/**/*.css", "ui/public/themes/*.css"]));
});
