import path from "node:path";
import { buildQaDockerHarnessImage, writeQaDockerHarnessFiles } from "./docker-harness.js";
import { runQaDockerUp } from "./docker-up.runtime.js";
import { startQaLabServer } from "./lab-server.js";
import { runQaManualLane } from "./manual-lane.runtime.js";
import { startQaMockOpenAiServer } from "./mock-openai-server.js";
import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  type QaProviderMode,
  type QaProviderModeInput,
} from "./run-config.js";
import { runQaSuite } from "./suite.js";

type InterruptibleServer = {
  baseUrl: string;
  stop(): Promise<void>;
};

function resolveQaManualLaneModels(opts: {
  providerMode: QaProviderMode;
  primaryModel?: string;
  alternateModel?: string;
}) {
  const primaryModel = opts.primaryModel?.trim() || defaultQaModelForMode(opts.providerMode);
  const alternateModel = opts.alternateModel?.trim();
  return {
    primaryModel,
    alternateModel:
      alternateModel && alternateModel.length > 0
        ? alternateModel
        : opts.primaryModel?.trim()
          ? primaryModel
          : defaultQaModelForMode(opts.providerMode, true),
  };
}

async function runInterruptibleServer(label: string, server: InterruptibleServer) {
  process.stdout.write(`${label}: ${server.baseUrl}\n`);
  process.stdout.write("Press Ctrl+C to stop.\n");

  const shutdown = async () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await server.stop();
    process.exit(0);
  };

  const onSignal = () => {
    void shutdown();
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  await new Promise(() => undefined);
}

export async function runQaLabSelfCheckCommand(opts: { repoRoot?: string; output?: string }) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const server = await startQaLabServer({
    repoRoot,
    outputPath: opts.output ? path.resolve(repoRoot, opts.output) : undefined,
  });
  try {
    const result = await server.runSelfCheck();
    process.stdout.write(`QA self-check report: ${result.outputPath}\n`);
  } finally {
    await server.stop();
  }
}

export async function runQaSuiteCommand(opts: {
  repoRoot?: string;
  outputDir?: string;
  providerMode?: QaProviderModeInput;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  scenarioIds?: string[];
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const providerMode = normalizeQaProviderMode(opts.providerMode);
  const result = await runQaSuite({
    repoRoot,
    outputDir: opts.outputDir ? path.resolve(repoRoot, opts.outputDir) : undefined,
    providerMode,
    primaryModel: opts.primaryModel,
    alternateModel: opts.alternateModel,
    fastMode: opts.fastMode,
    scenarioIds: opts.scenarioIds,
  });
  process.stdout.write(`QA suite watch: ${result.watchUrl}\n`);
  process.stdout.write(`QA suite report: ${result.reportPath}\n`);
  process.stdout.write(`QA suite summary: ${result.summaryPath}\n`);
}

export async function runQaManualLaneCommand(opts: {
  repoRoot?: string;
  providerMode?: QaProviderModeInput;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  message: string;
  timeoutMs?: number;
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const providerMode: QaProviderMode =
    opts.providerMode === undefined ? "live-frontier" : normalizeQaProviderMode(opts.providerMode);
  const models = resolveQaManualLaneModels({
    providerMode,
    primaryModel: opts.primaryModel,
    alternateModel: opts.alternateModel,
  });
  const result = await runQaManualLane({
    repoRoot,
    providerMode,
    primaryModel: models.primaryModel,
    alternateModel: models.alternateModel,
    fastMode: opts.fastMode,
    message: opts.message,
    timeoutMs: opts.timeoutMs,
  });
  process.stdout.write(JSON.stringify(result, null, 2));
  process.stdout.write("\n");
}

export async function runQaLabUiCommand(opts: {
  repoRoot?: string;
  host?: string;
  port?: number;
  advertiseHost?: string;
  advertisePort?: number;
  controlUiUrl?: string;
  controlUiToken?: string;
  controlUiProxyTarget?: string;
  uiDistDir?: string;
  autoKickoffTarget?: string;
  embeddedGateway?: string;
  sendKickoffOnStart?: boolean;
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const server = await startQaLabServer({
    repoRoot,
    host: opts.host,
    port: Number.isFinite(opts.port) ? opts.port : undefined,
    advertiseHost: opts.advertiseHost,
    advertisePort: Number.isFinite(opts.advertisePort) ? opts.advertisePort : undefined,
    controlUiUrl: opts.controlUiUrl,
    controlUiToken: opts.controlUiToken,
    controlUiProxyTarget: opts.controlUiProxyTarget,
    uiDistDir: opts.uiDistDir,
    autoKickoffTarget: opts.autoKickoffTarget,
    embeddedGateway: opts.embeddedGateway,
    sendKickoffOnStart: opts.sendKickoffOnStart,
  });
  await runInterruptibleServer("QA Lab UI", server);
}

export async function runQaDockerScaffoldCommand(opts: {
  repoRoot?: string;
  outputDir: string;
  gatewayPort?: number;
  qaLabPort?: number;
  providerBaseUrl?: string;
  image?: string;
  usePrebuiltImage?: boolean;
  bindUiDist?: boolean;
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const outputDir = path.resolve(repoRoot, opts.outputDir);
  const result = await writeQaDockerHarnessFiles({
    outputDir,
    repoRoot,
    gatewayPort: Number.isFinite(opts.gatewayPort) ? opts.gatewayPort : undefined,
    qaLabPort: Number.isFinite(opts.qaLabPort) ? opts.qaLabPort : undefined,
    providerBaseUrl: opts.providerBaseUrl,
    imageName: opts.image,
    usePrebuiltImage: opts.usePrebuiltImage,
    bindUiDist: opts.bindUiDist,
  });
  process.stdout.write(`QA docker scaffold: ${result.outputDir}\n`);
}

export async function runQaDockerBuildImageCommand(opts: { repoRoot?: string; image?: string }) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const result = await buildQaDockerHarnessImage({
    repoRoot,
    imageName: opts.image,
  });
  process.stdout.write(`QA docker image: ${result.imageName}\n`);
}

export async function runQaDockerUpCommand(opts: {
  repoRoot?: string;
  outputDir?: string;
  gatewayPort?: number;
  qaLabPort?: number;
  providerBaseUrl?: string;
  image?: string;
  usePrebuiltImage?: boolean;
  bindUiDist?: boolean;
  skipUiBuild?: boolean;
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const result = await runQaDockerUp({
    repoRoot,
    outputDir: opts.outputDir ? path.resolve(repoRoot, opts.outputDir) : undefined,
    gatewayPort: Number.isFinite(opts.gatewayPort) ? opts.gatewayPort : undefined,
    qaLabPort: Number.isFinite(opts.qaLabPort) ? opts.qaLabPort : undefined,
    providerBaseUrl: opts.providerBaseUrl,
    image: opts.image,
    usePrebuiltImage: opts.usePrebuiltImage,
    bindUiDist: opts.bindUiDist,
    skipUiBuild: opts.skipUiBuild,
  });
  process.stdout.write(`QA docker dir: ${result.outputDir}\n`);
  process.stdout.write(`QA Lab UI: ${result.qaLabUrl}\n`);
  process.stdout.write(`Gateway UI: ${result.gatewayUrl}\n`);
  process.stdout.write(`Stop: ${result.stopCommand}\n`);
}

export async function runQaMockOpenAiCommand(opts: { host?: string; port?: number }) {
  const server = await startQaMockOpenAiServer({
    host: opts.host,
    port: Number.isFinite(opts.port) ? opts.port : undefined,
  });
  await runInterruptibleServer("QA mock OpenAI", server);
}
