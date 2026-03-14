import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Routes } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

function buildEnv(stateDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
  };
}

function createClientHarness(initialLiveCommands: FakeLiveCommand[] = []) {
  let nextId = 1;
  const liveCommands = [...initialLiveCommands];
  const rest = {
    get: vi.fn(async (route: string) => {
      if (route === Routes.applicationCommands("app-1")) {
        return [...liveCommands];
      }
      throw new Error(`unexpected get route: ${route}`);
    }),
    post: vi.fn(async (route: string, params: { body: Record<string, unknown> }) => {
      if (route !== Routes.applicationCommands("app-1")) {
        throw new Error(`unexpected post route: ${route}`);
      }
      const created: FakeLiveCommand = {
        id: `cmd-${nextId++}`,
        name: String(params.body.name),
        description: String(params.body.description),
        type: Number(params.body.type ?? 1),
        options: Array.isArray(params.body.options)
          ? (params.body.options as Array<Record<string, unknown>>)
          : undefined,
      };
      liveCommands.push(created);
      return created;
    }),
    patch: vi.fn(async (route: string, params: { body: Record<string, unknown> }) => {
      const prefix = Routes.applicationCommand("app-1", "");
      if (!route.startsWith(prefix)) {
        throw new Error(`unexpected patch route: ${route}`);
      }
      const id = route.slice(prefix.length);
      const existing = liveCommands.find((command) => command.id === id);
      if (!existing) {
        throw new Error(`missing command for patch: ${id}`);
      }
      existing.name = String(params.body.name);
      existing.description = String(params.body.description);
      existing.type = Number(params.body.type ?? 1);
      existing.options = Array.isArray(params.body.options)
        ? (params.body.options as Array<Record<string, unknown>>)
        : undefined;
      return { ...existing };
    }),
    delete: vi.fn(async (route: string) => {
      const prefix = Routes.applicationCommand("app-1", "");
      if (!route.startsWith(prefix)) {
        throw new Error(`unexpected delete route: ${route}`);
      }
      const id = route.slice(prefix.length);
      const index = liveCommands.findIndex((command) => command.id === id);
      if (index >= 0) {
        liveCommands.splice(index, 1);
      }
      return undefined;
    }),
  };
  return {
    client: { rest } as unknown as import("@buape/carbon").Client,
    rest,
    getLiveCommands: () => [...liveCommands],
  };
}

