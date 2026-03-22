import { describe, expect, it, vi } from "vitest";
import { listNativeCommandSpecs } from "../../../../src/auto-reply/commands-registry.js";
import type { OpenClawConfig, loadConfig } from "../../../../src/config/config.js";
import { createDiscordNativeCommand } from "./native-command.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

function createNativeCommand(name: string): ReturnType<typeof createDiscordNativeCommand> {
  const command = listNativeCommandSpecs({ provider: "discord" }).find(
    (entry) => entry.name === name,
  );
  if (!command) {
    throw new Error(`missing native command: ${name}`);
  }
  const cfg = {} as ReturnType<typeof loadConfig>;
  const discordConfig = {} as NonNullable<OpenClawConfig["channels"]>["discord"];
  return createDiscordNativeCommand({
    command,
    cfg,
    discordConfig,
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
  });
}

type CommandOption = NonNullable<ReturnType<typeof createDiscordNativeCommand>["options"]>[number];

function findOption(
  command: ReturnType<typeof createDiscordNativeCommand>,
  name: string,
): CommandOption | undefined {
  return command.options?.find((entry) => entry.name === name);
}

function requireOption(
  command: ReturnType<typeof createDiscordNativeCommand>,
  name: string,
): CommandOption {
  const option = findOption(command, name);
  if (!option) {
    throw new Error(`missing command option: ${name}`);
  }
  return option;
}

function readAutocomplete(option: CommandOption | undefined): unknown {
  if (!option || typeof option !== "object") {
    return undefined;
  }
  return (option as { autocomplete?: unknown }).autocomplete;
}

function readChoices(option: CommandOption | undefined): unknown[] | undefined {
  if (!option || typeof option !== "object") {
    return undefined;
  }
  const value = (option as { choices?: unknown }).choices;
  return Array.isArray(value) ? value : undefined;
}

describe("createDiscordNativeCommand option wiring", () => {
  it("uses autocomplete for /acp action so inline action values are accepted", async () => {
    const command = createNativeCommand("acp");
    const action = requireOption(command, "action");
    const autocomplete = readAutocomplete(action);
    if (typeof autocomplete !== "function") {
      throw new Error("acp action option did not wire autocomplete");
    }
    const respond = vi.fn(async (_choices: unknown[]) => undefined);

    expect(readChoices(action)).toBeUndefined();
    await autocomplete({
      options: {
        getFocused: () => ({ value: "st" }),
      },
      respond,
    } as never);
    expect(respond).toHaveBeenCalledWith([
      { name: "steer", value: "steer" },
      { name: "status", value: "status" },
      { name: "install", value: "install" },
    ]);
  });

  it("keeps static choices for non-acp string action arguments", () => {
    const command = createNativeCommand("voice");
    const action = requireOption(command, "action");
    const choices = readChoices(action);

    expect(readAutocomplete(action)).toBeUndefined();
    expect(choices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: expect.any(String), value: expect.any(String) }),
      ]),
    );
  });
});
