import path from "node:path";
import { runQaSuiteCommand } from "../../cli.runtime.js";
import { scenarioDeclaresQaChannel } from "../../profile-planning.js";
import type { QaProviderMode } from "../../providers/index.js";
import { defaultQaModelForMode, normalizeQaProviderMode } from "../../run-config.js";
import {
  readQaScenarioById,
  readQaScenarioFile,
  type QaSeedScenarioWithSource,
} from "../../scenario-catalog.js";
import { selectQaFlowSuiteScenarios } from "../../suite-planning.js";
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
  const agentE2e = options.doctor === true || Boolean(options.scenarioFiles?.length);
  if (agentE2e && (options.scenarioIds?.length || options.profile)) {
    throw new Error(
      "--doctor and --scenario-file cannot be combined with --scenario or --profile.",
    );
  }
  if (options.doctor && options.scenarioFiles?.length) {
    throw new Error("--doctor cannot be combined with --scenario-file.");
  }
  const credentialSource =
    options.credentialSource?.trim() ||
    process.env.OPENCLAW_QA_CREDENTIAL_SOURCE?.trim() ||
    (agentE2e ? "convex" : undefined);
  const channelDriver = resolveDedicatedChannelDriver(options.channelDriver);
  if (agentE2e && channelDriver !== "live") {
    throw new Error("--doctor and --scenario-file require the live channel driver.");
  }
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
      ? agentE2e
        ? "mock-openai"
        : params.defaultProviderMode
      : normalizeQaProviderMode(options.providerMode);
  const primaryModel = options.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  let scenarioDefinitions: QaSeedScenarioWithSource[] | undefined;
  if (agentE2e) {
    scenarioDefinitions = options.doctor
      ? [readQaScenarioById(`${params.channelId}-e2e-doctor`)]
      : options.scenarioFiles!.map((file) => {
          if (!file.trim()) {
            throw new Error("--scenario-file must name a non-empty YAML file path.");
          }
          const filePath = path.resolve(options.repoRoot ?? process.cwd(), file.trim());
          return readQaScenarioFile(filePath);
        });
    const seenIds = new Set<string>();
    for (const scenario of scenarioDefinitions) {
      if (seenIds.has(scenario.id)) {
        throw new Error(`duplicate QA scenario id in selected files: ${scenario.id}`);
      }
      seenIds.add(scenario.id);
      if (scenario.execution.kind !== "flow" || !scenario.execution.flow) {
        throw new Error(`${scenario.sourcePath}: agent E2E requires a complete flow scenario.`);
      }
      if (!scenarioDeclaresQaChannel(scenario, params.channelId)) {
        throw new Error(
          `${scenario.sourcePath}: scenario ${scenario.id} must declare channel ${params.channelId}.`,
        );
      }
      if (scenario.execution.config?.agentE2e !== true) {
        throw new Error(
          `${scenario.sourcePath}: agent E2E requires execution.config.agentE2e: true.`,
        );
      }
      if (scenario.execution.retryCount !== undefined && scenario.execution.retryCount > 0) {
        throw new Error(`${scenario.sourcePath}: agent E2E native writes require retryCount: 0.`);
      }
      scenario.execution.retryCount ??= 0;
    }
    scenarioDefinitions = selectQaFlowSuiteScenarios({
      scenarios: scenarioDefinitions,
      scenarioIds: scenarioDefinitions.map((scenario) => scenario.id),
      providerMode,
      primaryModel,
      channelDriver,
      channel: params.channelId,
      resolveModuleFlowSupport: () => true,
    });
  }
  const selectedScenarioIds = scenarioDefinitions
    ? scenarioDefinitions.map((scenario) => scenario.id)
    : params.selectScenarioIds({
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
    ...(scenarioDefinitions ? { scenarioDefinitions } : {}),
    sutAccountId: options.sutAccountId,
    ...(options.credentialFile ? { credentialFile: options.credentialFile } : {}),
    ...(channelDriver === "crabline" || params.credentialMode === "env-only"
      ? {}
      : {
          credentialSource,
          credentialRole:
            options.credentialRole?.trim() ||
            (agentE2e ? process.env.OPENCLAW_QA_CREDENTIAL_ROLE?.trim() || "ci" : undefined),
        }),
    explicitScenarioSelection: agentE2e || Boolean(options.scenarioIds?.length),
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
