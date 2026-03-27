import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listSkillCommandsForAgents = vi.hoisted(() => vi.fn());
const parseStrictPositiveInteger = vi.hoisted(() => vi.fn());
const fetchMattermostUserTeams = vi.hoisted(() => vi.fn());
const normalizeMattermostBaseUrl = vi.hoisted(() => vi.fn((value: string | undefined) => value));
const getMattermostRuntime = vi.hoisted(() =>
  vi.fn(() => ({
    state: {
      resolveStateDir: () => "/tmp/openclaw-state",
    },
  })),
);
const isSlashCommandsEnabled = vi.hoisted(() => vi.fn());
const registerSlashCommands = vi.hoisted(() => vi.fn());
const resolveCallbackUrl = vi.hoisted(() => vi.fn());
const resolveSlashCommandConfig = vi.hoisted(() => vi.fn());
const loadPersistedSlashCommandState = vi.hoisted(() => vi.fn());
const savePersistedSlashCommandState = vi.hoisted(() => vi.fn());
const removePersistedSlashCommands = vi.hoisted(() => vi.fn());
const mergePersistedSlashCommands = vi.hoisted(() => vi.fn());
const resolveSlashCommandCachePath = vi.hoisted(() =>
  vi.fn(
    (stateDir: string, accountId: string) =>
      `${stateDir}/mattermost/slash-commands/${accountId}.json`,
  ),
);
const cleanupSlashCommands = vi.hoisted(() => vi.fn());
const activateSlashCommands = vi.hoisted(() => vi.fn());
const MattermostIncompleteBlindCreateError = vi.hoisted(
  () =>
    class MattermostIncompleteBlindCreateError extends Error {
      recoverableCommands: unknown[];
      override readonly cause: unknown;

      constructor(message: string, params: { recoverableCommands: unknown[]; cause: unknown }) {
        super(message);
        this.name = "MattermostIncompleteBlindCreateError";
        this.recoverableCommands = params.recoverableCommands;
        this.cause = params.cause;
      }
    },
);

vi.mock("../runtime-api.js", () => ({
  listSkillCommandsForAgents,
  parseStrictPositiveInteger,
}));

vi.mock("../runtime.js", () => ({
  getMattermostRuntime,
}));

vi.mock("./client.js", () => ({
  fetchMattermostUserTeams,
  normalizeMattermostBaseUrl,
}));

vi.mock("./slash-commands.js", () => ({
  DEFAULT_COMMAND_SPECS: [
    { trigger: "ping", description: "ping" },
    { trigger: "ping", description: "duplicate" },
  ],
  MattermostIncompleteBlindCreateError,
  cleanupSlashCommands,
  isSlashCommandsEnabled,
  loadPersistedSlashCommandState,
  mergePersistedSlashCommands,
  registerSlashCommands,
  removePersistedSlashCommands,
  resolveCallbackUrl,
  resolveSlashCommandCachePath,
  resolveSlashCommandConfig,
  savePersistedSlashCommandState,
}));

vi.mock("./slash-state.js", () => ({
  activateSlashCommands,
}));

function defaultMergePersistedSlashCommands(params: {
  cachedCommands: Array<{ teamId: string }>;
  registeredCommands: Array<{ teamId: string }>;
  refreshedTeamIds: Iterable<string>;
}) {
  const refreshedTeamIds = new Set(
    [...params.refreshedTeamIds].map((teamId) => teamId.trim()).filter(Boolean),
  );
  return [
    ...params.cachedCommands.filter((cmd) => !refreshedTeamIds.has(cmd.teamId.trim())),
    ...params.registeredCommands,
  ];
}

