import { ApplicationCommandType, ComponentType, Routes } from "discord-api-types/v10";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "./client.js";
import { Command, type CommandOptions, type DiscordCommand } from "./commands.js";
import { ComponentRegistry } from "./component-registry.js";
import { parseCustomId, type BaseMessageInteractiveComponent } from "./components.base.js";
import { DiscordError } from "./rest.js";
import { attachRestMock, createInternalTestClient } from "./test-builders.test-support.js";

type AnyListener = Client["listeners"][number];

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function createTestCommand(name: string, options?: CommandOptions): DiscordCommand {
  return new (class extends Command {
    name = name;
    override description = `${name} command`;
    override options = options;
    run() {}
  })();
}

function liveCommand(options: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return {
    id: "cmd1",
    application_id: "app1",
    type: ApplicationCommandType.ChatInput,
    name: "one",
    description: "one command",
    options,
    ...extra,
  };
}

function existingCommand(command: DiscordCommand, id: string) {
  return { ...command.serialize(), id, application_id: "app1" };
}

function wildcardParser(customId: string) {
  return (id: string) =>
    id === customId || id.startsWith("occomp:") ? { key: "*", data: {} } : parseCustomId(id);
}

describe("ComponentRegistry", () => {
  it("preserves digit-only custom id values as strings", () => {
    const parsed = parseCustomId("agent:user=123456789012345678;count=42;enabled=true");

    expect(parsed.data).toEqual({ user: "123456789012345678", count: "42", enabled: true });
  });

  it("resolves wildcard parser entries by component type", () => {
    const registry = new ComponentRegistry<BaseMessageInteractiveComponent>();
    const button = {
      type: ComponentType.Button,
      customId: "__button_wildcard__",
      customIdParser: wildcardParser("__button_wildcard__"),
      run() {},
    };
    const select = {
      type: ComponentType.StringSelect,
      customId: "__select_wildcard__",
      customIdParser: wildcardParser("__select_wildcard__"),
      run() {},
    };

    registry.register(button);
    registry.register(select);

    expect(registry.resolve("occomp:cid=one", { componentType: ComponentType.Button })).toBe(
      button,
    );
    expect(registry.resolve("occomp:cid=one", { componentType: ComponentType.StringSelect })).toBe(
      select,
    );
  });
});

