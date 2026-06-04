import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const listSkillCommandsForAgents = vi.hoisted(() => vi.fn());
const parseTcpPort = vi.hoisted(() => vi.fn());
const fetchMattermostUserTeams = vi.hoisted(() => vi.fn());
const normalizeMattermostBaseUrl = vi.hoisted(() => vi.fn((value: string | undefined) => value));
const isSlashCommandsEnabled = vi.hoisted(() => vi.fn());
const registerSlashCommands = vi.hoisted(() => vi.fn());
const resolveCallbackUrl = vi.hoisted(() => vi.fn());
const resolveSlashCommandConfig = vi.hoisted(() => vi.fn());
const activateSlashCommands = vi.hoisted(() => vi.fn());

vi.mock("./runtime-api.js", () => ({
  listSkillCommandsForAgents,
  parseTcpPort,
}));

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    fetchMattermostUserTeams,
    normalizeMattermostBaseUrl,
  };
});

vi.mock("./slash-commands.js", () => ({
  DEFAULT_COMMAND_SPECS: [
    { trigger: "ping", description: "ping" },
    { trigger: "ping", description: "duplicate" },
  ],
  isSlashCommandsEnabled,
  registerSlashCommands,
  resolveCallbackUrl,
  resolveSlashCommandConfig,
}));

vi.mock("./slash-state.js", () => ({
  activateSlashCommands,
}));

function requireFirstMockCall<TArgs extends unknown[]>(
  mock: { mock: { calls: TArgs[] } },
  label: string,
): TArgs {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call;
}

