import { sanitizeQaProgressValue } from "./progress-format.js";
import { collectQaSuiteTransportPolicy } from "./suite-planning.js";
import type { QaSuiteResolvedRunContext, QaSuiteRunParams } from "./suite-types.js";
import {
  createQaSuiteTransportAdapter,
  requireQaSuiteStartLab,
  waitForQaLabReadyOrStopOwned,
  writeQaSuiteProgress,
} from "./suite.js";

type RunResourceParams = Pick<
  QaSuiteRunParams,
  "lab" | "startLab" | "adapterFactories" | "adapterOptions" | "channelId"
> & {
  channelDriver?: QaSuiteRunParams["channelDriver"] | null;
  scenarioIds?: readonly string[];
};

type RunResourceContext = Pick<
  QaSuiteResolvedRunContext,
  | "repoRoot"
  | "outputDir"
  | "startedAt"
  | "selectedScenarios"
  | "providerMode"
  | "primaryModel"
  | "alternateModel"
  | "fastMode"
  | "concurrency"
  | "progressEnabled"
  | "transportId"
>;

export async function createQaSuiteRunResources(
  params: RunResourceParams | undefined,
  context: RunResourceContext,
  mode: "standard" | "isolated" | "runtime-pair",
) {
  const { repoRoot, outputDir, selectedScenarios, progressEnabled, transportId } = context;
  const ownsLab = !params?.lab;
  if (mode === "standard") {
    writeQaSuiteProgress(progressEnabled, "lab start");
  }
  const lab =
    params?.lab ??
    (await requireQaSuiteStartLab(params?.startLab)({
      repoRoot,
      host: "127.0.0.1",
      port: 0,
      embeddedGateway: "disabled",
    }));
  if (mode === "standard") {
    writeQaSuiteProgress(progressEnabled, `lab ready: ${sanitizeQaProgressValue(lab.baseUrl)}`);
    await waitForQaLabReadyOrStopOwned({ lab, ownsLab });
  }
  const transportFactoryResult = await createQaSuiteTransportAdapter({
    adapterFactories: params?.adapterFactories,
    channelDriver: params?.channelDriver,
    channelId: params?.channelId,
    adapterOptions:
      mode === "runtime-pair"
        ? params?.adapterOptions
        : {
            ...params?.adapterOptions,
            scenarioIds: selectedScenarios.map((scenario) => scenario.id),
            ...(mode === "standard" &&
            selectedScenarios.some(
              (scenario) =>
                scenario.execution.kind === "flow" && scenario.execution.config?.agentE2e === true,
            )
              ? { agentE2e: true }
              : {}),
          },
    cleanupOnFailure: ownsLab ? () => lab.stop() : undefined,
    outputDir,
    ...(mode === "isolated"
      ? {}
      : { transportPolicy: collectQaSuiteTransportPolicy(selectedScenarios) }),
    state: lab.state,
    transportId,
  });
  const transport = transportFactoryResult.adapter;
  const artifactParams = {
    outputDir,
    startedAt: context.startedAt,
    transport,
    providerMode: context.providerMode,
    primaryModel: context.primaryModel,
    alternateModel: context.alternateModel,
    fastMode: context.fastMode,
    concurrency: context.concurrency,
    channel: params?.channelId ?? transport.id,
    channelDriver: transportFactoryResult.driver,
    scenarioIds: params?.scenarioIds?.length
      ? selectedScenarios.map((scenario) => scenario.id)
      : undefined,
  };
  return { lab, ownsLab, transportFactoryResult, transport, artifactParams };
}
