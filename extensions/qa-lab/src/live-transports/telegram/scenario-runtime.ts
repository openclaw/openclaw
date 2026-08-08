import type { QaTransportAdapter } from "../../qa-transport.js";
import type { TelegramQaScenarioEnvironment } from "./scenario-environment.js";

type TelegramHelpCommandScenarioConfig = {
  command: string;
  expectedAny: string[];
};

function readTelegramHelpCommandScenarioConfig(
  value: Record<string, unknown>,
): TelegramHelpCommandScenarioConfig {
  const command = typeof value.command === "string" ? value.command.trim() : "";
  const expectedAny = Array.isArray(value.expectedAny)
    ? value.expectedAny.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
      )
    : [];
  if (!command || expectedAny.length === 0) {
    throw new Error("Telegram help scenario requires a command and expected response markers");
  }
  return { command, expectedAny };
}

export async function runTelegramHelpCommandScenario(
  context: TelegramQaScenarioEnvironment,
  transport: QaTransportAdapter,
  rawConfig: Record<string, unknown>,
) {
  const config = readTelegramHelpCommandScenarioConfig(rawConfig);
  if (!transport.sendNativeCommand) {
    throw new Error(`${transport.label} does not implement native Telegram commands`);
  }
  await transport.reset();
  const sinceIndex = transport.state
    .getSnapshot()
    .messages.filter((message) => message.direction === "outbound").length;
  await transport.sendNativeCommand(context.createNativeCommandInput(config.command));
  const reply = await transport.waitForOutbound({
    conversation: { id: context.groupId, kind: "group" },
    sinceIndex,
    textIncludes: config.expectedAny[0],
    timeoutMs: context.scenario.timeoutMs,
  });
  if (!config.expectedAny.every((needle) => reply.text.includes(needle))) {
    throw new Error(`Telegram help reply missing expected text: ${reply.text}`);
  }
  return { details: reply.text };
}
