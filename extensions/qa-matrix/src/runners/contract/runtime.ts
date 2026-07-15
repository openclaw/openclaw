// Qa Matrix plugin module implements runtime behavior.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { loadQaRuntimeModule } from "openclaw/plugin-sdk/qa-runner-runtime";
import {
  appendQaLiveLaneIssue as appendLiveLaneIssue,
  buildQaLiveLaneArtifactsError as buildLiveLaneArtifactsError,
  renderQaMarkdownReport,
  type QaReportCheck,
} from "openclaw/plugin-sdk/qa-runtime";
import type { QaProviderModeInput } from "../../run-config.js";
import { buildMatrixQaObservedEventsArtifact } from "../../substrate/artifacts.js";
import { provisionMatrixQaRoom, type MatrixQaProvisionResult } from "../../substrate/client.js";
import {
  buildMatrixQaConfig,
  buildMatrixQaConfigSnapshot,
  summarizeMatrixQaConfigSnapshot,
  type MatrixQaConfigOverrides,
} from "../../substrate/config.js";
import {
  runMatrixQaDifferentialProbe,
  type MatrixQaDifferentialProbeResult,
} from "../../substrate/differential-probe.js";
import type { MatrixQaObservedEvent } from "../../substrate/events.js";
import { startMatrixQaHarness } from "../../substrate/harness.runtime.js";
import { resolveMatrixQaModels } from "./model-selection.js";
import {
  cleanupMatrixQaResource,
  createMatrixQaRunDeadline,
  formatMatrixQaDurationMs,
  patchMatrixQaGatewayConfig,
  readMatrixQaGatewayDebugSummary,
  resolveMatrixQaCanaryTimeoutMs,
  resolveMatrixQaOutputDir,
  waitForMatrixChannelReady,
  withMatrixQaRunDeadline,
  writeMatrixQaProgress,
  type MatrixQaGatewayChild,
} from "./runtime-control.js";
import {
  buildMatrixQaGatewayConfigKey,
  getMatrixQaScenarioRestartReadyTimeoutMs,
  resolveMatrixQaGatewayModels,
  scheduleMatrixQaScenariosInCatalogOrder,
  selectMatrixQaCanaryProviderMode,
} from "./runtime-planning.js";
import {
  buildMatrixQaSummary,
  type MatrixQaArtifactPaths,
  type MatrixQaScenarioConfigEntry,
  type MatrixQaScenarioResult,
  type MatrixQaScenarioTiming,
  type MatrixQaSummary,
} from "./runtime-summary.js";
import type { MatrixQaSyncStreams } from "./scenario-runtime-shared.js";
import {
  MATRIX_QA_SCENARIOS,
  buildMatrixQaTopologyForScenarios,
  buildMatrixReplyDetails,
  findMatrixQaScenarios,
  runMatrixQaCanary,
  runMatrixQaScenario,
  type MatrixQaCanaryArtifact,
  type MatrixQaScenarioArtifacts,
} from "./scenarios.js";

type MatrixQaLiveLaneGatewayHarness = {
  gateway: MatrixQaGatewayChild;
  stop(opts?: { keepTemp?: boolean; preserveToDir?: string }): Promise<void>;
};

type MatrixQaGatewaySelection = {
  overrides?: MatrixQaConfigOverrides;
  providerMode?: QaProviderModeInput;
};

function formatMatrixQaScenarioDetails(params: { details: string; configSummary?: string }) {
  if (!params.configSummary) {
    return params.details;
  }
  return [`effective config: ${params.configSummary}`, params.details].join("\n");
}

