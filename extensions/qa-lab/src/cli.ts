import type { Command } from "commander";

type QaLabCliRuntime = typeof import("./cli.runtime.js");

let qaLabCliRuntimePromise: Promise<QaLabCliRuntime> | null = null;

async function loadQaLabCliRuntime(): Promise<QaLabCliRuntime> {
  qaLabCliRuntimePromise ??= import("./cli.runtime.js");
  return await qaLabCliRuntimePromise;
}

async function runQaSelfCheck(opts: { output?: string }) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaLabSelfCheckCommand(opts);
}

async function runQaSuite(opts: {
  outputDir?: string;
  providerMode?: "mock-openai" | "live-openai";
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
}) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaSuiteCommand(opts);
}

async function runQaUi(opts: {
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
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaLabUiCommand(opts);
}

async function runQaDockerScaffold(opts: {
  outputDir: string;
  gatewayPort?: number;
  qaLabPort?: number;
  image?: string;
  usePrebuiltImage?: boolean;
}) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaDockerScaffoldCommand(opts);
}

async function runQaDockerBuildImage(opts: { image?: string }) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaDockerBuildImageCommand(opts);
}

async function runQaDockerUp(opts: {
  outputDir?: string;
  gatewayPort?: number;
  qaLabPort?: number;
  providerBaseUrl?: string;
  image?: string;
  usePrebuiltImage?: boolean;
  skipUiBuild?: boolean;
}) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaDockerUpCommand(opts);
}

async function runQaMockOpenAi(opts: { host?: string; port?: number }) {
  const runtime = await loadQaLabCliRuntime();
  await runtime.runQaMockOpenAiCommand(opts);
}

export function registerQaLabCli(program: Command) {
  const qa = program
    .command("qa")
    .description("Run private QA automation flows and launch the QA debugger");

  qa.command("run")
    .description("Run the bundled QA self-check and write a Markdown report")
    .option("--output <path>", "Report output path")
    .action(async (opts: { output?: string }) => {
      await runQaSelfCheck(opts);
    });

  qa.command("suite")
    .description("Run all repo-backed QA scenarios against the real QA gateway lane")
    .option("--output-dir <path>", "Suite artifact directory")
    .option("--provider-mode <mode>", "Provider mode: mock-openai or live-openai", "mock-openai")
    .option("--model <ref>", "Primary provider/model ref")
    .option("--alt-model <ref>", "Alternate provider/model ref")
    .option("--fast", "Enable provider fast mode where supported", false)
    .action(
      async (opts: {
        outputDir?: string;
        providerMode?: "mock-openai" | "live-openai";
        model?: string;
        altModel?: string;
        fast?: boolean;
      }) => {
        await runQaSuite({
          outputDir: opts.outputDir,
          providerMode: opts.providerMode,
          primaryModel: opts.model,
          alternateModel: opts.altModel,
          fastMode: opts.fast,
        });
      },
    );

  qa.command("ui")
    .description("Start the private QA debugger UI and local QA bus")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port", (value: string) => Number(value))
    .option("--advertise-host <host>", "Optional public host to advertise in bootstrap payloads")
    .option("--advertise-port <port>", "Optional public port to advertise", (value: string) =>
      Number(value),
    )
    .option("--control-ui-url <url>", "Optional Control UI URL to embed beside the QA panel")
    .option("--control-ui-token <token>", "Optional Control UI token for embedded links")
    .option(
      "--control-ui-proxy-target <url>",
      "Optional upstream Control UI target for /control-ui proxying",
    )
    .option("--auto-kickoff-target <kind>", "Kickoff default target (direct or channel)")
    .option("--embedded-gateway <mode>", "Embedded gateway mode hint", "enabled")
    .option(
      "--send-kickoff-on-start",
      "Inject the repo-backed kickoff task when the UI starts",
      false,
    )
    .action(
      async (opts: {
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
      }) => {
        await runQaUi(opts);
      },
    );

  qa.command("docker-scaffold")
    .description("Write a prebaked Docker scaffold for the QA dashboard + gateway lane")
    .requiredOption("--output-dir <path>", "Output directory for docker-compose + state files")
    .option("--gateway-port <port>", "Gateway host port", (value: string) => Number(value))
    .option("--qa-lab-port <port>", "QA lab host port", (value: string) => Number(value))
    .option("--provider-base-url <url>", "Provider base URL for the QA gateway")
    .option("--image <name>", "Prebaked image name", "openclaw:qa-local-prebaked")
    .option("--use-prebuilt-image", "Use image: instead of build: in docker-compose", false)
    .action(
      async (opts: {
        outputDir: string;
        gatewayPort?: number;
        qaLabPort?: number;
        providerBaseUrl?: string;
        image?: string;
        usePrebuiltImage?: boolean;
      }) => {
        await runQaDockerScaffold(opts);
      },
    );

  qa.command("docker-build-image")
    .description("Build the prebaked QA Docker image with qa-channel + qa-lab bundled")
    .option("--image <name>", "Image tag", "openclaw:qa-local-prebaked")
    .action(async (opts: { image?: string }) => {
      await runQaDockerBuildImage(opts);
    });

  qa.command("up")
    .description("Build the QA site, start the Docker-backed QA stack, and print the QA Lab URL")
    .option("--output-dir <path>", "Output directory for docker-compose + state files")
    .option("--gateway-port <port>", "Gateway host port", (value: string) => Number(value))
    .option("--qa-lab-port <port>", "QA lab host port", (value: string) => Number(value))
    .option("--provider-base-url <url>", "Provider base URL for the QA gateway")
    .option("--image <name>", "Image tag", "openclaw:qa-local-prebaked")
    .option("--use-prebuilt-image", "Use image: instead of build: in docker-compose", false)
    .option("--skip-ui-build", "Skip pnpm qa:lab:build before starting Docker", false)
    .action(
      async (opts: {
        outputDir?: string;
        gatewayPort?: number;
        qaLabPort?: number;
        providerBaseUrl?: string;
        image?: string;
        usePrebuiltImage?: boolean;
        skipUiBuild?: boolean;
      }) => {
        await runQaDockerUp(opts);
      },
    );

  qa.command("mock-openai")
    .description("Run the local mock OpenAI Responses API server for QA")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port", (value: string) => Number(value))
    .action(async (opts: { host?: string; port?: number }) => {
      await runQaMockOpenAi(opts);
    });
}
