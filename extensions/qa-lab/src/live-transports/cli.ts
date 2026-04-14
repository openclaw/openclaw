import { isMatrixQaCliAvailable, registerMatrixQaCli } from "openclaw/plugin-sdk/qa-matrix";
import type { LiveTransportQaCliRegistration } from "./shared/live-transport-cli.js";
import { telegramQaCliRegistration } from "./telegram/cli.js";

function createUnavailableMatrixQaCliRegistration(): LiveTransportQaCliRegistration {
  return {
    commandName: "matrix",
    register(qa) {
      qa.command("matrix")
        .description("Run the Matrix live QA lane (install @openclaw/qa-matrix first)")
        .action(() => {
          throw new Error(
            'Matrix QA runner not installed. Install it with "openclaw plugins install @openclaw/qa-matrix".',
          );
        });
    },
  };
}

export const LIVE_TRANSPORT_QA_CLI_REGISTRATIONS: readonly LiveTransportQaCliRegistration[] = [
  telegramQaCliRegistration,
];

export function listLiveTransportQaCliRegistrations(): readonly LiveTransportQaCliRegistration[] {
  return [
    ...LIVE_TRANSPORT_QA_CLI_REGISTRATIONS,
    isMatrixQaCliAvailable()
      ? {
          commandName: "matrix",
          register: registerMatrixQaCli,
        }
      : createUnavailableMatrixQaCliRegistration(),
  ];
}