describe("reconcileDiscordNativeCommands", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-commands-"));
  });

  it("creates commands and writes state on first reconcile", async () => {
    const { client, rest } = createClientHarness();
    const env = buildEnv(stateDir);
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
      env,
    });

    expect(result.summary).toEqual({
      validated: 0,
      unchanged: 0,
      created: 2,
      updated: 0,
      deleted: 0,
      leftAlone: 0,
    });
    expect(rest.post).toHaveBeenCalledTimes(2);
    const savedRaw = await fs.readFile(
      __testing.resolveStatePath({ accountId: "default", env }),
      "utf8",
    );
    const saved = JSON.parse(savedRaw) as {
      commands: Array<{ name: string; id: string }>;
    };
    expect(saved.commands).toHaveLength(2);
    expect(saved.commands.map((command) => command.name)).toEqual(["cmd", "cron_jobs"]);
  });

  it("does nothing on restart when commands are unchanged", async () => {
    const initialLiveCommands: FakeLiveCommand[] = [
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
    ];
    const { client, rest } = createClientHarness(initialLiveCommands);
    const env = buildEnv(stateDir);
    await fs.mkdir(path.dirname(__testing.resolveStatePath({ accountId: "default", env })), {
      recursive: true,
    });
    await fs.writeFile(
      __testing.resolveStatePath({ accountId: "default", env }),
      JSON.stringify({
        version: 1,
        accountId: "default",
        applicationId: "app-1",
        commands: [
          {
            id: "cmd-1",
            name: "cmd",
            signatureHash: __testing.hashDefinition({
              name: "cmd",
              description: "built-in",
              type: 1,
            }),
            deployedAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
          },
          {
            id: "cmd-2",
            name: "cron_jobs",
            signatureHash: __testing.hashDefinition({
              name: "cron_jobs",
              description: "plugin",
              type: 1,
            }),
            deployedAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
          },
        ],
      }),
      "utf8",
    );

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
      env,
    });

    expect(result.summary).toEqual({
      validated: 2,
      unchanged: 2,
      created: 0,
      updated: 0,
      deleted: 0,
      leftAlone: 0,
    });
    expect(rest.post).not.toHaveBeenCalled();
    expect(rest.patch).not.toHaveBeenCalled();
    expect(rest.delete).not.toHaveBeenCalled();
  });

  it("updates changed commands, deletes tracked removals, and preserves unknown live commands", async () => {
    const initialLiveCommands: FakeLiveCommand[] = [
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
      {
        id: "cmd-3",
        name: "custom_live",
        description: "leave me alone",
        type: 1,
      },
    ];
    const { client, rest, getLiveCommands } = createClientHarness(initialLiveCommands);
    const env = buildEnv(stateDir);
    await fs.mkdir(path.dirname(__testing.resolveStatePath({ accountId: "default", env })), {
      recursive: true,
    });
    await fs.writeFile(
      __testing.resolveStatePath({ accountId: "default", env }),
      JSON.stringify({
        version: 1,
        accountId: "default",
        applicationId: "app-1",
        commands: [
          {
            id: "cmd-1",
            name: "cmd",
            signatureHash: "stale",
            deployedAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
          },
          {
            id: "cmd-2",
            name: "old_cmd",
            signatureHash: "stale",
            deployedAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
          },
        ],
      }),
      "utf8",
    );

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
      env,
    });

    expect(result.summary).toEqual({
      validated: 1,
      unchanged: 0,
      created: 1,
      updated: 1,
      deleted: 1,
      leftAlone: 1,
    });
    expect(rest.patch).toHaveBeenCalledTimes(1);
    expect(rest.post).toHaveBeenCalledTimes(1);
    expect(rest.delete).toHaveBeenCalledTimes(1);
    expect(
      getLiveCommands()
        .map((command) => command.name)
        .toSorted(),
    ).toEqual(["cmd", "custom_live", "new_cmd"]);
  });

  it("logs unexpected live command names and validated counts", async () => {
    const runtime = { log: vi.fn() };
    const { client } = createClientHarness([
      {
        id: "cmd-1",
        name: "cmd",
        description: "built-in",
        type: 1,
      },
      {
        id: "cmd-2",
        name: "extra_live",
        description: "leave me alone",
        type: 1,
      },
    ]);
    const env = buildEnv(stateDir);
    await fs.mkdir(path.dirname(__testing.resolveStatePath({ accountId: "default", env })), {
      recursive: true,
    });
    await fs.writeFile(
      __testing.resolveStatePath({ accountId: "default", env }),
      JSON.stringify({
        version: 1,
        accountId: "default",
        applicationId: "app-1",
        commands: [
          {
            id: "cmd-1",
            name: "cmd",
            signatureHash: __testing.hashDefinition({
              name: "cmd",
              description: "built-in",
              type: 1,
            }),
            deployedAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
          },
        ],
      }),
      "utf8",
    );

    await reconcileDiscordNativeCommands({
      client,
      cfg: {} as OpenClawConfig,
      runtime,
      accountId: "default",
      applicationId: "app-1",
      commandSpecs: [{ name: "cmd", description: "built-in", acceptsArgs: false }],
      env,
    });

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("trackedLive=1 unexpectedLive=1"),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("leaving unexpected live commands untouched: extra_live"),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("summary validated=1 unchanged=1"),
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
      env: buildEnv(stateDir),
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
});
