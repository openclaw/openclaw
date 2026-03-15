import { ChannelType, Routes } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import { buildDiscordVoiceCommandDeploymentDefinition } from "../voice/command.js";
import { __testing, reconcileDiscordNativeCommands } from "./native-command-state.js";
import { createDiscordNativeCommand } from "./native-command.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

type FakeLiveCommand = {
  id: string;
  name: string;
  description: string;
  type: number;
  dm_permission?: boolean;
  nsfw?: boolean;
  contexts?: number[];
  integration_types?: number[];
  default_member_permissions?: string | null;
  options?: Array<Record<string, unknown>>;
};

type FakeCommand = {
  name: string;
  serialize: () => Record<string, unknown>;
};

function createSerializedCommand(params: {
  name: string;
  description: string;
  options?: Array<Record<string, unknown>>;
}): FakeCommand {
  return {
    name: params.name,
    serialize: () => ({
      name: params.name,
      description: params.description,
      type: 1,
      integration_types: [0, 1],
      contexts: [0, 1, 2],
      default_member_permissions: null,
      ...(params.options ? { options: params.options } : {}),
    }),
  };
}

function createClientHarness(initialLiveCommands: FakeLiveCommand[] = []) {
  let nextId =
    initialLiveCommands
      .map((command) => Number(command.id.replace(/^cmd-/, "")))
      .filter((value) => Number.isFinite(value))
      .reduce((max, value) => Math.max(max, value), 0) + 1;
  const liveCommands = [...initialLiveCommands];
  const getApplicationCommandRoute = (route: string) => {
    const prefix = `${Routes.applicationCommands("app-1")}/`;
    if (!route.startsWith(prefix)) {
      throw new Error(`unexpected command route: ${route}`);
    }
    return route.slice(prefix.length);
  };
  const rest = {
    get: vi.fn(async (route: string) => {
      if (route === Routes.applicationCommands("app-1")) {
        return [...liveCommands];
      }
      throw new Error(`unexpected get route: ${route}`);
    }),
    put: vi.fn(async (_route: string, _params: { body: Array<Record<string, unknown>> }) => {
      throw new Error("unexpected bulk overwrite during reconcile");
    }),
    post: vi.fn(async (route: string, params: { body: Record<string, unknown> }) => {
      if (route !== Routes.applicationCommands("app-1")) {
        throw new Error(`unexpected post route: ${route}`);
      }
      const command = {
        id: `cmd-${nextId++}`,
        name: String(params.body.name),
        description: String(params.body.description ?? ""),
        type: Number(params.body.type ?? 1),
        contexts: Array.isArray(params.body.contexts)
          ? (params.body.contexts as number[])
          : undefined,
        integration_types: Array.isArray(params.body.integration_types)
          ? (params.body.integration_types as number[])
          : undefined,
        default_member_permissions:
          typeof params.body.default_member_permissions === "string" ||
          params.body.default_member_permissions === null
            ? (params.body.default_member_permissions as string | null)
            : undefined,
        options: Array.isArray(params.body.options)
          ? (params.body.options as Array<Record<string, unknown>>)
          : undefined,
      } satisfies FakeLiveCommand;
      liveCommands.push(command);
      return command;
    }),
    patch: vi.fn(async (route: string, params: { body: Record<string, unknown> }) => {
      const commandId = getApplicationCommandRoute(route);
      const existing = liveCommands.find((command) => command.id === commandId);
      if (!existing) {
        throw new Error(`missing command to patch: ${commandId}`);
      }
      existing.name = String(params.body.name ?? existing.name);
      existing.description = String(params.body.description ?? existing.description);
      existing.type = Number(params.body.type ?? existing.type);
      existing.contexts = Array.isArray(params.body.contexts)
        ? (params.body.contexts as number[])
        : undefined;
      existing.integration_types = Array.isArray(params.body.integration_types)
        ? (params.body.integration_types as number[])
        : undefined;
      existing.default_member_permissions =
        typeof params.body.default_member_permissions === "string" ||
        params.body.default_member_permissions === null
          ? (params.body.default_member_permissions as string | null)
          : undefined;
      existing.options = Array.isArray(params.body.options)
        ? (params.body.options as Array<Record<string, unknown>>)
        : undefined;
      return { ...existing };
    }),
    delete: vi.fn(async (route: string) => {
      const commandId = getApplicationCommandRoute(route);
      const index = liveCommands.findIndex((command) => command.id === commandId);
      if (index === -1) {
        throw new Error(`missing command to delete: ${commandId}`);
      }
      const [removed] = liveCommands.splice(index, 1);
      return removed;
    }),
  };
  return {
    client: { rest } as unknown as import("@buape/carbon").Client,
    rest,
    getLiveCommands: () => [...liveCommands],
  };
}

