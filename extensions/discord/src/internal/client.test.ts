import { ComponentType, Routes } from "discord-api-types/v10";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { Client } from "./client.js";
import type { DiscordCommand } from "./commands.js";
import { parseCustomId } from "./components.base.js";
import { DiscordError } from "./rest.js";
import {
  attachRestMock,
  createInternalTestClient,
  createTestCommand,
  createTestHashStore,
} from "./test-builders.test-support.js";

type AnyListener = Client["listeners"][number];

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function deployFixture(
  commands: DiscordCommand[],
  existing: unknown[],
  overrides: Parameters<typeof attachRestMock>[1] = {},
) {
  const client = createInternalTestClient(commands);
  return { client, ...attachRestMock(client, { get: vi.fn(async () => existing), ...overrides }) };
}

function expectNoWrites(...methods: ReturnType<typeof vi.fn>[]) {
  for (const method of methods) {
    expect(method).not.toHaveBeenCalled();
  }
}

function existingCommand(command: DiscordCommand, id: string) {
  return { ...command.serialize(), id, application_id: "app1" };
}

function wildcardParser(customId: string) {
  return (id: string) =>
    id === customId || id.startsWith("occomp:") ? { key: "*", data: {} } : parseCustomId(id);
}

describe("Client component handlers", () => {
  it("preserves digit-only custom id values as strings", () => {
    const parsed = parseCustomId("agent:user=123456789012345678;count=42;enabled=true");

    expect(parsed.data).toEqual({ user: "123456789012345678", count: "42", enabled: true });
  });

  it("resolves wildcard parser entries by component type", () => {
    const registry = createInternalTestClient().componentHandler;
    const components = [ComponentType.Button, ComponentType.StringSelect].map((type) => ({
      type,
      customId: `__wildcard_${type}__`,
      customIdParser: wildcardParser(`__wildcard_${type}__`),
      run() {},
    }));
    for (const component of components) {
      registry.register(component);
    }
    for (const component of components) {
      expect(registry.resolve("occomp:cid=one", { componentType: component.type })).toBe(component);
    }
  });
});

