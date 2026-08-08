import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import type { QaTransportNativeCommandInput } from "../../qa-transport.js";
import type { TelegramBotIdentity } from "./telegram-api.runtime.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;
type FlowPreparationInput = Parameters<NonNullable<AdapterDefinition["prepareFlow"]>>[0];

export type TelegramQaScenarioEnvironment = {
  accountId: string;
  createNativeCommandInput: (command: string) => QaTransportNativeCommandInput;
  driverIdentity: TelegramBotIdentity;
  groupId: string;
  scenario: { id: string; timeoutMs: number; title: string };
  sutIdentity: TelegramBotIdentity;
};

export function createTelegramQaScenarioEnvironment(params: {
  accountId: string;
  driverIdentity: TelegramBotIdentity;
  groupId: string;
  sutIdentity: TelegramBotIdentity;
}) {
  const prepareFlow = async (input: FlowPreparationInput) => ({
    telegramScenarioContext: {
      accountId: params.accountId,
      createNativeCommandInput: (command: string) => ({
        command,
        conversation: { id: params.groupId, kind: "group" },
        senderId: String(params.driverIdentity.id),
        senderName: params.driverIdentity.username,
      }),
      driverIdentity: params.driverIdentity,
      groupId: params.groupId,
      scenario: {
        id: input.scenarioId,
        timeoutMs: input.timeoutMs,
        title: input.scenarioTitle,
      },
      sutIdentity: params.sutIdentity,
    } satisfies TelegramQaScenarioEnvironment,
  });
  return { prepareFlow };
}
