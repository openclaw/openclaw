import { ChannelType } from "discord-api-types/v10";
import type { OpenClawConfig, loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { logVerboseMock } = vi.hoisted(() => ({
  logVerboseMock: vi.fn(),
}));
const { loggerWarnMock } = vi.hoisted(() => ({
  loggerWarnMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    createSubsystemLogger: () => ({
      child: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      warn: loggerWarnMock,
      debug: vi.fn(),
    }),
    logVerbose: logVerboseMock,
  };
});

let listNativeCommandSpecs: typeof import("openclaw/plugin-sdk/command-auth").listNativeCommandSpecs;
let createDiscordNativeCommand: typeof import("./native-command.js").createDiscordNativeCommand;
let createNoopThreadBindingManager: typeof import("./thread-bindings.js").createNoopThreadBindingManager;

function createNativeCommand(
  name: string,
  opts?: {
    cfg?: ReturnType<typeof loadConfig>;
    discordConfig?: NonNullable<OpenClawConfig["channels"]>["discord"];
  },
): ReturnType<typeof import("./native-command.js").createDiscordNativeCommand> {
  const command = listNativeCommandSpecs({ provider: "discord" }).find(
    (entry) => entry.name === name,
  );
  if (!command) {
    throw new Error(`missing native command: ${name}`);
  }
  const cfg = (opts?.cfg ?? {}) as ReturnType<typeof loadConfig>;
  const discordConfig = (opts?.discordConfig ?? cfg.channels?.discord ?? {}) as NonNullable<
    OpenClawConfig["channels"]
  >["discord"];
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

type CommandOption = NonNullable<
  ReturnType<typeof import("./native-command.js").createDiscordNativeCommand>["options"]
>[number];

function findOption(
  command: ReturnType<typeof import("./native-command.js").createDiscordNativeCommand>,
  name: string,
): CommandOption | undefined {
  return command.options?.find((entry) => entry.name === name);
}

function requireOption(
  command: ReturnType<typeof import("./native-command.js").createDiscordNativeCommand>,
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
  beforeAll(async () => {
    ({ listNativeCommandSpecs } = await import("openclaw/plugin-sdk/command-auth"));
    ({ createDiscordNativeCommand } = await import("./native-command.js"));
    ({ createNoopThreadBindingManager } = await import("./thread-bindings.js"));
  });

  beforeEach(() => {
    logVerboseMock.mockReset();
    loggerWarnMock.mockReset();
  });

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
      user: {
        id: "owner",
        username: "tester",
        globalName: "Tester",
      },
      channel: {
        type: ChannelType.DM,
        id: "dm-1",
      },
      guild: undefined,
      rawData: {},
      options: {
        getFocused: () => ({ value: "st" }),
      },
      respond,
      client: {},
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

  it("returns no autocomplete choices for unauthorized users", async () => {
    const command = createNativeCommand("think", {
      cfg: {
        commands: {
          allowFrom: {
            discord: ["user:allowed-user"],
          },
        },
      } as ReturnType<typeof loadConfig>,
    });
    const level = requireOption(command, "level");
    const autocomplete = readAutocomplete(level);
    if (typeof autocomplete !== "function") {
      throw new Error("think level option did not wire autocomplete");
    }
    const respond = vi.fn(async (_choices: unknown[]) => undefined);

    await autocomplete({
      user: {
        id: "blocked-user",
        username: "blocked",
        globalName: "Blocked",
      },
      channel: {
        type: ChannelType.GuildText,
        id: "channel-1",
        name: "general",
      },
      guild: {
        id: "guild-1",
      },
      rawData: {
        member: { roles: [] },
      },
      options: {
        getFocused: () => ({ value: "xh" }),
      },
      respond,
      client: {},
    } as never);

    expect(respond).toHaveBeenCalledWith([]);
  });

  it("returns no autocomplete choices for group DMs outside dm.groupChannels", async () => {
    const command = createNativeCommand("think", {
      cfg: {
        channels: {
          discord: {
            dm: {
              enabled: true,
              policy: "open",
              groupEnabled: true,
              groupChannels: ["allowed-group"],
            },
          },
        },
      } as ReturnType<typeof loadConfig>,
    });
    const level = requireOption(command, "level");
    const autocomplete = readAutocomplete(level);
    if (typeof autocomplete !== "function") {
      throw new Error("think level option did not wire autocomplete");
    }
    const respond = vi.fn(async (_choices: unknown[]) => undefined);

    await autocomplete({
      user: {
        id: "allowed-user",
        username: "allowed",
        globalName: "Allowed",
      },
      channel: {
        type: ChannelType.GroupDM,
        id: "blocked-group",
        name: "Blocked Group",
      },
      guild: undefined,
      rawData: {
        member: { roles: [] },
      },
      options: {
        getFocused: () => ({ value: "xh" }),
      },
      respond,
      client: {},
    } as never);

    expect(respond).toHaveBeenCalledWith([]);
  });

  it("truncates Discord command and option descriptions to Discord's limit", () => {
    const longDescription = "x".repeat(140);
    const cfg = {} as ReturnType<typeof loadConfig>;
    const discordConfig = {} as NonNullable<OpenClawConfig["channels"]>["discord"];
    const command = createDiscordNativeCommand({
      command: {
        name: "longdesc",
        description: longDescription,
        acceptsArgs: true,
        args: [
          {
            name: "input",
            description: longDescription,
            type: "string",
            required: false,
          },
        ],
      },
      cfg,
      discordConfig,
      accountId: "default",
      sessionPrefix: "discord:slash",
      ephemeralDefault: true,
      threadBindings: createNoopThreadBindingManager("default"),
    });

    expect(command.description).toHaveLength(100);
    expect(command.description).toBe("x".repeat(100));
    expect(requireOption(command, "input").description).toHaveLength(100);
    expect(requireOption(command, "input").description).toBe("x".repeat(100));
  });
});
