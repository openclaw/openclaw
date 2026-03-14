import { Routes } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import type { NativeCommandSpec } from "../../../../src/auto-reply/commands-registry.js";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import { buildDiscordVoiceCommandDeploymentDefinition } from "../voice/command.js";
import { __testing, reconcileDiscordNativeCommands } from "./native-command-state.js";

type FakeLiveCommand = {
  id: string;
  name: string;
  description: string;
  type: number;
  options?: Array<Record<string, unknown>>;
};

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
      cfg: {} as OpenClawConfig,
      runtime: { log: vi.fn() },
      accountId: "default",
      applicationId: "app-1",
      commandSpecs: [
        { name: "cmd", description: "built-in", acceptsArgs: false },
        { name: "cron_jobs", description: "plugin", acceptsArgs: false },
      ] satisfies NativeCommandSpec[],
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

  it("does nothing on restart when commands are unchanged", async () => {
    const { client, rest } = createClientHarness([
      {
        id: "cmd-1",
        name: "cmd",
        description: "built-in",
        type: 1,
      },
      {
        id: "cmd-2",
        name: "cron_jobs",
        description: "plugin",
        type: 1,
      },
    ]);

    const result = await reconcileDiscordNativeCommands({
      client,
      cfg: {} as OpenClawConfig,
      runtime: { log: vi.fn() },
      accountId: "default",
      applicationId: "app-1",
      commandSpecs: [
        { name: "cmd", description: "built-in", acceptsArgs: false },
        { name: "cron_jobs", description: "plugin", acceptsArgs: false },
      ] satisfies NativeCommandSpec[],
    });

    expect(result.summary).toEqual({
      validated: 2,
      unchanged: 2,
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

  it("updates changed commands, creates missing commands, and deletes removed commands without a bulk overwrite", async () => {
    const { client, rest, getLiveCommands } = createClientHarness([
      {
        id: "cmd-1",
        name: "cmd",
        description: "old description",
        type: 1,
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
      cfg: {} as OpenClawConfig,
      runtime: { log: vi.fn() },
      accountId: "default",
      applicationId: "app-1",
      commandSpecs: [
        { name: "cmd", description: "new description", acceptsArgs: false },
        { name: "new_cmd", description: "brand new", acceptsArgs: false },
      ] satisfies NativeCommandSpec[],
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
    const { client, rest, getLiveCommands } = createClientHarness([
      {
        id: "cmd-1",
        name: "cmd",
        description: "built-in",
        type: 1,
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
      cfg: {} as OpenClawConfig,
      runtime: { log: vi.fn() },
      accountId: "default",
      applicationId: "app-1",
      commandSpecs: [{ name: "cmd", description: "built-in", acceptsArgs: false }],
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
      cfg: {} as OpenClawConfig,
      runtime: { log: vi.fn() },
      accountId: "default",
      applicationId: "app-1",
      commandSpecs: [{ name: "cmd", description: "built-in", acceptsArgs: false }],
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
      cfg: {} as OpenClawConfig,
      runtime,
      accountId: "default",
      applicationId: "app-1",
      commandSpecs: [{ name: "cmd", description: "fresh", acceptsArgs: false }],
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
      expect.stringContaining("summary validated=1 unchanged=0 created=0 updated=1 deleted=1"),
    );
  });

  it("reconciles the vc subcommand command as a managed definition", async () => {
    const voiceDefinition = buildDiscordVoiceCommandDeploymentDefinition();
    const { client, rest } = createClientHarness([
      {
        id: "cmd-1",
        name: "vc",
        description: "Voice channel controls",
        type: 1,
        options: voiceDefinition.options as Array<Record<string, unknown>>,
      },
    ]);

    const result = await reconcileDiscordNativeCommands({
      client,
      cfg: {} as OpenClawConfig,
      runtime: { log: vi.fn() },
      accountId: "default",
      applicationId: "app-1",
      commandSpecs: [],
      extraDefinitions: [voiceDefinition],
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
      name: "status",
      description: "Show current status",
      type: 1,
    });

    expect(normalized?.name).toBe("status");
    expect(normalized?.signatureHash).toBe(
      __testing.hashDefinition({
        name: "status",
        description: "Show current status",
        type: 1,
      }),
    );
  });
});
