import { runQaSuiteCommand } from "../../cli.runtime.js";
import type { QaProviderMode } from "../../providers/index.js";
import { defaultQaModelForMode, normalizeQaProviderMode } from "../../run-config.js";
import type { LiveTransportQaCommandOptions } from "./live-transport-cli.js";
import {
  resolveCatalogLiveTransportQaScenarioIds,
  resolveLiveTransportQaScenarioIds,
} from "./scenario-selection.js";

type LiveTransportScenarioSelection = (params: {
  channelDriver: "live" | "crabline";
  profile?: string;
  primaryModel: string;
  providerMode: QaProviderMode;
  scenarioIds?: readonly string[];
}) => string[];

function resolveDedicatedChannelDriver(value: string | undefined): "live" | "crabline" {
  const normalized = value?.trim().toLowerCase() || "live";
  if (normalized !== "live" && normalized !== "crabline") {
    throw new Error(`channel driver must be live or crabline, got "${value}".`);
  }
  return normalized;
}

export async function runLiveTransportQaSuiteCommand(params: {
  channelId: string;
  credentialMode?: "env-only" | "shared-lease";
  defaultProviderMode: QaProviderMode;
  envCredentialReason?: string;
  laneLabel?: string;
  options: LiveTransportQaCommandOptions;
  selectScenarioIds: LiveTransportScenarioSelection;
}) {
  const options = params.options;
  const credentialSource =
    options.credentialSource?.trim() || process.env.OPENCLAW_QA_CREDENTIAL_SOURCE?.trim();
  const channelDriver = resolveDedicatedChannelDriver(options.channelDriver);
  if (channelDriver === "crabline") {
    if (options.credentialFile?.trim()) {
      throw new Error("QA Lab Crabline channel drivers do not use credential files.");
    }
    if (options.credentialSource?.trim()) {
      throw new Error("QA Lab Crabline channel drivers do not use --credential-source.");
    }
    if (options.credentialRole?.trim()) {
      throw new Error("QA Lab Crabline channel drivers do not use --credential-role.");
    }
  } else if (params.credentialMode === "env-only") {
    const laneLabel = params.laneLabel ?? params.channelId;
    if (credentialSource && credentialSource.toLowerCase() !== "env") {
      throw new Error(
        `QA Lab ${laneLabel} supports only --credential-source env${params.envCredentialReason ? ` because ${params.envCredentialReason}` : "."}`,
      );
    }
    if (options.credentialRole?.trim()) {
      throw new Error(`QA Lab ${laneLabel} does not use credential roles.`);
    }
  }

  const providerMode =
    options.providerMode === undefined
      ? params.defaultProviderMode
      : normalizeQaProviderMode(options.providerMode);
  const primaryModel = options.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  const selectedScenarioIds = params.selectScenarioIds({
    channelDriver,
    profile: options.profile,
    primaryModel,
    providerMode,
    scenarioIds: options.scenarioIds,
  });
  if (options.listScenarios) {
    for (const scenarioId of selectedScenarioIds) {
      process.stdout.write(`${scenarioId}\n`);
    }
    return undefined;
  }
  return runQaSuiteCommand({
    repoRoot: options.repoRoot,
    outputDir: options.outputDir,
    providerMode,
    primaryModel: options.primaryModel,
    alternateModel: options.alternateModel,
    fastMode: options.fastMode,
    allowFailures: options.allowFailures,
    failFast: options.failFast,
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    channelDriver,
    channel: params.channelId,
    scenarioIds: selectedScenarioIds,
    sutAccountId: options.sutAccountId,
    ...(options.credentialFile ? { credentialFile: options.credentialFile } : {}),
    ...(channelDriver === "crabline" || params.credentialMode === "env-only"
      ? {}
      : {
          credentialSource,
          credentialRole: options.credentialRole?.trim(),
        }),
    explicitScenarioSelection: Boolean(options.scenarioIds?.length),
  });
}

export async function runStandardLiveTransportQaSuiteCommand(params: {
  channelId: string;
  options: LiveTransportQaCommandOptions;
}) {
  return await runLiveTransportQaSuiteCommand({
    channelId: params.channelId,
    defaultProviderMode: "live-frontier",
    options: params.options,
    selectScenarioIds: ({ channelDriver, profile, primaryModel, providerMode, scenarioIds }) =>
      channelDriver === "crabline"
        ? resolveCatalogLiveTransportQaScenarioIds({
            channelId: params.channelId,
            channelDriver,
            primaryModel,
            providerMode,
            scenarioIds,
            supportsModuleFlows: true,
          })
        : resolveLiveTransportQaScenarioIds({
            channelId: params.channelId,
            profile,
            primaryModel,
            providerMode,
            scenarioIds,
            supportsModuleFlows: true,
          }),
  });
}
