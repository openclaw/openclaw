import { listQaRunnerCliContributions } from "openclaw/plugin-sdk/qa-runner-runtime";
import type { LiveTransportQaCliRegistration } from "./shared/live-transport-cli.js";
import { telegramQaCliRegistration } from "./telegram/cli.js";

const OPTIONAL_QA_RUNNER_INSTALLS = [
  {
    commandName: "matrix",
    description: "Run the Matrix live QA lane (install @openclaw/qa-matrix first)",
    npmSpec: "@openclaw/qa-matrix",
  },
] as const;

function createMissingQaRunnerCliRegistration(params: {
  commandName: string;
  description: string;
  npmSpec: string;
}): LiveTransportQaCliRegistration {
  return {
    commandName: params.commandName,
    register(qa) {
      qa.command(params.commandName)
        .description(params.description)
        .action(() => {
          throw new Error(
            `QA runner "${params.commandName}" not installed. Install it with "openclaw plugins install ${params.npmSpec}".`,
          );
        });
    },
  };
}

function createBlockedQaRunnerCliRegistration(params: {
  commandName: string;
  description?: string;
  pluginId: string;
}): LiveTransportQaCliRegistration {
  return {
    commandName: params.commandName,
    register(qa) {
      qa.command(params.commandName)
        .description(params.description ?? `Run the ${params.commandName} live QA lane`)
        .action(() => {
          throw new Error(
            `QA runner "${params.commandName}" is installed but not active. Enable or allow plugin "${params.pluginId}" in your OpenClaw config, then try again.`,
          );
        });
    },
  };
}

export const LIVE_TRANSPORT_QA_CLI_REGISTRATIONS: readonly LiveTransportQaCliRegistration[] = [
  telegramQaCliRegistration,
];

export function listLiveTransportQaCliRegistrations(): readonly LiveTransportQaCliRegistration[] {
  const liveRegistrations = [...LIVE_TRANSPORT_QA_CLI_REGISTRATIONS];
  const discoveredRunners = listQaRunnerCliContributions();
  const seenCommandNames = new Set(liveRegistrations.map((registration) => registration.commandName));

  for (const runner of discoveredRunners) {
    seenCommandNames.add(runner.commandName);
    liveRegistrations.push(
      runner.status === "available"
        ? runner.registration
        : createBlockedQaRunnerCliRegistration({
            commandName: runner.commandName,
            description: runner.description,
            pluginId: runner.pluginId,
          }),
    );
  }

  for (const runner of OPTIONAL_QA_RUNNER_INSTALLS) {
    if (seenCommandNames.has(runner.commandName)) {
      continue;
    }
    liveRegistrations.push(createMissingQaRunnerCliRegistration(runner));
  }

  return liveRegistrations;
}
