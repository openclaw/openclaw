import { describe, expect, it, vi } from "vitest";
import { createDiscordVoiceCommand } from "./command.js";
function findVoiceSubcommand(command, name) {
  const subcommands = command.subcommands;
  const subcommand = subcommands?.find((entry) => entry.name === name);
  if (!subcommand) {
    throw new Error(`Missing vc ${name} subcommand`);
  }
  return subcommand;
}
function createVoiceCommandHarness(manager = null) {
  const command = createDiscordVoiceCommand({
    cfg: {},
    discordConfig: {},
    accountId: "default",
    groupPolicy: "open",
    useAccessGroups: false,
    getManager: () => manager,
    ephemeralDefault: true
  });
  return {
    command,
    leave: findVoiceSubcommand(command, "leave"),
    status: findVoiceSubcommand(command, "status")
  };
}
function createInteraction(overrides) {
  const reply = vi.fn(async () => void 0);
  const interaction = {
    guild: void 0,
    user: { id: "u1", username: "tester" },
    rawData: { member: { roles: [] } },
    reply,
    ...overrides
  };
  return { interaction, reply };
}
describe("createDiscordVoiceCommand", () => {
  it("vc leave reports missing guild before manager lookup", async () => {
    const { leave } = createVoiceCommandHarness(null);
    const { interaction, reply } = createInteraction();
    await leave.run(interaction);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      content: "Unable to resolve guild for this command.",
      ephemeral: true
    });
  });
  it("vc status reports unavailable voice manager", async () => {
    const { status } = createVoiceCommandHarness(null);
    const { interaction, reply } = createInteraction({
      guild: { id: "g1" }
    });
    await status.run(interaction);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      content: "Voice manager is not available yet.",
      ephemeral: true
    });
  });
  it("vc status reports no active sessions when manager has none", async () => {
    const statusSpy = vi.fn(() => []);
    const manager = {
      status: statusSpy
    };
    const { status } = createVoiceCommandHarness(manager);
    const { interaction, reply } = createInteraction({
      guild: { id: "g1", name: "Guild" }
    });
    await status.run(interaction);
    expect(statusSpy).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      content: "No active voice sessions.",
      ephemeral: true
    });
  });
});