function buildMatrixQaScenarioConfigEntry(params: {
  gatewayConfigParams: {
    driverAccessToken?: string;
    driverUserId: string;
    homeserver: string;
    observerAccessToken?: string;
    observerUserId: string;
    sutAccessToken: string;
    sutAccountId: string;
    sutDeviceId?: string;
    sutUserId: string;
    topology: MatrixQaProvisionResult["topology"];
  };
  scenario: (typeof MATRIX_QA_SCENARIOS)[number];
}): {
  entry: MatrixQaScenarioConfigEntry;
  summary?: string;
} {
  const snapshot = buildMatrixQaConfigSnapshot({
    ...params.gatewayConfigParams,
    overrides: params.scenario.configOverrides,
  });
  const providerSummary = params.scenario.providerMode
    ? `providerMode=${params.scenario.providerMode}`
    : undefined;
  const configSummary =
    params.scenario.configOverrides === undefined
      ? undefined
      : summarizeMatrixQaConfigSnapshot(snapshot);
  return {
    entry: {
      config: snapshot,
      id: params.scenario.id,
      title: params.scenario.title,
    },
    summary: [providerSummary, configSummary].filter(Boolean).join(", ") || undefined,
  };
}

function buildMatrixQaScenarioResult(params: {
  artifacts?: MatrixQaScenarioArtifacts;
  configSummary?: string;
  details: string;
  scenario: {
    id: string;
    title: string;
  };
  status: "fail" | "pass";
}): MatrixQaScenarioResult {
  return {
    artifacts: params.artifacts,
    id: params.scenario.id,
    title: params.scenario.title,
    status: params.status,
    details: formatMatrixQaScenarioDetails({
      details: params.details,
      configSummary: params.configSummary,
    }),
  };
}

type MatrixQaRunResult = {
  observedEventsPath: string;
  outputDir: string;
  reportPath: string;
  routeStateManifestPath: string;
  scenarios: MatrixQaScenarioResult[];
  summaryPath: string;
};

async function measureMatrixQaStep<T>(step: () => Promise<T>) {
  const startedAtMs = Date.now();
  const result = await step();
  return {
    durationMs: Date.now() - startedAtMs,
    result,
  };
}

async function startMatrixQaLiveLaneGateway(params: {
  repoRoot: string;
  transport: {
    requiredPluginIds: readonly string[];
    createGatewayConfig: (params: {
      baseUrl: string;
    }) => Pick<OpenClawConfig, "channels" | "messages">;
  };
  transportBaseUrl: string;
  providerMode: "mock-openai" | "live-frontier";
  primaryModel: string;
  alternateModel: string;
  fastMode?: boolean;
  controlUiEnabled?: boolean;
  mutateConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
}): Promise<MatrixQaLiveLaneGatewayHarness> {
  return (await loadQaRuntimeModule().startQaLiveLaneGateway(
    params,
  )) as MatrixQaLiveLaneGatewayHarness;
}

