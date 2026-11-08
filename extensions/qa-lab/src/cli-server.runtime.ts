import path from "node:path";
import { startQaLabServer } from "./lab-server.js";
import { getQaProvider } from "./providers/index.js";
import { startQaProviderServer } from "./providers/server-runtime.js";
import type { QaProviderMode } from "./run-config.js";

type InterruptibleServer = {
  baseUrl: string;
  stop(): Promise<void>;
};

async function runInterruptibleServer(label: string, server: InterruptibleServer) {
  process.stdout.write(`${label}: ${server.baseUrl}\n`);
  process.stdout.write("Press Ctrl+C to stop.\n");

  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const onSignal = () => {
      if (stopping) {
        return;
      }
      stopping = true;
      // Retain the handlers during teardown so a second signal cannot interrupt it.
      void Promise.resolve()
        .then(() => server.stop())
        .finally(() => {
          process.off("SIGINT", onSignal);
          process.off("SIGTERM", onSignal);
        })
        .then(resolve, reject);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

export async function runQaLabUiCommand(opts: {
  repoRoot?: string;
  host?: string;
  port?: number;
  advertiseHost?: string;
  advertisePort?: number;
  controlUiUrl?: string;
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
    controlUiProxyToken: process.env.OPENCLAW_QA_CONTROL_UI_PROXY_TOKEN,
    controlUiProxyTarget: opts.controlUiProxyTarget,
    uiDistDir: opts.uiDistDir,
    autoKickoffTarget: opts.autoKickoffTarget,
    embeddedGateway: opts.embeddedGateway,
    sendKickoffOnStart: opts.sendKickoffOnStart,
  });
  await runInterruptibleServer("QA Lab UI", server);
}

export async function runQaProviderServerCommand(
  providerMode: QaProviderMode,
  opts: { host?: string; port?: number },
) {
  const provider = getQaProvider(providerMode);
  const standaloneCommand = provider.standaloneCommand;
  if (!standaloneCommand) {
    throw new Error(`QA provider "${providerMode}" does not expose a standalone server command.`);
  }
  const server = await startQaProviderServer(providerMode, {
    host: opts.host,
    port: Number.isFinite(opts.port) ? opts.port : undefined,
  });
  if (!server) {
    throw new Error(`QA provider "${providerMode}" does not expose a standalone server command.`);
  }
  await runInterruptibleServer(standaloneCommand.serverLabel, server);
}