describe("Client.deployCommands", () => {
  // Discord's normalization must not trigger another PATCH on every startup (#76588).
  it.each(["null localization maps", "CJK description whitespace"] as const)(
    "does not redeploy Discord-normalized %s",
    async (normalization) => {
      const option = { type: 3 as const, name: "name", description: "Skill name" };
      const desiredOption =
        normalization === "null localization maps"
          ? option
          : {
              ...option,
              description_localizations: { "zh-CN": "技能名称。\n直接输入。" },
            };
      const currentFields =
        normalization === "null localization maps"
          ? {
              name_localizations: null,
              description_localizations: null,
            }
          : { description_localizations: { "zh-CN": "技能名称。直接输入。" } };
      const command = createTestCommand("ping", [desiredOption], { description: "ping the bot" });
      const current = {
        ...existingCommand(command, "cmd-1"),
        version: "v1",
        dm_permission: true,
        nsfw: false,
        ...(normalization === "null localization maps" ? currentFields : {}),
        options: [{ ...option, ...currentFields }],
      };
      const { client, ...rest } = deployFixture([command], [current]);
      await client.deployCommands();
      expect(rest.get).toHaveBeenCalledOnce();
      expectNoWrites(rest.post, rest.patch, rest.put, rest.delete);
    },
  );

  it.each([false, true])("patches changed localization only: %s", async (changed) => {
    const option = {
      type: 7 as const,
      name: "value",
      description: "Value",
      required: false,
      channel_types: [1, 0],
      name_localizations: { de: "wert" },
      description_localizations: { de: "Wert" },
    };
    const command = createTestCommand("one", [option]);
    const { client, ...rest } = deployFixture(
      [command],
      [
        {
          ...existingCommand(command, "cmd1"),
          options: [
            {
              ...option,
              required: undefined,
              description_localized: "Value",
              channel_types: [0, 1],
              name_localizations: { de: changed ? "alt" : "wert" },
              description_localizations: { de: changed ? "Alt" : "Wert" },
            },
          ],
          name_localized: "one",
          description_localized: "one command",
          default_member_permissions: null,
          dm_permission: true,
          integration_types: [1, 0],
          contexts: [2, 1, 0],
          guild_id: undefined,
          version: "1",
        },
      ],
    );
    await client.deployCommands();
    expectNoWrites(rest.post, rest.delete);
    if (!changed) {
      expectNoWrites(rest.patch);
    } else {
      expect(rest.patch).toHaveBeenCalledExactlyOnceWith(
        Routes.applicationCommand("app1", "cmd1"),
        {
          body: expect.objectContaining({ options: [option] }),
        },
      );
    }
  });

  it.each([false, true])("only bulk overwrites at the command cap: %s", async (atCap) => {
    const retained = createTestCommand("retained");
    const replacement = createTestCommand("replacement");
    const desired = [retained, replacement];
    const post = vi.fn(async () => {
      if (!atCap) {
        throw new Error("Discord unavailable");
      }
      throw new DiscordError(new Response(null, { status: 400 }), { code: 30032 });
    });
    const { client, ...rest } = deployFixture(
      desired,
      [
        existingCommand(retained, "retained-id"),
        existingCommand(createTestCommand("stale"), "stale-id"),
      ],
      { post },
    );
    if (!atCap) {
      await expect(client.deployCommands()).rejects.toThrow("Discord unavailable");
      expectNoWrites(rest.delete, rest.put);
      return;
    }
    await client.deployCommands();
    expect(rest.delete).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(Routes.applicationCommands("app1"), {
      body: replacement.serialize(),
    });
    expect(rest.put).toHaveBeenCalledExactlyOnceWith(Routes.applicationCommands("app1"), {
      body: desired.map((command) => command.serialize()),
    });
  });

  it("persists the hash after an obsolete command is already gone and reuses it on restart", async () => {
    const { store: commandDeployHashStore } = createTestHashStore();
    const deploy = async () => {
      const client = createInternalTestClient([createTestCommand("one")], {
        commandDeployHashStore,
      });
      const rest = attachRestMock(client, {
        get: vi.fn(async () => [existingCommand(createTestCommand("stale"), "stale-id")]),
        delete: vi.fn(async () => {
          throw new DiscordError(new Response(null, { status: 404 }), { code: 10063 });
        }),
      });
      await client.deployCommands();
      return rest;
    };
    const first = await deploy();
    const second = await deploy();
    expect(first.get).toHaveBeenCalledTimes(1);
    expect(first.post).toHaveBeenCalledTimes(1);
    expect(first.delete).toHaveBeenCalledOnce();
    expectNoWrites(second.get, second.post, second.delete);
  });

  it.each([true, false])(
    "recreates a changed command whose PATCH hits unknown command (gone: %s)",
    async (gone) => {
      const { store: commandDeployHashStore } = createTestHashStore();
      const changed = createTestCommand("changed", undefined, { description: "new text" });
      const deploy = async (patch: Mock) => {
        const client = createInternalTestClient([changed], { commandDeployHashStore });
        const rest = attachRestMock(client, {
          get: vi.fn(async () => [
            { ...existingCommand(changed, "changed-id"), description: "old text" },
            existingCommand(createTestCommand("stale"), "stale-id"),
          ]),
          patch,
        });
        await client.deployCommands();
        return rest;
      };
      const first = await deploy(
        vi.fn(async () => {
          if (gone) {
            throw new DiscordError(new Response(null, { status: 404 }), { code: 10063 });
          }
          return {};
        }),
      );
      expect(first.patch).toHaveBeenCalledExactlyOnceWith(
        Routes.applicationCommand("app1", "changed-id"),
        { body: changed.serialize() },
      );
      if (gone) {
        expect(first.post).toHaveBeenCalledExactlyOnceWith(Routes.applicationCommands("app1"), {
          body: changed.serialize(),
        });
      } else {
        expect(first.post).not.toHaveBeenCalled();
      }
      expect(first.delete).toHaveBeenCalledExactlyOnceWith(
        Routes.applicationCommand("app1", "stale-id"),
      );
      expect(first.put).not.toHaveBeenCalled();
      const second = await deploy(vi.fn());
      expectNoWrites(second.get, second.patch, second.post, second.delete);
    },
  );

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
    eventQueue: ConstructorParameters<typeof Client>[0]["eventQueue"] = { maxConcurrency: 1 },
  ): Client {
    return new Client({ clientId: "app1", token: "token", eventQueue }, { listeners });
  }

  it.each([29_999, 30_000])("orders listeners across clock changes (%dms)", async (elapsed) => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
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
    const client = createQueuedClient([first, second]);
    const dispatch = client.dispatchGatewayEvent("READY", {});
    await firstStarted.promise;
    expect(started).toEqual(["first"]);
    vi.advanceTimersByTime(elapsed);
    vi.setSystemTime(Date.now() + (elapsed < 30_000 ? 3_600_000 : -3_600_000));
    firstSettlement.resolve();
    await dispatch;
    expect(started).toEqual(["first", "second"]);
    expect(warning).toHaveBeenCalledTimes(elapsed < 30_000 ? 0 : 1);
  });

  it("logs a listener failure when its underlying promise rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("listener failure");
    const waiting = listener(async () => {
      throw failure;
    });
    const client = createQueuedClient([waiting]);

    const dispatch = client.dispatchGatewayEvent("READY", {});
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
    const client = createQueuedClient([waiting], { maxConcurrency: 1, maxQueueSize: 1 });

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