export async function runMatrixQaLive(params: {
  fastMode?: boolean;
  failFast?: boolean;
  outputDir?: string;
  primaryModel?: string;
  profile?: string;
  providerMode?: QaProviderModeInput;
  repoRoot?: string;
  scenarioIds?: string[];
  sutAccountId?: string;
  alternateModel?: string;
}): Promise<MatrixQaRunResult> {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const outputDir = resolveMatrixQaOutputDir({ outputDir: params.outputDir, repoRoot });
  await fs.mkdir(outputDir, { recursive: true });

  const defaultModels = resolveMatrixQaModels({
    providerMode: params.providerMode,
    primaryModel: params.primaryModel,
    alternateModel: params.alternateModel,
  });
  const { providerMode } = defaultModels;
  const sutAccountId = params.sutAccountId?.trim() || "sut";
  const scenarios = findMatrixQaScenarios(params.scenarioIds, params.profile);
  const runSuffix = randomUUID().slice(0, 8);
  const topology = buildMatrixQaTopologyForScenarios({
    defaultRoomName: `OpenClaw Matrix QA ${runSuffix}`,
    scenarios,
  });
  const observedEvents: MatrixQaObservedEvent[] = [];
  const includeObservedEventContent = process.env.OPENCLAW_QA_MATRIX_CAPTURE_CONTENT === "1";
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const runStartedAtMs = Date.now();
  const runDeadline = createMatrixQaRunDeadline();
  writeMatrixQaProgress(
    `suite start scenarios=${scenarios.length} profile=${params.profile?.trim() || "all"} provider=${providerMode} output=${outputDir} timeout=${formatMatrixQaDurationMs(runDeadline.timeoutMs)}`,
  );

  const { durationMs: harnessBootMs, result: harness } = await measureMatrixQaStep(() =>
    withMatrixQaRunDeadline(runDeadline, "Matrix harness boot", () =>
      startMatrixQaHarness({
        outputDir: path.join(outputDir, "matrix-harness"),
        repoRoot,
      }),
    ),
  );
  writeMatrixQaProgress(
    `harness ready ${formatMatrixQaDurationMs(harnessBootMs)} baseUrl=${harness.baseUrl}`,
  );
  const { durationMs: provisioningMs, result: provisioning } = await (async () => {
    try {
      return await measureMatrixQaStep(() =>
        withMatrixQaRunDeadline(runDeadline, "Matrix topology provisioning", () =>
          provisionMatrixQaRoom({
            baseUrl: harness.baseUrl,
            driverLocalpart: `qa-driver-${runSuffix}`,
            observerLocalpart: `qa-observer-${runSuffix}`,
            registrationToken: harness.registrationToken,
            roomName: `OpenClaw Matrix QA ${runSuffix}`,
            sutLocalpart: `qa-sut-${runSuffix}`,
            topology,
          }),
        ),
      );
    } catch (error) {
      await cleanupMatrixQaResource({
        label: "Matrix homeserver cleanup after provisioning failure",
        action: () => harness.stop(),
        recovery: harness.stopCommand,
      }).catch(() => {});
      throw error;
    }
  })();
  writeMatrixQaProgress(
    `topology ready ${formatMatrixQaDurationMs(provisioningMs)} rooms=${provisioning.topology.rooms.length}`,
  );
  const checks: QaReportCheck[] = [
    {
      name: "Matrix harness ready",
      status: "pass",
      details: [
        `image: ${harness.image}`,
        `baseUrl: ${harness.baseUrl}`,
        `serverName: ${harness.serverName}`,
        `roomId: ${provisioning.roomId}`,
        `roomCount: ${provisioning.topology.rooms.length}`,
      ].join("\n"),
    },
  ];
  harness.recording.setScenarioId("matrix-qa-v1-probe");
  let differentialProbe: MatrixQaDifferentialProbeResult | undefined;
  try {
    differentialProbe = await withMatrixQaRunDeadline(
      runDeadline,
      "Matrix differential probe",
      () =>
        runMatrixQaDifferentialProbe({
          accessToken: provisioning.driver.accessToken,
          baseUrl: harness.baseUrl,
          roomId: provisioning.roomId,
          userId: provisioning.driver.userId,
        }),
    );
    checks.push({ name: "Matrix differential probe", status: "pass" });
  } catch (error) {
    checks.push({
      details: error instanceof Error ? error.message : String(error),
      name: "Matrix differential probe",
      status: "fail",
    });
  }
  const scenarioResults: Array<MatrixQaScenarioResult | undefined> = Array.from({
    length: scenarios.length,
  });
  const cleanupErrors: string[] = [];
  let canaryArtifact: MatrixQaCanaryArtifact | undefined;
  let gatewayHarness: MatrixQaLiveLaneGatewayHarness | null = null;
  let gatewayHarnessKey: string | null = null;
  let preservedGatewayDebugDirPath: string | undefined;
  let canaryFailed = false;
  const syncState: { driver?: string; observer?: string } = {};
  const syncStreams: MatrixQaSyncStreams = {};
  let canaryMs: number | undefined;
  let initialGatewayBootMs = 0;
  let scenarioGatewayBootMs = 0;
  let scenarioRestartGatewayMs = 0;
  let scenarioTransportInterruptMs = 0;
  const scenarioTimings: MatrixQaScenarioTiming[] = [];
  const gatewayConfigParams = {
    driverAccessToken: provisioning.driver.accessToken,
    driverUserId: provisioning.driver.userId,
    homeserver: harness.baseUrl,
    observerAccessToken: provisioning.observer.accessToken,
    observerUserId: provisioning.observer.userId,
    sutAccessToken: provisioning.sut.accessToken,
    sutAccountId,
    sutDeviceId: provisioning.sut.deviceId,
    sutUserId: provisioning.sut.userId,
    topology: provisioning.topology,
  };
  const defaultConfigSnapshot = buildMatrixQaConfigSnapshot(gatewayConfigParams);
  const scenarioConfigSnapshots: MatrixQaScenarioConfigEntry[] = [];

  const scheduledScenarios = scheduleMatrixQaScenariosInCatalogOrder(scenarios);

  matrixQaExecution: try {
    if (params.failFast && !differentialProbe) {
      writeMatrixQaProgress("fail-fast stop");
      break matrixQaExecution;
    }
    harness.recording.setScenarioId("canary");
    const ensureGatewayHarness = async (selection: MatrixQaGatewaySelection = {}) => {
      const models = resolveMatrixQaGatewayModels({
        defaultModels,
        providerMode: selection.providerMode,
      });
      const overrides = selection.overrides;
      const nextKey = buildMatrixQaGatewayConfigKey({
        models,
        overrides,
      });
      if (gatewayHarness && gatewayHarnessKey === nextKey) {
        return {
          durationMs: 0,
          harness: gatewayHarness,
        };
      }
      if (gatewayHarness) {
        await cleanupMatrixQaResource({
          label: "Matrix live gateway cleanup before config switch",
          action: () => gatewayHarness!.stop(),
        });
        gatewayHarness = null;
        gatewayHarnessKey = nextKey;
      }
      writeMatrixQaProgress("gateway boot start");
      const { durationMs, result: started } = await measureMatrixQaStep(() =>
        withMatrixQaRunDeadline(runDeadline, "Matrix gateway boot", async () => {
          const nextHarness = await startMatrixQaLiveLaneGateway({
            repoRoot,
            transport: {
              requiredPluginIds: [],
              createGatewayConfig: () => ({}),
            },
            transportBaseUrl: "http://127.0.0.1:43123",
            providerMode: models.providerMode,
            primaryModel: models.primaryModel,
            alternateModel: models.alternateModel,
            fastMode: params.fastMode,
            controlUiEnabled: false,
            mutateConfig: (cfg) =>
              buildMatrixQaConfig(cfg, {
                ...gatewayConfigParams,
                overrides,
              }),
          });
          await waitForMatrixChannelReady(nextHarness.gateway, sutAccountId);
          return nextHarness;
        }),
      );
      writeMatrixQaProgress(`gateway boot done ${formatMatrixQaDurationMs(durationMs)}`);
      gatewayHarness = started;
      gatewayHarnessKey = nextKey;
      return {
        durationMs,
        harness: started,
      };
    };

    {
      const ensured = await ensureGatewayHarness({
        providerMode: selectMatrixQaCanaryProviderMode(scheduledScenarios),
      });
      gatewayHarness = ensured.harness;
      initialGatewayBootMs = ensured.durationMs;
    }
    checks.push({
      name: "Matrix channel ready",
      status: "pass",
      details: `accountId: ${sutAccountId}\nuserId: ${provisioning.sut.userId}`,
    });

    try {
      writeMatrixQaProgress("canary start");
      const canaryMeasured = await measureMatrixQaStep(() =>
        withMatrixQaRunDeadline(runDeadline, "Matrix canary", () =>
          runMatrixQaCanary({
            baseUrl: harness.baseUrl,
            driverAccessToken: provisioning.driver.accessToken,
            observedEvents,
            roomId: provisioning.roomId,
            syncState,
            syncStreams,
            sutUserId: provisioning.sut.userId,
            timeoutMs: resolveMatrixQaCanaryTimeoutMs(),
          }),
        ),
      );
      canaryMs = canaryMeasured.durationMs;
      const canary = canaryMeasured.result;
      canaryArtifact = {
        driverEventId: canary.driverEventId,
        reply: canary.reply,
        token: canary.token,
      };
      checks.push({
        name: "Matrix canary",
        status: "pass",
        details: buildMatrixReplyDetails("reply", canary.reply).join("\n"),
      });
      writeMatrixQaProgress(`canary pass ${formatMatrixQaDurationMs(canaryMeasured.durationMs)}`);
    } catch (error) {
      canaryFailed = true;
      checks.push({
        name: "Matrix canary",
        status: "fail",
        details: formatErrorMessage(error),
      });
      writeMatrixQaProgress(`canary fail ${formatErrorMessage(error)}`);
    }

    if (!canaryFailed) {
      for (const { scenario, originalIndex } of scheduledScenarios) {
        harness.recording.setScenarioId(scenario.id);
        const { entry: scenarioConfigEntry, summary: scenarioConfigSummary } =
          buildMatrixQaScenarioConfigEntry({
            gatewayConfigParams,
            scenario,
          });
        scenarioConfigSnapshots[originalIndex] = scenarioConfigEntry;
        let gatewayBootMs = 0;
        let gatewayRestartMs = 0;
        let transportInterruptMs = 0;
        try {
          writeMatrixQaProgress(`scenario start ${scenario.id}`);
          const scenarioGateway = await ensureGatewayHarness({
            overrides: scenario.configOverrides,
            providerMode: scenario.providerMode,
          });
          gatewayBootMs = scenarioGateway.durationMs;
          scenarioGatewayBootMs += gatewayBootMs;
          const measuredScenario = await measureMatrixQaStep(() =>
            withMatrixQaRunDeadline(runDeadline, `Matrix scenario ${scenario.id}`, () =>
              runMatrixQaScenario(scenario, {
                baseUrl: harness.baseUrl,
                canary: canaryArtifact,
                driverAccessToken: provisioning.driver.accessToken,
                driverDeviceId: provisioning.driver.deviceId,
                driverPassword: provisioning.driver.password,
                driverUserId: provisioning.driver.userId,
                faultProxyObserver: harness.recording,
                faultProxyTargetBaseUrl: harness.upstreamBaseUrl,
                interruptTransport: async () => {
                  writeMatrixQaProgress(`transport interrupt start ${scenario.id}`);
                  const measuredInterrupt = await measureMatrixQaStep(async () => {
                    await harness.restartService();
                    await waitForMatrixChannelReady(scenarioGateway.harness.gateway, sutAccountId, {
                      timeoutMs: 90_000,
                    });
                  });
                  transportInterruptMs += measuredInterrupt.durationMs;
                  scenarioTransportInterruptMs += measuredInterrupt.durationMs;
                  writeMatrixQaProgress(
                    `transport interrupt done ${scenario.id} ${formatMatrixQaDurationMs(measuredInterrupt.durationMs)}`,
                  );
                },
                observedEvents,
                observerAccessToken: provisioning.observer.accessToken,
                observerDeviceId: provisioning.observer.deviceId,
                observerPassword: provisioning.observer.password,
                observerUserId: provisioning.observer.userId,
                gatewayRuntimeEnv: scenarioGateway.harness.gateway.runtimeEnv,
                gatewayStateDir: scenarioGateway.harness.gateway.runtimeEnv?.OPENCLAW_STATE_DIR,
                gatewayWorkspaceDir: scenarioGateway.harness.gateway.workspaceDir,
                gatewayCall: async (method, paramsLocal, opts) =>
                  await scenarioGateway.harness.gateway.call(method, paramsLocal ?? {}, opts),
                outputDir,
                registrationToken: harness.registrationToken,
                restartGateway: async () => {
                  if (!gatewayHarness) {
                    throw new Error("Matrix restart scenario requires a live gateway");
                  }
                  writeMatrixQaProgress(`gateway restart start ${scenario.id}`);
                  const measuredRestart = await measureMatrixQaStep(async () => {
                    await scenarioGateway.harness.gateway.restart();
                    await waitForMatrixChannelReady(scenarioGateway.harness.gateway, sutAccountId, {
                      timeoutMs: getMatrixQaScenarioRestartReadyTimeoutMs(scenario),
                    });
                  });
                  gatewayRestartMs += measuredRestart.durationMs;
                  scenarioRestartGatewayMs += measuredRestart.durationMs;
                  writeMatrixQaProgress(
                    `gateway restart done ${scenario.id} ${formatMatrixQaDurationMs(measuredRestart.durationMs)}`,
                  );
                },
                restartGatewayAfterStateMutation: async (mutateState, opts) => {
                  if (!gatewayHarness) {
                    throw new Error(
                      "Matrix persisted-state restart scenario requires a live gateway",
                    );
                  }
                  const restartAfterStateMutation =
                    scenarioGateway.harness.gateway.restartAfterStateMutation;
                  if (!restartAfterStateMutation) {
                    throw new Error(
                      "Matrix persisted-state restart scenario requires a hard restart callback",
                    );
                  }
                  writeMatrixQaProgress(`gateway hard restart start ${scenario.id}`);
                  const measuredRestart = await measureMatrixQaStep(async () => {
                    await restartAfterStateMutation(mutateState);
                    await waitForMatrixChannelReady(
                      scenarioGateway.harness.gateway,
                      opts?.waitAccountId ?? sutAccountId,
                      {
                        timeoutMs:
                          opts?.timeoutMs ?? getMatrixQaScenarioRestartReadyTimeoutMs(scenario),
                      },
                    );
                  });
                  gatewayRestartMs += measuredRestart.durationMs;
                  scenarioRestartGatewayMs += measuredRestart.durationMs;
                  writeMatrixQaProgress(
                    `gateway hard restart done ${scenario.id} ${formatMatrixQaDurationMs(measuredRestart.durationMs)}`,
                  );
                },
                restartGatewayWithQueuedMessage: async (queueMessage) => {
                  if (!gatewayHarness) {
                    throw new Error("Matrix restart catchup scenario requires a live gateway");
                  }
                  writeMatrixQaProgress(`gateway restart+queue start ${scenario.id}`);
                  const measuredRestart = await measureMatrixQaStep(async () => {
                    await scenarioGateway.harness.gateway.restart();
                    await sleep(250);
                    await queueMessage();
                    await waitForMatrixChannelReady(scenarioGateway.harness.gateway, sutAccountId, {
                      timeoutMs: getMatrixQaScenarioRestartReadyTimeoutMs(scenario),
                    });
                  });
                  gatewayRestartMs += measuredRestart.durationMs;
                  scenarioRestartGatewayMs += measuredRestart.durationMs;
                  writeMatrixQaProgress(
                    `gateway restart+queue done ${scenario.id} ${formatMatrixQaDurationMs(measuredRestart.durationMs)}`,
                  );
                },
                roomId: provisioning.roomId,
                sutAccountId,
                sutAccessToken: provisioning.sut.accessToken,
                sutDeviceId: provisioning.sut.deviceId,
                sutPassword: provisioning.sut.password,
                syncState,
                syncStreams,
                sutUserId: provisioning.sut.userId,
                timeoutMs: scenario.timeoutMs,
                topology: provisioning.topology,
                patchGatewayConfig: async (patch, opts) => {
                  await patchMatrixQaGatewayConfig({
                    gateway: scenarioGateway.harness.gateway,
                    patch,
                    replacePaths: opts?.replacePaths,
                    restartDelayMs: opts?.restartDelayMs,
                  });
                },
                waitGatewayAccountReady: async (accountId, opts) => {
                  await waitForMatrixChannelReady(scenarioGateway.harness.gateway, accountId, {
                    timeoutMs:
                      opts?.timeoutMs ?? getMatrixQaScenarioRestartReadyTimeoutMs(scenario),
                  });
                },
              }),
            ),
          );
          const result = measuredScenario.result;
          scenarioTimings[originalIndex] = {
            durationMs: measuredScenario.durationMs,
            gatewayBootMs,
            gatewayRestartMs,
            id: scenario.id,
            title: scenario.title,
            transportInterruptMs,
          };
          scenarioResults[originalIndex] = buildMatrixQaScenarioResult({
            artifacts: result.artifacts,
            configSummary: scenarioConfigSummary,
            details: result.details,
            scenario,
            status: "pass",
          });
          writeMatrixQaProgress(
            `scenario pass ${scenario.id} ${formatMatrixQaDurationMs(measuredScenario.durationMs)}`,
          );
        } catch (error) {
          scenarioTimings[originalIndex] = {
            durationMs: 0,
            gatewayBootMs,
            gatewayRestartMs,
            id: scenario.id,
            title: scenario.title,
            transportInterruptMs,
          };
          scenarioResults[originalIndex] = buildMatrixQaScenarioResult({
            configSummary: scenarioConfigSummary,
            details: formatErrorMessage(error),
            scenario,
            status: "fail",
          });
          writeMatrixQaProgress(`scenario fail ${scenario.id} ${formatErrorMessage(error)}`);
          if (params.failFast) {
            writeMatrixQaProgress("fail-fast stop");
            break;
          }
        }
      }
    }
  } finally {
    harness.recording.setScenarioId("cleanup");
    if (gatewayHarness) {
      try {
        const shouldPreserveGatewayDebugArtifacts =
          scenarioResults.some((scenario) => scenario?.status === "fail") || canaryFailed;
        preservedGatewayDebugDirPath = shouldPreserveGatewayDebugArtifacts
          ? path.join(outputDir, "gateway-debug")
          : undefined;
        await cleanupMatrixQaResource({
          label: "Matrix live gateway cleanup",
          action: () =>
            gatewayHarness!.stop(
              preservedGatewayDebugDirPath
                ? { preserveToDir: preservedGatewayDebugDirPath }
                : undefined,
            ),
        });
      } catch (error) {
        appendLiveLaneIssue(cleanupErrors, "live gateway cleanup", error);
      }
    }
    try {
      await cleanupMatrixQaResource({
        label: "Matrix homeserver cleanup",
        action: () => harness.stop(),
        recovery: harness.stopCommand,
      });
    } catch (error) {
      appendLiveLaneIssue(cleanupErrors, "Matrix harness cleanup", error);
    }
  }
  const completedScenarioResults = scenarioResults.filter(
    (scenario): scenario is MatrixQaScenarioResult => scenario !== undefined,
  );
  if (cleanupErrors.length > 0) {
    checks.push({
      name: "Matrix cleanup",
      status: "fail",
      details: cleanupErrors.join("\n"),
    });
  }
  const gatewayDebugSummary = preservedGatewayDebugDirPath
    ? await readMatrixQaGatewayDebugSummary(preservedGatewayDebugDirPath)
    : undefined;
  if (preservedGatewayDebugDirPath) {
    checks.push({
      name: "Matrix gateway debug logs",
      status: "pass",
      details: [`preserved at: ${preservedGatewayDebugDirPath}`, gatewayDebugSummary]
        .filter(Boolean)
        .join("\n"),
    });
  }

  const finishedAtDate = new Date();
  const finishedAt = finishedAtDate.toISOString();
  const reportPath = path.join(outputDir, "matrix-qa-report.md");
  const summaryPath = path.join(outputDir, "matrix-qa-summary.json");
  const observedEventsPath = path.join(outputDir, "matrix-qa-observed-events.json");
  const routeStateManifestPath = path.join(outputDir, "matrix-qa-route-state-manifest.json");
  const artifactPaths = {
    observedEvents: observedEventsPath,
    report: reportPath,
    routeStateManifest: routeStateManifestPath,
    summary: summaryPath,
  } satisfies MatrixQaArtifactPaths;
  const routeStateManifest = harness.recording.buildManifest({
    generatedAt: finishedAt,
    requestedProfile: params.profile?.trim() || "all",
    scenarioIds: completedScenarioResults.map((scenario) => scenario.id),
    substrate: {
      id: "tuwunel",
      version: harness.image,
    },
  });
  const report = renderQaMarkdownReport({
    title: "Matrix QA Report",
    startedAt: startedAtDate,
    finishedAt: finishedAtDate,
    checks,
    scenarios: completedScenarioResults.map((scenario) => ({
      details: scenario.details,
      name: scenario.title,
      status: scenario.status,
    })),
    notes: [
      `roomId: ${provisioning.roomId}`,
      `roomIds: ${provisioning.topology.rooms.map((room) => room.roomId).join(", ")}`,
      `default config: ${summarizeMatrixQaConfigSnapshot(defaultConfigSnapshot)}`,
      `driver: ${provisioning.driver.userId}`,
      `observer: ${provisioning.observer.userId}`,
      `sut: ${provisioning.sut.userId}`,
      `homeserver: ${harness.baseUrl}`,
      `image: ${harness.image}`,
      `timings: harness=${harnessBootMs}ms provisioning=${provisioningMs}ms gateway=${initialGatewayBootMs}ms canary=${canaryMs ?? 0}ms`,
    ],
  });
  const artifactWriteStartedAtMs = Date.now();
  const summary: MatrixQaSummary = buildMatrixQaSummary({
    artifactPaths,
    canary: canaryArtifact,
    checks,
    config: {
      default: defaultConfigSnapshot,
      scenarios: scenarioConfigSnapshots,
    },
    differentialProbe,
    finishedAt,
    harness: {
      baseUrl: harness.baseUrl,
      composeFile: harness.composeFile,
      dmRoomIds: provisioning.topology.rooms
        .filter((room) => room.kind === "dm")
        .map((room) => room.roomId),
      image: harness.image,
      roomId: provisioning.roomId,
      roomIds: provisioning.topology.rooms.map((room) => room.roomId),
      serverName: harness.serverName,
    },
    observedEventCount: observedEvents.length,
    scenarios: completedScenarioResults,
    startedAt,
    sutAccountId,
    timings: {
      artifactWriteMs: 0,
      canaryMs,
      harnessBootMs,
      initialGatewayBootMs,
      provisioningMs,
      scenarioGatewayBootMs,
      scenarioRestartGatewayMs,
      scenarioTransportInterruptMs,
      scenarios: scenarioTimings,
      totalMs: Date.now() - runStartedAtMs,
    },
    userIds: {
      driver: provisioning.driver.userId,
      observer: provisioning.observer.userId,
      sut: provisioning.sut.userId,
    },
  });

  await fs.writeFile(reportPath, `${report}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.writeFile(
    observedEventsPath,
    `${JSON.stringify(
      buildMatrixQaObservedEventsArtifact({
        includeContent: includeObservedEventContent,
        observedEvents,
      }),
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.writeFile(routeStateManifestPath, `${JSON.stringify(routeStateManifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  summary.timings.artifactWriteMs = Date.now() - artifactWriteStartedAtMs;
  summary.timings.totalMs = Date.now() - runStartedAtMs;
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  writeMatrixQaProgress(
    `suite ${summary.counts.failed > 0 ? "fail" : "pass"} ${summary.counts.passed}/${summary.counts.total} total=${formatMatrixQaDurationMs(summary.timings.totalMs)}`,
  );

  const failedChecks = checks.filter(
    (check) => check.status === "fail" && check.name !== "Matrix cleanup",
  );
  const failedScenarios = completedScenarioResults.filter((scenario) => scenario.status === "fail");
  if (failedChecks.length > 0 || failedScenarios.length > 0) {
    throw new Error(
      buildLiveLaneArtifactsError({
        heading: "Matrix QA failed.",
        details: [
          ...failedChecks.map((check) => `check ${check.name}: ${check.details ?? "failed"}`),
          ...failedScenarios.map((scenario) => `scenario ${scenario.id}: ${scenario.details}`),
          ...(gatewayDebugSummary ? [`gateway debug: ${gatewayDebugSummary}`] : []),
          ...cleanupErrors.map((error) => `cleanup: ${error}`),
        ],
        artifacts: artifactPaths,
      }),
    );
  }
  if (cleanupErrors.length > 0) {
    throw new Error(
      buildLiveLaneArtifactsError({
        heading: "Matrix QA cleanup failed after artifacts were written.",
        details: cleanupErrors,
        artifacts: artifactPaths,
      }),
    );
  }

  return {
    observedEventsPath,
    outputDir,
    reportPath,
    routeStateManifestPath,
    scenarios: completedScenarioResults,
    summaryPath,
  };
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
