import { describe, expect, it } from "vitest";
import { listNativeCommandSpecs } from "../../../../src/auto-reply/commands-registry.js";
import { createDiscordNativeCommand } from "./native-command.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";
function createNativeCommand(name) {
  const command = listNativeCommandSpecs({ provider: "discord" }).find(
    (entry) => entry.name === name
  );
  if (!command) {
    throw new Error(`missing native command: ${name}`);
  }
  const cfg = {};
  const discordConfig = {};
  return createDiscordNativeCommand({
    command,
    cfg,
    discordConfig,
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default")
  });
}
function findOption(command, name) {
  return command.options?.find((entry) => entry.name === name);
}
function readAutocomplete(option) {
  if (!option || typeof option !== "object") {
    return void 0;
  }
  return option.autocomplete;
}
function readChoices(option) {
  if (!option || typeof option !== "object") {
    return void 0;
  }
  const value = option.choices;
  return Array.isArray(value) ? value : void 0;
}
describe("createDiscordNativeCommand option wiring", () => {
  it("uses autocomplete for /acp action so inline action values are accepted", () => {
    const command = createNativeCommand("acp");
    const action = findOption(command, "action");
    expect(action).toBeDefined();
    expect(typeof readAutocomplete(action)).toBe("function");
    expect(readChoices(action)).toBeUndefined();
  });
  it("keeps static choices for non-acp string action arguments", () => {
    const command = createNativeCommand("voice");
    const action = findOption(command, "action");
    expect(action).toBeDefined();
    expect(readAutocomplete(action)).toBeUndefined();
    expect(readChoices(action)?.length).toBeGreaterThan(0);
  });
});