function createRealStatusCommand() {
  const cfg = {
    channels: {
      discord: {
        dm: { enabled: true, policy: "open" },
      },
    },
  } as OpenClawConfig;
  return createDiscordNativeCommand({
    command: {
      name: "status",
      description: "Status",
      acceptsArgs: false,
    },
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
  });
}

describe("reconcileDiscordNativeCommands", () => {
  it("creates missing commands and removes extra live commands on first reconcile", async () => {
    const { client, rest, getLiveCommands } = createClientHarness([
      {
        id: "cmd-9",
        name: "stale_cmd",
        description: "remove me",
        type: 1,
      },
    ]);

    const result = await reconcileDiscordNativeCommands({
      client,
      runtime: { log: vi.fn() },
      accountId: "default",
      applicationId: "app-1",
      commands: [
        createSerializedCommand({ name: "cmd", description: "built-in" }),
        createSerializedCommand({ name: "cron_jobs", description: "plugin" }),
      ] as never[],
    });

    expect(result.summary).toEqual({
      validated: 0,
      unchanged: 0,
      created: 2,
      updated: 0,
      deleted: 1,
      leftAlone: 0,
    });
    expect(rest.delete).toHaveBeenCalledTimes(1);
    expect(rest.post).toHaveBeenCalledTimes(2);
    expect(rest.patch).not.toHaveBeenCalled();
    expect(rest.put).not.toHaveBeenCalled();
    expect(
      getLiveCommands()
        .map((command) => command.name)
        .toSorted(),
    ).toEqual(["cmd", "cron_jobs"]);
  });

  it("does nothing on restart when a real serialized command is unchanged", async () => {
    const statusCommand = createRealStatusCommand();
    const serializedStatus = statusCommand.serialize() as unknown as Record<string, unknown>;
    const { client, rest } = createClientHarness([
      {
        id: "cmd-1",
        name: String(serializedStatus.name),
        description: String(serializedStatus.description ?? ""),
        type: Number(serializedStatus.type ?? 1),
        dm_permission: true,
        nsfw: false,
        contexts: serializedStatus.contexts as number[],
        integration_types: serializedStatus.integration_types as number[],
        default_member_permissions:
          (serializedStatus.default_member_permissions as string | null) ?? null,
      },
    ]);

    const result = await reconcileDiscordNativeCommands({
      client,
      runtime: { log: vi.fn() },
      accountId: "default",
      applicationId: "app-1",
      commands: [statusCommand],
    });

    expect(result.summary).toEqual({
      validated: 1,
      unchanged: 1,
      created: 0,
      updated: 0,
      deleted: 0,
      leftAlone: 0,
    });
    expect(rest.put).not.toHaveBeenCalled();
    expect(rest.post).not.toHaveBeenCalled();
    expect(rest.patch).not.toHaveBeenCalled();
    expect(rest.delete).not.toHaveBeenCalled();
  });

  it("treats omitted required:false option fields as unchanged", async () => {
    const { client, rest } = createClientHarness([
      {
        id: "cmd-1",
        name: "skill",
        description: "Run a skill",
        type: 1,
        contexts: [0, 1, 2],
        integration_types: [0, 1],
        default_member_permissions: null,
        options: [
          {
            description: "Skill name",
            name: "name",
            required: true,
            type: 3,
          },
          {
            description: "Skill input",
            name: "input",
            type: 3,
          },
        ],
      },
    ]);

    const result = await reconcileDiscordNativeCommands({
      client,
      runtime: { log: vi.fn() },
      accountId: "default",
      applicationId: "app-1",
      commands: [
        createSerializedCommand({
          name: "skill",
          description: "Run a skill",
          options: [
            {
              description: "Skill name",
              name: "name",
              required: true,
              type: 3,
            },
            {
              description: "Skill input",
              name: "input",
              required: false,
              type: 3,
            },
          ],
        }),
      ] as never[],
    });

    expect(result.summary).toEqual({
      validated: 1,
      unchanged: 1,
      created: 0,
      updated: 0,
      deleted: 0,
      leftAlone: 0,
    });
    expect(rest.post).not.toHaveBeenCalled();
    expect(rest.patch).not.toHaveBeenCalled();
    expect(rest.delete).not.toHaveBeenCalled();
  });

  it("updates changed commands, creates missing commands, and deletes removed commands without a bulk overwrite", async () => {
    const { client, rest, getLiveCommands } = createClientHarness([
      {
        id: "cmd-1",
        name: "cmd",
        description: "old description",
        type: 1,
        integration_types: [0, 1],
        contexts: [0, 1, 2],
        default_member_permissions: null,
      },
      {
        id: "cmd-2",
        name: "old_cmd",
        description: "remove me",
        type: 1,
      },
    ]);

    const result = await reconcileDiscordNativeCommands({
      client,
      runtime: { log: vi.fn() },
      accountId: "default",
      applicationId: "app-1",
      commands: [
        createSerializedCommand({ name: "cmd", description: "new description" }),
        createSerializedCommand({ name: "new_cmd", description: "brand new" }),
      ] as never[],
    });

    expect(result.summary).toEqual({
      validated: 1,
      unchanged: 0,
      created: 1,
      updated: 1,
      deleted: 1,
      leftAlone: 0,
    });
    expect(rest.put).not.toHaveBeenCalled();
    expect(rest.delete).toHaveBeenCalledTimes(1);
    expect(rest.patch).toHaveBeenCalledTimes(1);
    expect(rest.post).toHaveBeenCalledTimes(1);
    expect(
      getLiveCommands()
        .map((command) => `${command.name}:${command.description}`)
        .toSorted(),
    ).toEqual(["cmd:new description", "new_cmd:brand new"]);
  });

  it("recomputes from live state only when toggling reconcile off and back on", async () => {
    const statusCommand = createSerializedCommand({ name: "cmd", description: "built-in" });
    const serializedStatus = statusCommand.serialize();
    const { client, rest, getLiveCommands } = createClientHarness([
      {
        id: "cmd-1",
        name: String(serializedStatus.name),
        description: String(serializedStatus.description ?? ""),
        type: Number(serializedStatus.type ?? 1),
        integration_types: serializedStatus.integration_types as number[],
        contexts: serializedStatus.contexts as number[],
        default_member_permissions:
          (serializedStatus.default_member_permissions as string | null) ?? null,
      },
      {
        id: "cmd-2",
        name: "legacy_only",
        description: "old branch command",
        type: 1,
      },
    ]);

    const firstResult = await reconcileDiscordNativeCommands({
      client,
      runtime: { log: vi.fn() },
      accountId: "default",
      applicationId: "app-1",
      commands: [statusCommand] as never[],
    });
    expect(firstResult.summary).toEqual({
      validated: 1,
      unchanged: 1,
      created: 0,
      updated: 0,
      deleted: 1,
      leftAlone: 0,
    });

    rest.delete.mockClear();
    rest.patch.mockClear();
    rest.post.mockClear();

    const secondResult = await reconcileDiscordNativeCommands({
      client,
      runtime: { log: vi.fn() },
      accountId: "default",
      applicationId: "app-1",
      commands: [statusCommand] as never[],
    });

    expect(secondResult.summary).toEqual({
      validated: 1,
      unchanged: 1,
      created: 0,
      updated: 0,
      deleted: 0,
      leftAlone: 0,
    });
    expect(rest.delete).not.toHaveBeenCalled();
    expect(rest.patch).not.toHaveBeenCalled();
    expect(rest.post).not.toHaveBeenCalled();
    expect(getLiveCommands().map((command) => command.name)).toEqual(["cmd"]);
  });

  it("logs the names of extra and drifted commands it mutates", async () => {
    const runtime = { log: vi.fn() };
    const { client } = createClientHarness([
      {
        id: "cmd-1",
        name: "cmd",
        description: "stale",
        type: 1,
        integration_types: [0, 1],
        contexts: [0, 1, 2],
        default_member_permissions: null,
      },
      {
        id: "cmd-2",
        name: "extra_live",
        description: "delete me",
        type: 1,
      },
    ]);

    await reconcileDiscordNativeCommands({
      client,
      runtime,
      accountId: "default",
      applicationId: "app-1",
      commands: [createSerializedCommand({ name: "cmd", description: "fresh" })] as never[],
    });

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("loaded live=2 desired=1 matched=1 extra=1 missing=0 drifted=1"),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("deleting extra live commands: extra_live"),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("updating drifted commands: cmd"),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining('drift sample /cmd: description: live="stale" desired="fresh"'),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("summary validated=1 unchanged=0 created=0 updated=1 deleted=1"),
    );
  });

  it("reconciles the vc subcommand command as a managed definition", async () => {
    const voiceDefinition = buildDiscordVoiceCommandDeploymentDefinition();
    const desiredVoiceSerialized = {
      ...voiceDefinition,
      options: [
        {
          contexts: [0, 1, 2],
          default_member_permissions: null,
          description: "Join a voice channel",
          integration_types: [0, 1],
          name: "join",
          options: voiceDefinition.options?.[0]?.options,
          type: 1,
        },
        {
          contexts: [0, 1, 2],
          default_member_permissions: null,
          description: "Leave the current voice channel",
          integration_types: [0, 1],
          name: "leave",
          type: 1,
        },
        {
          contexts: [0, 1, 2],
          default_member_permissions: null,
          description: "Show active voice sessions",
          integration_types: [0, 1],
          name: "status",
          type: 1,
        },
      ],
    };
    const { client, rest } = createClientHarness([
      {
        id: "cmd-1",
        name: "vc",
        description: "Voice channel controls",
        type: 1,
        integration_types: [0, 1],
        contexts: [0, 1, 2],
        default_member_permissions: null,
        options: voiceDefinition.options as Array<Record<string, unknown>>,
      },
    ]);

    const result = await reconcileDiscordNativeCommands({
      client,
      runtime: { log: vi.fn() },
      accountId: "default",
      applicationId: "app-1",
      commands: [
        {
          name: "vc",
          serialize: () => desiredVoiceSerialized,
        },
      ] as never[],
    });

    expect(result.summary).toEqual({
      validated: 1,
      unchanged: 1,
      created: 0,
      updated: 0,
      deleted: 0,
      leftAlone: 0,
    });
    expect(rest.put).not.toHaveBeenCalled();
    expect(rest.post).not.toHaveBeenCalled();
    expect(rest.patch).not.toHaveBeenCalled();
    expect(rest.delete).not.toHaveBeenCalled();
  });

  it("normalizes live command signatures without requiring persisted command ids for routing metadata", () => {
    const normalized = __testing.normalizeLiveCommand({
      id: "cmd-1",
      application_id: "app-1",
      version: "123",
      dm_permission: true,
      name: "status",
      description: "Show current status",
      nsfw: false,
      type: 1,
      integration_types: [0, 1],
      contexts: [0, 1, 2],
      default_member_permissions: null,
    });

    expect(normalized?.name).toBe("status");
    expect(normalized?.signatureHash).toBe(
      __testing.hashDefinition({
        name: "status",
        description: "Show current status",
        type: 1,
        integration_types: [0, 1],
        contexts: [0, 1, 2],
        default_member_permissions: null,
      }),
    );
  });
});
