import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { explicitCommandRoute, runCase, runExperiment } from "./decision.ts";
import { fixtures } from "./fixtures.ts";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      report: { type: "string" },
      message: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(
      [
        "Scoped decision experiment — offline, synthetic, authorization previews only.",
        "Usage: node --import ./scripts/tsx.mjs scripts/scoped-decision/cli.ts",
        "  [--message 'Use B for campaign X.'] [--report <new-file.json>]",
        "No provider calls, Gateway configuration, or credentials are used.",
      ].join("\n"),
    );
    return;
  }
  const firstFixture = fixtures[0];
  if (!firstFixture) {
    throw new Error("Experiment has no fixtures.");
  }
  const result =
    values.message !== undefined
      ? await runCase({
          id: "interactive-synthetic-example",
          message: values.message,
          host: () => firstFixture.host,
          route: explicitCommandRoute(),
        })
      : await runExperiment(fixtures);
  const json = JSON.stringify(result, null, 2) + "\n";
  if (values.report !== undefined) {
    // Reports are task artifacts; do not silently replace a prior result or follow its symlink.
    await writeFile(values.report, json, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  if ("routes" in result) {
    console.log(
      "Offline experiment: " + fixtures.length + " synthetic cases; authorization previews only.",
    );
    for (const route of result.routes) {
      const metrics = route.metrics;
      console.log(
        route.route +
          ": previews=" +
          metrics.authorizationPreviews +
          " unsafe=" +
          metrics.unsafePreviews +
          " missed=" +
          metrics.missedPreviews +
          " raw-classification-errors=" +
          metrics.rawClassificationErrors +
          " raw-target-errors=" +
          metrics.rawTargetErrors +
          " model-calls=" +
          metrics.modelCalls.knownTotal,
      );
    }
    console.log("Model tokens and inline overhead: unmeasured. Replays are not model benchmarks.");
  } else {
    console.log(json.trimEnd());
  }
  if (values.report !== undefined) {
    console.log("Report written: " + values.report);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Experiment failed.");
    process.exitCode = 1;
  });
}