describe("Client.deployCommands", () => {
  it("does not patch live-only command metadata or reordered unordered arrays", async () => {
    const client = createInternalTestClient([
      createTestCommand("one", [
        {
          type: 7,
          name: "value",
          description: "Value",
          required: false,
          channel_types: [1, 0],
        },
      ]),
    ]);
    const get = vi.fn(async () => [
      liveCommand(
        [
          {
            type: 7,
            name: "value",
            description: "Value",
            description_localized: "Value",
            channel_types: [0, 1],
          },
        ],
        {
          name_localized: "one",
          description_localized: "one command",
          default_member_permissions: null,
          dm_permission: true,
          integration_types: [1, 0],
          contexts: [2, 1, 0],
          guild_id: undefined,
          version: "1",
        },
      ),
    ]);
    const { patch, post, delete: deleteRequest } = attachRestMock(client, { get });

    await client.deployCommands();

    expect(patch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(deleteRequest).not.toHaveBeenCalled();
  });

  it("bulk overwrites when a capped application cannot create a replacement", async () => {
    const retainedCommands = Array.from({ length: 99 }, (_, index) =>
      createTestCommand(`retained-${index}`),
    );
    const replacement = createTestCommand("replacement");
    const client = createInternalTestClient([...retainedCommands, replacement]);
    const existing = [
      ...retainedCommands.map((command, index) => existingCommand(command, `retained-id-${index}`)),
      existingCommand(createTestCommand("stale"), "stale-id"),
    ];
    const get = vi.fn(async () => existing);
    const post = vi.fn(async () => {
      throw new DiscordError(new Response(null, { status: 400 }), {
        message: "Maximum number of application commands reached (100).",
        code: 30032,
      });
    });
    const put = vi.fn(async () => undefined);
    const { delete: deleteRequest } = attachRestMock(client, { get, post, put });

    await client.deployCommands();

    expect(deleteRequest).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(Routes.applicationCommands("app1"), {
      body: replacement.serialize(),
    });
    expect(put).toHaveBeenCalledExactlyOnceWith(Routes.applicationCommands("app1"), {
      body: [...retainedCommands, replacement].map((command) => command.serialize()),
    });
  });

  it("keeps stale commands when a replacement create fails below the cap", async () => {
    const client = createInternalTestClient([createTestCommand("replacement")]);
    const get = vi.fn(async () => [existingCommand(createTestCommand("stale"), "stale-id")]);
    const post = vi.fn(async () => {
      throw new Error("Discord unavailable");
    });
    const { delete: deleteRequest } = attachRestMock(client, { get, post });

    await expect(client.deployCommands()).rejects.toThrow("Discord unavailable");

    expect(deleteRequest).not.toHaveBeenCalled();
  });

  it("patches changed option localization maps", async () => {
    const option = () => ({
      type: 3 as const,
      name: "value",
      description: "Value",
      name_localizations: { de: "wert" },
      description_localizations: { de: "Wert" },
    });
    const client = createInternalTestClient([createTestCommand("one", [option()])]);
    const get = vi.fn(async () => [
      liveCommand([
        {
          ...option(),
          name_localizations: { de: "alter-wert" },
          description_localizations: { de: "Alter Wert" },
        },
      ]),
    ]);
    const { patch, post, delete: deleteRequest } = attachRestMock(client, { get });

    await client.deployCommands();

    expect(patch).toHaveBeenCalledWith(Routes.applicationCommand("app1", "cmd1"), {
      body: {
        name: "one",
        description: "one command",
        type: ApplicationCommandType.ChatInput,
        options: [option()],
        integration_types: [0, 1],
        contexts: [0, 1, 2],
        default_member_permissions: null,
      },
    });
    expect(post).not.toHaveBeenCalled();
    expect(deleteRequest).not.toHaveBeenCalled();
  });

  it("skips unchanged command deploys across client restarts using the hash store", async () => {
    const hashes = new Map<string, string>();
    const commandDeployHashStore = {
      lookup: async (key: string) => hashes.get(key),
      register: async (key: string, value: string) => {
        hashes.set(key, value);
      },
    };
    const deploy = async () => {
      const client = createInternalTestClient([createTestCommand("one")], {
        commandDeployHashStore,
      });
      const rest = attachRestMock(client, { get: vi.fn(async () => []) });
      await client.deployCommands();
      return rest;
    };
    const first = await deploy();
    const second = await deploy();
    expect(first.get).toHaveBeenCalledTimes(1);
    expect(first.post).toHaveBeenCalledTimes(1);
    expect(second.get).not.toHaveBeenCalled();
    expect(second.post).not.toHaveBeenCalled();
  });

  it("caches REST object fetches briefly and invalidates from gateway updates", async () => {
    const client = createInternalTestClient();
    const get = vi.fn(async () => ({ id: "c1", type: 0, name: "general" }));
    attachRestMock(client, { get });

    await client.fetchChannel("c1");
    await client.fetchChannel("c1");
    expect(get).toHaveBeenCalledTimes(1);

    await client.dispatchGatewayEvent("CHANNEL_UPDATE", { id: "c1" });
    await client.fetchChannel("c1");
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("Client gateway event queue", () => {
  function listener(handle: () => Promise<void>) {
    return { type: "READY" as const, handle: vi.fn(handle) };
  }

  function createQueuedClient(
    listeners: AnyListener[],
    eventQueue: ConstructorParameters<typeof Client>[0]["eventQueue"],
  ): Client {
    return new Client({ clientId: "app1", token: "token", eventQueue }, { listeners });
  }

  it("holds a listener slot until its underlying promise resolves", async () => {
    const firstStarted = createDeferred<void>();
    const firstSettlement = createDeferred<void>();
    const started: string[] = [];
    const first = listener(async () => {
      started.push("first");
      firstStarted.resolve();
      await firstSettlement.promise;
    });
    const second = listener(async () => {
      started.push("second");
    });
    const client = createQueuedClient([first, second], { maxConcurrency: 1 });

    const dispatch = client.dispatchGatewayEvent("READY", {});
    await firstStarted.promise;

    expect(started).toEqual(["first"]);

    firstSettlement.resolve();
    await dispatch;
    expect(started).toEqual(["first", "second"]);
    expect(first.handle).toHaveBeenCalledTimes(1);
    expect(second.handle).toHaveBeenCalledTimes(1);
  });

  it("logs a listener failure when its underlying promise rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const settlement = createDeferred<void>();
    const failure = new Error("listener failure");
    const waiting = listener(async () => await settlement.promise);
    const client = createQueuedClient([waiting], { maxConcurrency: 1 });

    const dispatch = client.dispatchGatewayEvent("READY", {});
    settlement.reject(failure);
    await expect(dispatch).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
      "[EventQueue] Listener Object failed for event READY:",
      failure,
    );
  });

  it("rejects when queued listener work exceeds maxQueueSize", async () => {
    const releases: Array<() => void> = [];
    const waiting = listener(
      async () =>
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    const client = createQueuedClient([waiting], {
      maxConcurrency: 1,
      maxQueueSize: 1,
    });

    const first = client.dispatchGatewayEvent("READY", {});
    await vi.waitFor(() => expect(waiting.handle).toHaveBeenCalledTimes(1));
    const second = client.dispatchGatewayEvent("READY", {});

    await expect(client.dispatchGatewayEvent("READY", {})).rejects.toThrow(
      "Discord event queue is full for READY; maxQueueSize=1",
    );

    releases.shift()?.();
    await vi.waitFor(() => expect(waiting.handle).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });
});
