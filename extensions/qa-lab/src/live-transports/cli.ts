import { listQaRunnerCliContributions } from "openclaw/plugin-sdk/qa-runner-runtime";
import { discordQaCliRegistration } from "./discord/cli.js";
import { matrixQaCliRegistration } from "./matrix/cli.js";
import type { LiveTransportQaCliRegistration } from "./shared/live-transport-cli.js";
import { slackQaCliRegistration } from "./slack/cli.js";
import { telegramQaCliRegistration } from "./telegram/cli.js";
import { whatsappQaCliRegistration } from "./whatsapp/cli.js";

function createQaRunnerCliRegistration(
  runner: ReturnType<typeof listQaRunnerCliContributions>[number],
): LiveTransportQaCliRegistration {
  if (runner.status === "available") {
    return runner.registration;
  }
  return {
    commandName: runner.commandName,
    register(qa) {
      qa.command(runner.commandName)
        .description(runner.description ?? `Run the ${runner.commandName} live QA lane`)
        .action(() => {
          throw new Error(
            `QA runner "${runner.commandName}" is installed but not active. Enable or allow plugin "${runner.pluginId}" in your OpenClaw config, then try again.`,
          );
        });
    },
  };
}

const LIVE_TRANSPORT_QA_CLI_REGISTRATIONS: readonly LiveTransportQaCliRegistration[] = [
  telegramQaCliRegistration,
  discordQaCliRegistration,
  matrixQaCliRegistration,
  slackQaCliRegistration,
  whatsappQaCliRegistration,
];

export function listLiveTransportQaCliRegistrations(): readonly LiveTransportQaCliRegistration[] {
  const liveRegistrations = [...LIVE_TRANSPORT_QA_CLI_REGISTRATIONS];
  const discoveredRunners = listQaRunnerCliContributions();

  for (const runner of discoveredRunners) {
    liveRegistrations.push(createQaRunnerCliRegistration(runner));
  }

  return liveRegistrations;
}

export function listLiveTransportQaAdapterFactories() {
  return listLiveTransportQaCliRegistrations().flatMap((registration) =>
    registration.adapterFactory ? [registration.adapterFactory] : [],
  );
}