describe("mattermost monitor slash", () => {
  let registerMattermostMonitorSlashCommands: typeof import("./monitor-slash.js").registerMattermostMonitorSlashCommands;

  beforeAll(async () => {
    ({ registerMattermostMonitorSlashCommands } = await import("./monitor-slash.js"));
  });

  beforeEach(() => {
    listSkillCommandsForAgents.mockReset();
    parseTcpPort.mockReset();
    fetchMattermostUserTeams.mockReset();
    normalizeMattermostBaseUrl.mockClear();
    isSlashCommandsEnabled.mockReset();
    registerSlashCommands.mockReset();
    resolveCallbackUrl.mockReset();
    resolveSlashCommandConfig.mockReset();
    activateSlashCommands.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns early when slash commands are disabled", async () => {
    resolveSlashCommandConfig.mockReturnValue({ enabled: false });
    isSlashCommandsEnabled.mockReturnValue(false);

    await registerMattermostMonitorSlashCommands({
      client: {} as never,
      cfg: {} as never,
      runtime: {} as never,
      account: { config: {} } as never,
      baseUrl: "https://chat.example.com",
      botUserId: "bot-user",
    });

    expect(fetchMattermostUserTeams).not.toHaveBeenCalled();
    expect(activateSlashCommands).not.toHaveBeenCalled();
  });

  it("registers deduped default and native skill commands across teams", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "18888");
    resolveSlashCommandConfig.mockReturnValue({ enabled: true, nativeSkills: true });
    isSlashCommandsEnabled.mockReturnValue(true);
    parseTcpPort.mockReturnValue(18888);
    fetchMattermostUserTeams.mockResolvedValue([{ id: "team-1" }, { id: "team-2" }]);
    resolveCallbackUrl.mockReturnValue("https://openclaw.test/slash");
    listSkillCommandsForAgents.mockReturnValue([
      { name: "skill", description: "Skill run" },
      { name: "oc_ping", description: "Already prefixed" },
      { name: "   ", description: "ignored" },
    ]);
    registerSlashCommands
      .mockResolvedValueOnce([{ token: "token-1", trigger: "ping" }])
      .mockResolvedValueOnce([{ token: "token-2", trigger: "oc_skill" }]);
    const client = {} as never;
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    };

    await registerMattermostMonitorSlashCommands({
      client,
      cfg: { gateway: { port: 18789 } } as never,
      runtime: runtime as never,
      account: { config: { commands: {} }, accountId: "default" } as never,
      baseUrl: "https://chat.example.com",
      botUserId: "bot-user",
    });

    expect(registerSlashCommands).toHaveBeenCalledTimes(2);
    const [firstRegistration] = requireFirstMockCall(
      registerSlashCommands,
      "first Mattermost slash command registration",
    );
    expect(firstRegistration).toEqual({
      client,
      teamId: "team-1",
      creatorUserId: "bot-user",
      callbackUrl: "https://openclaw.test/slash",
      commands: [
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
      ],
      log: firstRegistration.log,
    });
    expect(typeof firstRegistration.log).toBe("function");
    const [activation] = requireFirstMockCall(
      activateSlashCommands,
      "Mattermost slash command activation",
    );
    expect(activation?.commandTokens).toStrictEqual(["token-1", "token-2"]);
    expect(activation?.triggerMap).toStrictEqual(
      new Map([
        ["oc_skill", "skill"],
        ["oc_ping", "oc_ping"],
      ]),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "mattermost: slash commands registered (2 commands across 2 teams, callback=https://openclaw.test/slash)",
    );
  });

  it("falls back to the configured gateway port when the env port is out of range", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "65536");
    resolveSlashCommandConfig.mockReturnValue({ enabled: true, nativeSkills: false });
    isSlashCommandsEnabled.mockReturnValue(true);
    parseTcpPort.mockReturnValue(null);
    fetchMattermostUserTeams.mockResolvedValue([{ id: "team-1" }]);
    resolveCallbackUrl.mockReturnValue("https://openclaw.test/slash");
    registerSlashCommands.mockResolvedValue([{ token: "token-1", trigger: "ping" }]);

    await registerMattermostMonitorSlashCommands({
      client: {} as never,
      cfg: { gateway: { port: 18789 } } as never,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      account: { config: { commands: {} }, accountId: "default" } as never,
      baseUrl: "https://chat.example.com",
      botUserId: "bot-user",
    });

    expect(parseTcpPort).toHaveBeenCalledWith("65536");
    expect(resolveCallbackUrl).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayPort: 18789 }),
    );
  });

  it("refuses insecure derived callback URLs before registration", async () => {
    resolveSlashCommandConfig.mockReturnValue({ enabled: true, nativeSkills: false });
    isSlashCommandsEnabled.mockReturnValue(true);
    parseTcpPort.mockReturnValue(null);
    fetchMattermostUserTeams.mockResolvedValue([{ id: "team-1" }, { id: "team-2" }]);
    resolveCallbackUrl.mockReturnValue("http://127.0.0.1:18789/slash");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    };

    await registerMattermostMonitorSlashCommands({
      client: {} as never,
      cfg: { gateway: { customBindHost: "loopback" } } as never,
      runtime: runtime as never,
      account: { config: { commands: {} }, accountId: "default" } as never,
      baseUrl: "https://chat.example.com",
      botUserId: "bot-user",
    });

    expect(runtime.error).toHaveBeenCalledWith(
      "mattermost: native slash commands require an HTTPS channels.mattermost.commands.callbackUrl; refusing derived callback http://127.0.0.1:18789/slash",
    );
    expect(registerSlashCommands).not.toHaveBeenCalled();
    expect(activateSlashCommands).not.toHaveBeenCalled();
  });

  it("refuses insecure explicitly configured callback URLs", async () => {
    resolveSlashCommandConfig.mockReturnValue({
      enabled: true,
      nativeSkills: false,
      callbackUrl: "http://public-server.example.com/slash",
    });
    isSlashCommandsEnabled.mockReturnValue(true);
    parseTcpPort.mockReturnValue(null);
    fetchMattermostUserTeams.mockResolvedValue([{ id: "team-1" }]);
    resolveCallbackUrl.mockReturnValue("http://public-server.example.com/slash");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    };

    await registerMattermostMonitorSlashCommands({
      client: {} as never,
      cfg: { gateway: { customBindHost: "gateway.example.com" } } as never,
      runtime: runtime as never,
      account: {
        config: { commands: { callbackUrl: "http://public-server.example.com/slash" } },
        accountId: "default",
      } as never,
      baseUrl: "https://chat.example.com",
      botUserId: "bot-user",
    });

    expect(runtime.error).toHaveBeenCalledWith(
      "mattermost: native slash commands require an HTTPS channels.mattermost.commands.callbackUrl; refusing explicit callback http://public-server.example.com/slash",
    );
    expect(registerSlashCommands).not.toHaveBeenCalled();
    expect(activateSlashCommands).not.toHaveBeenCalled();
  });
});
