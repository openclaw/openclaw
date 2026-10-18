// Discord tests cover command deploy plugin behavior.
/* oxlint-disable typescript/unbound-method -- vitest mocks of RequestClient methods (createRest) intentionally expose vi.fn refs via `restA.get`/`.post`; not unbound class methods. */
import type { APIApplicationCommand, APIApplicationCommandOption } from "discord-api-types/v10";
import { describe, expect, test, vi } from "vitest";
import type { DiscordCommandDeployHashStore } from "../command-deploy-store.js";
import { commandsEqual } from "./command-comparison.js";
import { DiscordCommandDeployer } from "./command-deploy.js";
import { BaseCommand } from "./commands.js";
import type { RequestClient } from "./rest.js";

// Discord's normalization must not trigger another PATCH on every startup (#76588).
describe("commandsEqual", () => {
  function currentFromDiscord(
    overrides: Partial<APIApplicationCommand> = {},
  ): APIApplicationCommand {
    return {
      id: "cmd-1",
      application_id: "app",
      type: 1,
      name: "ping",
      description: "ping the bot",
      version: "v1",
      default_member_permissions: null,
      dm_permission: true,
      nsfw: false,
      ...overrides,
    } as APIApplicationCommand;
  }

  function desiredFromLocal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: "ping",
      description: "ping the bot",
      type: 1,
      default_member_permissions: null,
      ...overrides,
    };
  }

  test("ignores Discord null localization maps when local command omits them", () => {
    const current = currentFromDiscord({
      name_localizations: null,
      description_localizations: null,
      options: [
        {
          type: 3,
          name: "name",
          name_localizations: null,
          description: "Skill name",
          description_localizations: null,
        } as APIApplicationCommandOption,
      ],
    });
    const desired = desiredFromLocal({
      options: [{ name: "name", description: "Skill name", type: 3 }],
    });
    expect(commandsEqual(current, desired)).toBe(true);
  });

  test("treats option localized descriptions with CJK whitespace as equal to Discord's collapsed form", () => {
    const current = currentFromDiscord({
      name: "skill",
      description: "Run a skill.",
      options: [
        {
          type: 3,
          name: "name",
          description: "Skill name",
          description_localizations: { "zh-CN": "技能名称。直接输入。" },
        } as APIApplicationCommandOption,
      ],
    });
    const desired = desiredFromLocal({
      name: "skill",
      description: "Run a skill.",
      options: [
        {
          name: "name",
          description: "Skill name",
          description_localizations: { "zh-CN": "技能名称。\n直接输入。" },
          type: 3,
        },
      ],
    });
    expect(commandsEqual(current, desired)).toBe(true);
  });
});
/**
 * Regression for #77359: persisted hashes are scoped by Discord application id.
 * Identical command sets for separate bots must never suppress each other's deploy.
 */
describe("DiscordCommandDeployer SQLite cache", () => {
  class StaticCommand extends BaseCommand {
    readonly commandKind = "leaf";
    name: string;
    override description = "ping the bot";

    constructor(name: string) {
      super();
      this.name = name;
    }

    serializeOptions() {
      return undefined;
    }
  }

  function createRest(): RequestClient {
    return {
      get: vi.fn(async () => []),
      post: vi.fn(async () => undefined),
      patch: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    } as unknown as RequestClient;
  }

  function createHashStore(): {
    rows: Map<string, string>;
    store: DiscordCommandDeployHashStore;
  } {
    const rows = new Map<string, string>();
    return {
      rows,
      store: {
        lookup: vi.fn(async (key: string) => rows.get(key)),
        register: vi.fn(async (key: string, value: string) => {
          rows.set(key, value);
        }),
      },
    };
  }

  test("two applications with identical command sets each reconcile their own application", async () => {
    const { store, rows } = createHashStore();
    const commands = [new StaticCommand("ping")];
    const restA = createRest();
    const restB = createRest();

    await Promise.all([
      new DiscordCommandDeployer({
        clientId: "app-default",
        commands,
        hashStore: store,
        rest: () => restA,
      }).deploy(),
      new DiscordCommandDeployer({
        clientId: "app-secondary",
        commands,
        hashStore: store,
        rest: () => restB,
      }).deploy(),
    ]);

    expect(restA.get).toHaveBeenCalledTimes(1);
    expect(restA.post).toHaveBeenCalledTimes(1);
    expect(restB.get).toHaveBeenCalledTimes(1);
    expect(restB.post).toHaveBeenCalledTimes(1);
    expect([...rows.keys()].toSorted()).toEqual([
      "app:app-default:global:reconcile",
      "app:app-secondary:global:reconcile",
    ]);
  });

  test("treats a SQLite lookup failure as a cache miss and repairs the row", async () => {
    const register = vi.fn(async () => undefined);
    const store: DiscordCommandDeployHashStore = {
      lookup: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
      register,
    };
    const rest = createRest();

    await new DiscordCommandDeployer({
      clientId: "app-default",
      commands: [new StaticCommand("ping")],
      hashStore: store,
      rest: () => rest,
    }).deploy();

    expect(rest.get).toHaveBeenCalledTimes(1);
    expect(rest.post).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledOnce();
  });

  test("keeps successful deploys successful when SQLite persistence fails", async () => {
    const store: DiscordCommandDeployHashStore = {
      lookup: vi.fn(async () => undefined),
      register: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    };
    const rest = createRest();
    const deployer = new DiscordCommandDeployer({
      clientId: "app-default",
      commands: [new StaticCommand("ping")],
      hashStore: store,
      rest: () => rest,
    });

    await deployer.deploy();
    await deployer.deploy();

    expect(rest.get).toHaveBeenCalledTimes(1);
    expect(rest.post).toHaveBeenCalledTimes(1);
    expect(store.register).toHaveBeenCalledOnce();
  });
});
