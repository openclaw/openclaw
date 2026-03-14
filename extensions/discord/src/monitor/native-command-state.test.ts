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
  let nextId =
    initialLiveCommands
      .map((command) => Number(command.id.replace(/^cmd-/, "")))
      .filter((value) => Number.isFinite(value))
      .reduce((max, value) => Math.max(max, value), 0) + 1;
  const liveCommands = [...initialLiveCommands];
  const rest = {
    get: vi.fn(async (route: string) => {
      if (route === Routes.applicationCommands("app-1")) {
        return [...liveCommands];
      }
      throw new Error(`unexpected get route: ${route}`);
    }),
    put: vi.fn(async (route: string, params: { body: Array<Record<string, unknown>> }) => {
      if (route !== Routes.applicationCommands("app-1")) {
        throw new Error(`unexpected put route: ${route}`);
      }
      const nextLiveCommands = params.body.map((body) => {
        const name = String(body.name);
        const existing = liveCommands.find((command) => command.name === name);
        return {
          id: existing?.id ?? `cmd-${nextId++}`,
          name,
          description: String(body.description ?? ""),
          type: Number(body.type ?? 1),
          options: Array.isArray(body.options)
            ? (body.options as Array<Record<string, unknown>>)
            : undefined,
        } satisfies FakeLiveCommand;
      });
      liveCommands.splice(0, liveCommands.length, ...nextLiveCommands);
      return [...liveCommands];
    }),
    post: vi.fn(async (route: string, _params: { body: Record<string, unknown> }) => {
      if (route !== Routes.applicationCommands("app-1")) {
        throw new Error(`unexpected post route: ${route}`);
      }
      throw new Error("unexpected post during bulk reconcile");
    }),
    patch: vi.fn(async (route: string, _params: { body: Record<string, unknown> }) => {
      const prefix = Routes.applicationCommand("app-1", "");
      if (!route.startsWith(prefix)) {
        throw new Error(`unexpected patch route: ${route}`);
      }
      throw new Error("unexpected patch during bulk reconcile");
    }),
    delete: vi.fn(async (route: string) => {
      const prefix = Routes.applicationCommand("app-1", "");
      if (!route.startsWith(prefix)) {
        throw new Error(`unexpected delete route: ${route}`);
      }
      throw new Error("unexpected delete during bulk reconcile");
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
    expect(rest.put).toHaveBeenCalledTimes(1);
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
    expect(rest.put).not.toHaveBeenCalled();
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
    expect(rest.put).toHaveBeenCalledTimes(1);
    expect(rest.patch).not.toHaveBeenCalled();
    expect(rest.post).not.toHaveBeenCalled();
    expect(rest.delete).not.toHaveBeenCalled();
    expect(
      getLiveCommands()
        .map((command) => command.name)
        .toSorted(),
    ).toEqual(["cmd", "custom_live", "new_cmd"]);
  });

  it("uses a legacy-style overwrite when state is missing and stale managed commands exist", async () => {
    const { client, rest, getLiveCommands } = createClientHarness([
      {
        id: "cmd-1",
        name: "cmd",
        description: "built-in",
        type: 1,
      },
      {
        id: "cmd-2",
        name: "vc",
        description: "Voice channel controls",
        type: 1,
      },
    ]);
    const runtime = { log: vi.fn() };

    const result = await reconcileDiscordNativeCommands({
      client,
      cfg: {} as OpenClawConfig,
      runtime,
      accountId: "default",
      applicationId: "app-1",
      commandSpecs: [{ name: "cmd", description: "built-in", acceptsArgs: false }],
      env: buildEnv(stateDir),
    });

    expect(result.summary).toEqual({
      validated: 1,
      unchanged: 1,
      created: 0,
      updated: 0,
      deleted: 1,
      leftAlone: 0,
    });
    expect(rest.put).toHaveBeenCalledTimes(1);
    expect(getLiveCommands().map((command) => command.name)).toEqual(["cmd"]);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("state missing; using legacy bulk overwrite"),
    );
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
    expect(rest.put).not.toHaveBeenCalled();
    expect(rest.patch).not.toHaveBeenCalled();
    expect(rest.delete).not.toHaveBeenCalled();
  });

  it("replaces tracked renames at the Discord command cap without per-command mutations", async () => {
    const stableCommands = Array.from({ length: 99 }, (_, index) => ({
      id: `cmd-${index + 1}`,
      name: `stable_${index + 1}`,
      description: `stable ${index + 1}`,
      type: 1,
    })) satisfies FakeLiveCommand[];
    const initialLiveCommands: FakeLiveCommand[] = [
      ...stableCommands,
      {
        id: "cmd-100",
        name: "old_cmd",
        description: "rename me",
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
        commands: initialLiveCommands.map((command) => ({
          id: command.id,
          name: command.name,
          signatureHash: __testing.hashDefinition({
            name: command.name,
            description: command.description,
            type: command.type,
          }),
          deployedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        })),
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
        ...stableCommands.map((command) => ({
          name: command.name,
          description: command.description,
          acceptsArgs: false,
        })),
        { name: "new_cmd", description: "replacement", acceptsArgs: false },
      ] satisfies NativeCommandSpec[],
      env,
    });

    expect(result.summary).toEqual({
      validated: 99,
      unchanged: 99,
      created: 1,
      updated: 0,
      deleted: 1,
      leftAlone: 0,
    });
    expect(rest.put).toHaveBeenCalledTimes(1);
    expect(rest.post).not.toHaveBeenCalled();
    expect(rest.patch).not.toHaveBeenCalled();
    expect(rest.delete).not.toHaveBeenCalled();
    expect(getLiveCommands()).toHaveLength(100);
    expect(getLiveCommands().some((command) => command.name === "old_cmd")).toBe(false);
    expect(getLiveCommands().some((command) => command.name === "new_cmd")).toBe(true);
  });
});
