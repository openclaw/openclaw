import path from "node:path";
import { runQaCharacterEval, type QaCharacterModelOptions } from "./character-eval.js";
import { buildQaDockerHarnessImage, writeQaDockerHarnessFiles } from "./docker-harness.js";
import { runQaDockerUp } from "./docker-up.runtime.js";
import { startQaLabServer } from "./lab-server.js";
import { runQaManualLane } from "./manual-lane.runtime.js";
import { startQaMockOpenAiServer } from "./mock-openai-server.js";
import { normalizeQaThinkingLevel, type QaThinkingLevel } from "./qa-gateway-config.js";
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

function parseQaThinkingLevel(
  label: string,
  value: string | undefined,
): QaThinkingLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = normalizeQaThinkingLevel(value);
  if (!normalized) {
    throw new Error(`${label} must be one of off, minimal, low, medium, high, xhigh, adaptive`);
  }
  return normalized;
}

function parseQaModelThinkingOverrides(entries: readonly string[] | undefined) {
  const overrides: Record<string, QaThinkingLevel> = {};
  for (const entry of entries ?? []) {
    const separatorIndex = entry.lastIndexOf("=");
    if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
      throw new Error(`--model-thinking must use provider/model=level, got "${entry}"`);
    }
    const model = entry.slice(0, separatorIndex).trim();
    const level = parseQaThinkingLevel("--model-thinking", entry.slice(separatorIndex + 1).trim());
    if (!model || !level) {
      throw new Error(`--model-thinking must use provider/model=level, got "${entry}"`);
    }
    overrides[model] = level;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function parseQaBooleanModelOption(label: string, value: string) {
  switch (value.trim().toLowerCase()) {
    case "1":
    case "on":
    case "true":
    case "yes":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new Error(`${label} fast must be one of true, false, on, off, yes, no, 1, 0`);
  }
}

function parseQaPositiveIntegerOption(label: string, value: number | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Math.floor(value);
}

function parseQaModelSpecs(label: string, entries: readonly string[] | undefined) {
  const models: string[] = [];
  const optionsByModel: Record<string, QaCharacterModelOptions> = {};

  for (const entry of entries ?? []) {
    const parts = entry.split(",").map((part) => part.trim());
    const model = parts[0];
    if (!model) {
      throw new Error(`${label} must start with provider/model, got "${entry}"`);
    }
    models.push(model);
    const options: QaCharacterModelOptions = {};
    for (const part of parts.slice(1)) {
      if (!part) {
        throw new Error(`${label} option cannot be empty in "${entry}"`);
      }
      if (part === "fast") {
        options.fastMode = true;
        continue;
      }
      if (part === "no-fast") {
        options.fastMode = false;
        continue;
      }
      const separatorIndex = part.indexOf("=");
      if (separatorIndex <= 0 || separatorIndex === part.length - 1) {
        throw new Error(
          `${label} options must be thinking=<level>, fast, no-fast, or fast=<boolean>, got "${part}"`,
        );
      }
      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      switch (key) {
        case "thinking": {
          const thinkingDefault = parseQaThinkingLevel(`${label} thinking`, value);
          if (!thinkingDefault) {
            throw new Error(
              `${label} thinking must be one of off, minimal, low, medium, high, xhigh, adaptive`,
            );
          }
          options.thinkingDefault = thinkingDefault;
          break;
        }
        case "fast":
          options.fastMode = parseQaBooleanModelOption(label, value);
          break;
        default:
          throw new Error(`${label} does not support option "${key}" in "${entry}"`);
      }
    }
    if (Object.keys(options).length > 0) {
      optionsByModel[model] = { ...optionsByModel[model], ...options };
    }
  }

  return {
    models,
    optionsByModel: Object.keys(optionsByModel).length > 0 ? optionsByModel : undefined,
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

export async function runQaCharacterEvalCommand(opts: {
  repoRoot?: string;
  outputDir?: string;
  model?: string[];
  scenario?: string;
  fast?: boolean;
  thinking?: string;
  modelThinking?: string[];
  judgeModel?: string[];
  judgeTimeoutMs?: number;
  concurrency?: number;
  judgeConcurrency?: number;
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const candidates = parseQaModelSpecs("--model", opts.model);
  const judges = parseQaModelSpecs("--judge-model", opts.judgeModel);
  const result = await runQaCharacterEval({
    repoRoot,
    outputDir: opts.outputDir ? path.resolve(repoRoot, opts.outputDir) : undefined,
    models: candidates.models,
    scenarioId: opts.scenario,
    candidateFastMode: opts.fast,
    candidateThinkingDefault: parseQaThinkingLevel("--thinking", opts.thinking),
    candidateThinkingByModel: parseQaModelThinkingOverrides(opts.modelThinking),
    candidateModelOptions: candidates.optionsByModel,
    judgeModels: judges.models.length > 0 ? judges.models : undefined,
    judgeModelOptions: judges.optionsByModel,
    judgeTimeoutMs: opts.judgeTimeoutMs,
    candidateConcurrency: parseQaPositiveIntegerOption("--concurrency", opts.concurrency),
    judgeConcurrency: parseQaPositiveIntegerOption("--judge-concurrency", opts.judgeConcurrency),
  });
  process.stdout.write(`QA character eval report: ${result.reportPath}\n`);
  process.stdout.write(`QA character eval summary: ${result.summaryPath}\n`);
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
