import path from "node:path";
import { buildQaDockerHarnessImage, writeQaDockerHarnessFiles } from "./docker-harness.js";
import { runQaDockerUp } from "./docker-up.runtime.js";
import { startQaLabServer } from "./lab-server.js";
import { startQaMockOpenAiServer } from "./mock-openai-server.js";
import { runQaSuite } from "./suite.js";

export async function runQaLabSelfCheckCommand(opts: { output?: string }) {
  const server = await startQaLabServer({
    outputPath: opts.output,
  });
  try {
    const result = await server.runSelfCheck();
    process.stdout.write(`QA self-check report: ${result.outputPath}\n`);
  } finally {
    await server.stop();
  }
}

export async function runQaSuiteCommand(opts: {
  outputDir?: string;
  providerMode?: "mock-openai" | "live-openai";
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
}) {
  const result = await runQaSuite({
    outputDir: opts.outputDir ? path.resolve(opts.outputDir) : undefined,
    providerMode: opts.providerMode,
    primaryModel: opts.primaryModel,
    alternateModel: opts.alternateModel,
    fastMode: opts.fastMode,
  });
  process.stdout.write(`QA suite watch: ${result.watchUrl}\n`);
  process.stdout.write(`QA suite report: ${result.reportPath}\n`);
  process.stdout.write(`QA suite summary: ${result.summaryPath}\n`);
}

export async function runQaLabUiCommand(opts: {
  host?: string;
  port?: number;
  advertiseHost?: string;
  advertisePort?: number;
  controlUiUrl?: string;
  controlUiToken?: string;
  controlUiProxyTarget?: string;
  autoKickoffTarget?: string;
  embeddedGateway?: string;
  sendKickoffOnStart?: boolean;
}) {
  const server = await startQaLabServer({
    host: opts.host,
    port: Number.isFinite(opts.port) ? opts.port : undefined,
    advertiseHost: opts.advertiseHost,
    advertisePort: Number.isFinite(opts.advertisePort) ? opts.advertisePort : undefined,
    controlUiUrl: opts.controlUiUrl,
    controlUiToken: opts.controlUiToken,
    controlUiProxyTarget: opts.controlUiProxyTarget,
    autoKickoffTarget: opts.autoKickoffTarget,
    embeddedGateway: opts.embeddedGateway,
    sendKickoffOnStart: opts.sendKickoffOnStart,
  });
  process.stdout.write(`QA Lab UI: ${server.baseUrl}\n`);
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

export async function runQaDockerScaffoldCommand(opts: {
  outputDir: string;
  gatewayPort?: number;
  qaLabPort?: number;
  providerBaseUrl?: string;
  image?: string;
  usePrebuiltImage?: boolean;
}) {
  const outputDir = path.resolve(opts.outputDir);
  const result = await writeQaDockerHarnessFiles({
    outputDir,
    repoRoot: process.cwd(),
    gatewayPort: Number.isFinite(opts.gatewayPort) ? opts.gatewayPort : undefined,
    qaLabPort: Number.isFinite(opts.qaLabPort) ? opts.qaLabPort : undefined,
    providerBaseUrl: opts.providerBaseUrl,
    imageName: opts.image,
    usePrebuiltImage: opts.usePrebuiltImage,
  });
  process.stdout.write(`QA docker scaffold: ${result.outputDir}\n`);
}

export async function runQaDockerBuildImageCommand(opts: { image?: string }) {
  const result = await buildQaDockerHarnessImage({
    repoRoot: process.cwd(),
    imageName: opts.image,
  });
  process.stdout.write(`QA docker image: ${result.imageName}\n`);
}

export async function runQaDockerUpCommand(opts: {
  outputDir?: string;
  gatewayPort?: number;
  qaLabPort?: number;
  providerBaseUrl?: string;
  image?: string;
  usePrebuiltImage?: boolean;
  skipUiBuild?: boolean;
}) {
  const result = await runQaDockerUp({
    repoRoot: process.cwd(),
    outputDir: opts.outputDir ? path.resolve(opts.outputDir) : undefined,
    gatewayPort: Number.isFinite(opts.gatewayPort) ? opts.gatewayPort : undefined,
    qaLabPort: Number.isFinite(opts.qaLabPort) ? opts.qaLabPort : undefined,
    providerBaseUrl: opts.providerBaseUrl,
    image: opts.image,
    usePrebuiltImage: opts.usePrebuiltImage,
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
  process.stdout.write(`QA mock OpenAI: ${server.baseUrl}\n`);
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