describe("mattermost monitor slash", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    isSlashCommandsEnabled.mockReturnValue(true);
    mergePersistedSlashCommands.mockImplementation(defaultMergePersistedSlashCommands);
    loadPersistedSlashCommandState.mockResolvedValue({ ownerId: null, commands: [] });
    savePersistedSlashCommandState.mockResolvedValue(undefined);
    removePersistedSlashCommands.mockResolvedValue(undefined);
    cleanupSlashCommands.mockResolvedValue([]);
    resolveSlashCommandConfig.mockReturnValue({ native: true, nativeSkills: false });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns early when slash commands are disabled", async () => {
    isSlashCommandsEnabled.mockReturnValue(false);
    const { registerMattermostMonitorSlashCommands } = await import("./monitor-slash.js");

    await expect(
      registerMattermostMonitorSlashCommands({
        client: {} as never,
        cfg: {} as never,
        runtime: {} as never,
        account: { config: {} } as never,
        baseUrl: "https://chat.example.com",
        botUserId: "bot-user",
      }),
    ).resolves.toBeNull();

    expect(fetchMattermostUserTeams).not.toHaveBeenCalled();
    expect(activateSlashCommands).not.toHaveBeenCalled();
  });

  it("registers deduped default and native skill commands across teams", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "18888");
    parseStrictPositiveInteger.mockReturnValue(18888);
    resolveSlashCommandConfig.mockReturnValue({ native: true, nativeSkills: true });
    fetchMattermostUserTeams.mockResolvedValue([{ id: "team-1" }, { id: "team-2" }]);
    resolveCallbackUrl.mockReturnValue("https://openclaw.test/slash");
    listSkillCommandsForAgents.mockReturnValue([
      { name: "skill", description: "Skill run" },
      { name: "oc_ping", description: "Already prefixed" },
      { name: "   ", description: "ignored" },
    ]);
    registerSlashCommands
      .mockResolvedValueOnce([{ token: "token-1", trigger: "ping", teamId: "team-1" }])
      .mockResolvedValueOnce([{ token: "token-2", trigger: "oc_skill", teamId: "team-2" }]);
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    };

    const { registerMattermostMonitorSlashCommands } = await import("./monitor-slash.js");

    const lifecycle = await registerMattermostMonitorSlashCommands({
      client: {} as never,
      cfg: { gateway: { port: 18789 } } as never,
      runtime: runtime as never,
      account: { config: { commands: {} }, accountId: "default" } as never,
      baseUrl: "https://chat.example.com",
      botUserId: "bot-user",
    });

    expect(lifecycle).toMatchObject({
      cachePath: "/tmp/openclaw-state/mattermost/slash-commands/default.json",
      ownerId: expect.any(String),
    });
    expect(registerSlashCommands).toHaveBeenCalledTimes(2);
    expect(registerSlashCommands.mock.calls[0]?.[0]).toMatchObject({
      teamId: "team-1",
      creatorUserId: "bot-user",
      callbackUrl: "https://openclaw.test/slash",
    });
    expect(registerSlashCommands.mock.calls[0]?.[0].commands).toEqual([
      { trigger: "ping", description: "ping" },
      {
        trigger: "oc_skill",
        description: "Skill run",
        autoComplete: true,
        autoCompleteHint: "[args]",
        originalName: "skill",
      },
      {
        trigger: "oc_ping",
        description: "Already prefixed",
        autoComplete: true,
        autoCompleteHint: "[args]",
        originalName: "oc_ping",
      },
    ]);
    expect(activateSlashCommands).toHaveBeenCalledWith(
      expect.objectContaining({
        commandTokens: ["token-1", "token-2"],
        triggerMap: new Map([
          ["oc_skill", "skill"],
          ["oc_ping", "oc_ping"],
        ]),
      }),
    );
    expect(savePersistedSlashCommandState).toHaveBeenCalledWith(
      "/tmp/openclaw-state/mattermost/slash-commands/default.json",
      expect.objectContaining({
        commands: [
          { token: "token-1", trigger: "ping", teamId: "team-1" },
          { token: "token-2", trigger: "oc_skill", teamId: "team-2" },
        ],
      }),
      expect.any(Function),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "mattermost: slash commands registered (2 commands across 2 teams, callback=https://openclaw.test/slash)",
    );
  });

  it("claims cached ownership before registering commands", async () => {
    fetchMattermostUserTeams.mockResolvedValue([{ id: "team-1" }]);
    resolveCallbackUrl.mockReturnValue("https://openclaw.test/slash");
    loadPersistedSlashCommandState.mockResolvedValue({
      ownerId: "old-owner",
      commands: [{ id: "cmd-1", trigger: "ping", teamId: "team-1", token: "tok-1" }],
    });
    registerSlashCommands.mockResolvedValue([
      { token: "token-1", trigger: "ping", teamId: "team-1" },
    ]);

    const { registerMattermostMonitorSlashCommands } = await import("./monitor-slash.js");

    await registerMattermostMonitorSlashCommands({
      client: {} as never,
      cfg: { gateway: { port: 18789 } } as never,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      account: { config: { commands: {} }, accountId: "default" } as never,
      baseUrl: "https://chat.example.com",
      botUserId: "bot-user",
    });

    expect(savePersistedSlashCommandState).toHaveBeenCalledTimes(2);
    expect(savePersistedSlashCommandState.mock.calls[0]?.[1]).toMatchObject({
      ownerId: expect.any(String),
      commands: [{ id: "cmd-1", trigger: "ping", teamId: "team-1", token: "tok-1" }],
    });
    expect(savePersistedSlashCommandState.mock.invocationCallOrder[0]).toBeLessThan(
      registerSlashCommands.mock.invocationCallOrder[0]!,
    );
  });

  it("warns on loopback callback urls and reports partial team failures", async () => {
    parseStrictPositiveInteger.mockReturnValue(undefined);
    fetchMattermostUserTeams.mockResolvedValue([{ id: "team-1" }, { id: "team-2" }]);
    resolveCallbackUrl.mockReturnValue("http://127.0.0.1:18789/slash");
    registerSlashCommands
      .mockResolvedValueOnce([{ token: "token-1", trigger: "ping", teamId: "team-1" }])
      .mockRejectedValueOnce(new Error("boom"));
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    };

    const { registerMattermostMonitorSlashCommands } = await import("./monitor-slash.js");

    await registerMattermostMonitorSlashCommands({
      client: {} as never,
      cfg: { gateway: { customBindHost: "loopback" } } as never,
      runtime: runtime as never,
      account: { config: { commands: {} }, accountId: "default" } as never,
      baseUrl: "https://chat.example.com",
      botUserId: "bot-user",
    });

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "slash commands callbackUrl resolved to http://127.0.0.1:18789/slash",
      ),
    );
    expect(runtime.error).toHaveBeenCalledWith(
      "mattermost: failed to register slash commands for team team-2: Error: boom",
    );
    expect(runtime.error).toHaveBeenCalledWith(
      "mattermost: slash command registration completed with 1 team error(s)",
    );
  });

  it("persists recoverable commands when blind-create rollback is incomplete", async () => {
    fetchMattermostUserTeams.mockResolvedValue([{ id: "team-1" }]);
    resolveCallbackUrl.mockReturnValue("https://openclaw.test/slash");
    registerSlashCommands.mockRejectedValue(
      new MattermostIncompleteBlindCreateError("Mattermost API 403 Forbidden", {
        cause: new Error("Mattermost API 403 Forbidden"),
        recoverableCommands: [
          {
            id: "cmd-created-1",
            trigger: "ping",
            teamId: "team-1",
            token: "tok-1",
            callbackUrl: "https://openclaw.test/slash",
            managed: true,
          },
        ],
      }),
    );
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    };

    const { registerMattermostMonitorSlashCommands } = await import("./monitor-slash.js");

    await registerMattermostMonitorSlashCommands({
      client: {} as never,
      cfg: { gateway: { port: 18789 } } as never,
      runtime: runtime as never,
      account: { config: { commands: {} }, accountId: "default" } as never,
      baseUrl: "https://chat.example.com",
      botUserId: "bot-user",
    });

    expect(activateSlashCommands).not.toHaveBeenCalled();
    expect(savePersistedSlashCommandState).toHaveBeenCalledWith(
      "/tmp/openclaw-state/mattermost/slash-commands/default.json",
      expect.objectContaining({
        commands: [
          expect.objectContaining({
            id: "cmd-created-1",
            trigger: "ping",
            teamId: "team-1",
          }),
        ],
      }),
      expect.any(Function),
    );
    expect(runtime.error).toHaveBeenCalledWith(
      "mattermost: native slash commands enabled but no commands could be registered; keeping slash callbacks inactive",
    );
  });

  it("skips cleanup work when a newer process owns the cache", async () => {
    const command = {
      id: "cmd-1",
      trigger: "ping",
      teamId: "team-1",
      token: "tok-1",
      callbackUrl: "https://openclaw.test/slash",
      managed: true,
    };
    loadPersistedSlashCommandState.mockResolvedValue({
      ownerId: "new-owner",
      commands: [command],
    });
    cleanupSlashCommands.mockImplementation(async ({ commands, shouldDelete }) => {
      expect(await shouldDelete?.(commands[0])).toBe(false);
      return commands;
    });

    const { cleanupMattermostMonitorSlashCommands } = await import("./monitor-slash.js");

    await cleanupMattermostMonitorSlashCommands({
      client: {} as never,
      lifecycle: {
        cachePath: "/tmp/openclaw-state/mattermost/slash-commands/default.json",
        ownerId: "old-owner",
      },
      commands: [command],
      log: vi.fn(),
    });

    expect(savePersistedSlashCommandState).not.toHaveBeenCalled();
    expect(removePersistedSlashCommands).not.toHaveBeenCalled();
  });
});
