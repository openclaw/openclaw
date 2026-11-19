import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { compareCaptures, MAX_RASTER_NOISE_CHANNEL_DELTA } from "./report.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: "string" },
    scene: { type: "string" },
    profile: { type: "string" },
    css: { type: "string" },
    help: { type: "boolean" },
  },
});
const [command, before, after, ...extra] = positionals;
if (values.help || !command) {
  console.log(`Control UI visual parity (synthetic mock Gateway, no committed baselines)
  pnpm ui:parity capture [--output <parent>] [--scene <regex>] [--profile <regex>] [--css <file>]
  pnpm ui:parity diff <before-directory> <after-directory> [--output <parent>]

Capture prints a fresh artifact directory containing manifest.json, PNGs, and index.html.
Diff compares decoded RGBA pixels, reports ≤${MAX_RASTER_NOISE_CHANNEL_DELTA}-level raster noise separately, and exits 1 on larger unlisted differences.
The three known nondeterministic Apps shots remain captured and reported separately.
Use the same browser, platform, source SHA, and selection for repeatability proof.
--css is an explicit browser-only stylesheet override for sensitivity proof.
Selectors are opt-in focused captures; omit them for the complete catalog.`);
} else if (command === "capture" && !before && !after && extra.length === 0) {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/run-vitest.mjs",
      "run",
      "--config",
      "scripts/control-ui-parity/vitest.config.ts",
      "--configLoader",
      "runner",
      "--bail",
      "1",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        OPENCLAW_PARITY_OPTIONS: JSON.stringify(values),
      },
    },
  );
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
} else if (
  command === "diff" &&
  before &&
  after &&
  extra.length === 0 &&
  !values.css &&
  !values.scene &&
  !values.profile
) {
  process.exitCode = await compareCaptures(before, after, values.output);
} else {
  throw new Error("Invalid arguments. Run pnpm ui:parity --help.");
}
