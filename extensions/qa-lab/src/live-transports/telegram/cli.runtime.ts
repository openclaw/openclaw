import { readQaSuiteFailedScenarioCountFromFile } from "../../suite-summary.js";
import {
  assertKnownScenarioIds,
  canonicalScenarioOutputDir,
  listCanonicalScenarios,
  partitionCanonicalScenarioIds,
  runCanonicalLiveScenarios,
  TELEGRAM_CANONICAL_SCENARIO_IDS,
  TELEGRAM_DEFAULT_CANONICAL_SCENARIO_IDS,
} from "../shared/canonical-scenarios.js";
// Qa Lab plugin module implements cli behavior.
import { printLiveTransportQaArtifacts } from "../shared/live-artifacts.js";
import type { LiveTransportQaCommandOptions } from "../shared/live-transport-cli.js";
import { resolveLiveTransportQaRunOptions } from "../shared/live-transport-cli.runtime.js";
import { createTelegramQaTransportAdapter } from "./adapter.runtime.js";
import { listTelegramQaScenarioCatalog, runTelegramQaLive } from "./telegram-live.runtime.js";

export async function runQaTelegramCommand(opts: LiveTransportQaCommandOptions) {
  const runOptions = resolveLiveTransportQaRunOptions(opts);
  if (runOptions.listScenarios) {
    const scenarios = [
      ...listCanonicalScenarios({
        ids: TELEGRAM_CANONICAL_SCENARIO_IDS,
        defaultIds: TELEGRAM_DEFAULT_CANONICAL_SCENARIO_IDS,
      }),
      ...listTelegramQaScenarioCatalog(runOptions.providerMode),
    ];
    for (const scenario of scenarios) {
      const defaultLabel = scenario.defaultEnabled ? "default" : "optional";
      const refs =
        scenario.regressionRefs.length > 0 ? ` refs=${scenario.regressionRefs.join(",")}` : "";
      process.stdout.write(
        `${scenario.id}\t${defaultLabel}\t${scenario.title}\t${scenario.rationale}${refs}\n`,
      );
    }
    return;
  }
  const selected = partitionCanonicalScenarioIds(
    runOptions.scenarioIds,
    TELEGRAM_CANONICAL_SCENARIO_IDS,
  );
  const hasExplicitScenarioIds = (runOptions.scenarioIds?.length ?? 0) > 0;
  if (hasExplicitScenarioIds) {
    assertKnownScenarioIds({
      ids: selected.legacy,
      knownIds: listTelegramQaScenarioCatalog(runOptions.providerMode).map(({ id }) => id),
      laneLabel: "Telegram",
    });
  }
  const canonicalScenarioIds = hasExplicitScenarioIds
    ? selected.canonical
    : [...TELEGRAM_DEFAULT_CANONICAL_SCENARIO_IDS];
  const runsLegacyScenarios = !hasExplicitScenarioIds || selected.legacy.length > 0;
  if (canonicalScenarioIds.length > 0) {
    const canonical = await runCanonicalLiveScenarios({
      channelId: "telegram",
      factory: {
        id: "telegram",
        matches: ({ channelId, driver }) => driver === "live" && channelId === "telegram",
        create: createTelegramQaTransportAdapter,
      },
      options: {
        ...runOptions,
        outputDir: canonicalScenarioOutputDir(runOptions, runsLegacyScenarios),
      },
      scenarioIds: canonicalScenarioIds,
    });
    printLiveTransportQaArtifacts("Telegram canonical QA", {
      report: canonical.reportPath,
      summary: canonical.summaryPath,
    });
    if (!runOptions.allowFailures) {
      const failedScenarioCount = await readQaSuiteFailedScenarioCountFromFile(
        canonical.summaryPath,
      );
      if (failedScenarioCount > 0) {
        process.exitCode = 1;
      }
    }
  }
  if (!runsLegacyScenarios) {
    return;
  }
  const result = await runTelegramQaLive({
    ...runOptions,
    scenarioIds: hasExplicitScenarioIds ? selected.legacy : undefined,
  });
  printLiveTransportQaArtifacts("Telegram QA", {
    report: result.reportPath,
    summary: result.summaryPath,
  });
  if (!runOptions.allowFailures) {
    const failedScenarioCount = await readQaSuiteFailedScenarioCountFromFile(result.summaryPath);
    if (failedScenarioCount > 0) {
      process.exitCode = 1;
    }
  }
}
