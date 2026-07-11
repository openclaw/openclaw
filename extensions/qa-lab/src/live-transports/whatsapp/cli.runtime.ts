import { readQaSuiteFailedOrSkippedScenarioCountFromFile } from "../../suite-summary.js";
import {
  assertKnownScenarioIds,
  canonicalScenarioOutputDir,
  partitionCanonicalScenarioIds,
  runCanonicalLiveScenarios,
  WHATSAPP_CANONICAL_SCENARIO_IDS,
  whatsappDefaultCanonicalScenarioIds,
} from "../shared/canonical-scenarios.js";
// Qa Lab plugin module implements cli behavior.
import { printLiveTransportQaArtifacts } from "../shared/live-artifacts.js";
import type { LiveTransportQaCommandOptions } from "../shared/live-transport-cli.js";
import { resolveLiveTransportQaRunOptions } from "../shared/live-transport-cli.runtime.js";
import { createWhatsAppQaTransportAdapter } from "./adapter.runtime.js";
import { listWhatsAppQaScenarioCatalog, runWhatsAppQaLive } from "./whatsapp-live.runtime.js";

export async function runQaWhatsAppCommand(opts: LiveTransportQaCommandOptions) {
  const runOptions = resolveLiveTransportQaRunOptions(opts);
  const selected = partitionCanonicalScenarioIds(
    runOptions.scenarioIds,
    WHATSAPP_CANONICAL_SCENARIO_IDS,
  );
  const hasExplicitScenarioIds = (runOptions.scenarioIds?.length ?? 0) > 0;
  if (hasExplicitScenarioIds) {
    assertKnownScenarioIds({
      ids: selected.legacy,
      knownIds: listWhatsAppQaScenarioCatalog().map(({ id }) => id),
      laneLabel: "WhatsApp",
    });
  }
  const canonicalScenarioIds = hasExplicitScenarioIds
    ? selected.canonical
    : whatsappDefaultCanonicalScenarioIds(runOptions.providerMode);
  const runsLegacyScenarios = !hasExplicitScenarioIds || selected.legacy.length > 0;
  if (canonicalScenarioIds.length > 0) {
    const canonical = await runCanonicalLiveScenarios({
      channelId: "whatsapp",
      factory: {
        id: "whatsapp",
        matches: ({ channelId, driver }) => driver === "live" && channelId === "whatsapp",
        create: createWhatsAppQaTransportAdapter,
      },
      options: {
        ...runOptions,
        outputDir: canonicalScenarioOutputDir(runOptions, runsLegacyScenarios),
      },
      scenarioIds: canonicalScenarioIds,
    });
    printLiveTransportQaArtifacts("WhatsApp canonical QA", {
      report: canonical.reportPath,
      summary: canonical.summaryPath,
    });
    if (!runOptions.allowFailures) {
      const blockingScenarioCount = await readQaSuiteFailedOrSkippedScenarioCountFromFile(
        canonical.summaryPath,
      );
      if (blockingScenarioCount > 0) {
        process.exitCode = 1;
      }
    }
  }
  if (!runsLegacyScenarios) {
    return;
  }
  const result = await runWhatsAppQaLive({
    ...runOptions,
    scenarioIds: hasExplicitScenarioIds ? selected.legacy : undefined,
  });
  printLiveTransportQaArtifacts("WhatsApp QA", {
    report: result.reportPath,
    summary: result.summaryPath,
    "observed messages": result.observedMessagesPath,
    ...(result.gatewayDebugDirPath ? { "gateway debug logs": result.gatewayDebugDirPath } : {}),
  });
  if (!runOptions.allowFailures) {
    const blockingScenarioCount = await readQaSuiteFailedOrSkippedScenarioCountFromFile(
      result.summaryPath,
    );
    if (blockingScenarioCount > 0) {
      process.exitCode = 1;
    }
  }
}
