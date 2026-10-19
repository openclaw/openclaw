/* oxlint-disable typescript/unbound-method -- vitest mocks of RequestClient methods (createRest) intentionally expose vi.fn refs via `restA.get`/`.post`; not unbound class methods. */
import type { APIApplicationCommand } from "discord-api-types/v10";
import { describe, expect, test, vi } from "vitest";
import type { DiscordCommandDeployHashStore } from "../command-deploy-store.js";
import { commandsEqual } from "./command-comparison.js";
import { DiscordCommandDeployer } from "./command-deploy.js";
import { Command } from "./commands.js";
import type { RequestClient } from "./rest.js";
import { attachRestMock, createInternalTestClient } from "./test-builders.test-support.js";

// Discord's normalization must not trigger another PATCH on every startup (#76588).
describe("commandsEqual", () => {
  const option = { type: 3 as const, name: "name", description: "Skill name" };
  const desired = {
    name: "ping",
    description: "ping the bot",
    type: 1,
    default_member_permissions: null,
    options: [option],
  };
  function currentFromDiscord(overrides: Partial<APIApplicationCommand>): APIApplicationCommand {
    return {
      ...desired,
      id: "cmd-1",
      application_id: "app",
      version: "v1",
      dm_permission: true,
      nsfw: false,
      ...overrides,
    } as APIApplicationCommand;
  }

  test("ignores Discord null localization maps when local command omits them", () => {
    const current = currentFromDiscord({
      name_localizations: null,
      description_localizations: null,
      options: [
        {
          ...option,
          name_localizations: null,
          description_localizations: null,
        },
      ],
    });
    expect(commandsEqual(current, desired)).toBe(true);
  });

  test("treats option localized descriptions with CJK whitespace as equal to Discord's collapsed form", () => {
    const current = currentFromDiscord({
      options: [{ ...option, description_localizations: { "zh-CN": "技能名称。直接输入。" } }],
    });
    const localized = {
      ...desired,
      options: [{ ...option, description_localizations: { "zh-CN": "技能名称。\n直接输入。" } }],
    };
    expect(commandsEqual(current, localized)).toBe(true);
  });
});
// #77359: identical command sets must not suppress another application’s deploy.
describe("DiscordCommandDeployer SQLite cache", () => {
  class StaticCommand extends Command {
    name = "ping";
    override description = "ping the bot";
    run() {}
  }

  function createRest(): RequestClient {
    const client = createInternalTestClient();
    attachRestMock(client, { get: vi.fn(async () => []) });
    return client.rest;
  }

  function deployer(
    rest: RequestClient,
    hashStore: DiscordCommandDeployHashStore,
    clientId = "app-default",
  ) {
    return new DiscordCommandDeployer({
      clientId,
      commands: [new StaticCommand()],
      hashStore,
      rest: () => rest,
    });
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
    const restA = createRest();
    const restB = createRest();

    await Promise.all([
      deployer(restA, store).deploy(),
      deployer(restB, store, "app-secondary").deploy(),
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

  test.each([
    { failure: "lookup", deployments: 1 },
    { failure: "register", deployments: 2 },
  ] as const)(
    "keeps deployments working after SQLite $failure fails",
    async ({ failure, deployments }) => {
      const store = {
        lookup: vi.fn(async () => undefined),
        register: vi.fn(async () => undefined),
      };
      store[failure].mockRejectedValue(new Error("database unavailable"));
      const rest = createRest();
      const cached = deployer(rest, store);
      for (let index = 0; index < deployments; index += 1) {
        await cached.deploy();
      }
      expect(rest.get).toHaveBeenCalledTimes(1);
      expect(rest.post).toHaveBeenCalledTimes(1);
      expect(store.register).toHaveBeenCalledOnce();
    },
  );
});
