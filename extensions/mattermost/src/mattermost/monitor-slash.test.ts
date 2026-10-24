import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerMattermostMonitorSlashCommands } from "./monitor-slash.js";

const prepareSkillCommandsForAgents = vi.hoisted(() => vi.fn());
const fetchMattermostUserTeams = vi.hoisted(() => vi.fn());
const normalizeMattermostBaseUrl = vi.hoisted(() => vi.fn((value: string | undefined) => value));
const isSlashCommandsEnabled = vi.hoisted(() => vi.fn());
const registerSlashCommands = vi.hoisted(() => vi.fn());
const resolveCallbackUrl = vi.hoisted(() => vi.fn());
const resolveSlashCommandConfig = vi.hoisted(() => vi.fn());
const activateSlashCommands = vi.hoisted(() => vi.fn());

// mock-isolation: Keep skill discovery and database workers outside slash-registration tests.
vi.mock("./runtime-api.js", () => ({
  prepareSkillCommandsForAgents,
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

let runtime = { log: vi.fn(), error: vi.fn() };
const client = {} as never;
const nativeSpec = (trigger: string, description: string, originalName: string) => ({
  trigger,
  description,
  originalName,
  autoComplete: true,
  autoCompleteHint: "[args]",
});

function registerMonitor(
  cfg: Parameters<typeof registerMattermostMonitorSlashCommands>[0]["cfg"] = {},
) {
  return registerMattermostMonitorSlashCommands({
    client,
    cfg,
    runtime: runtime as never,
    account: { config: { commands: {} }, accountId: "default" } as never,
    baseUrl: "https://chat.example.com",
    botUserId: "bot-user",
  });
}

beforeEach(() => {
  prepareSkillCommandsForAgents.mockReset();
  fetchMattermostUserTeams.mockReset().mockResolvedValue([{ id: "team-1" }]);
  normalizeMattermostBaseUrl.mockClear();
  isSlashCommandsEnabled.mockReset().mockReturnValue(true);
  registerSlashCommands.mockReset();
  resolveCallbackUrl.mockReset().mockReturnValue("https://openclaw.test/slash");
  resolveSlashCommandConfig.mockReset().mockReturnValue({ enabled: true, nativeSkills: false });
  activateSlashCommands.mockReset();
  runtime = { log: vi.fn(), error: vi.fn() };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it("returns early when slash commands are disabled", async () => {
  resolveSlashCommandConfig.mockReturnValue({ enabled: false });
  isSlashCommandsEnabled.mockReturnValue(false);

  await registerMonitor();

  expect(fetchMattermostUserTeams).not.toHaveBeenCalled();
  expect(activateSlashCommands).not.toHaveBeenCalled();
});

it("registers deduped default and native skill commands across teams", async () => {
  vi.stubEnv("OPENCLAW_GATEWAY_PORT", "18888");
  resolveSlashCommandConfig.mockReturnValue({ enabled: true, nativeSkills: true });
  fetchMattermostUserTeams.mockResolvedValue([{ id: "team-1" }, { id: "team-2" }]);
  prepareSkillCommandsForAgents.mockResolvedValue([
    { name: "skill", description: "Skill run" },
    { name: "oc_ping", description: "Already prefixed" },
    { name: "   ", description: "ignored" },
  ]);
  registerSlashCommands
    .mockResolvedValueOnce([{ token: "token-1", trigger: "ping" }])
    .mockResolvedValueOnce([{ token: "token-2", trigger: "oc_skill" }]);

  await registerMonitor({ gateway: { port: 18789 } });

  expect(registerSlashCommands).toHaveBeenCalledTimes(2);
  const firstRegistration = registerSlashCommands.mock.calls[0]![0];
  expect(firstRegistration).toEqual({
    client,
    teamId: "team-1",
    creatorUserId: "bot-user",
    callbackUrl: "https://openclaw.test/slash",
    commands: [
      { trigger: "ping", description: "ping" },
      nativeSpec("oc_skill", "Skill run", "skill"),
      nativeSpec("oc_ping", "Already prefixed", "oc_ping"),
    ],
    log: expect.any(Function),
  });
  const activation = activateSlashCommands.mock.calls[0]![0];
  expect(activation?.registeredCommands).toStrictEqual([
    { token: "token-1", trigger: "ping" },
    { token: "token-2", trigger: "oc_skill" },
  ]);
  const triggerMap = new Map([
    ["oc_skill", "skill"],
    ["oc_ping", "oc_ping"],
  ]);
  expect(activation?.triggerMap).toStrictEqual(triggerMap);
  expect(runtime.log).toHaveBeenCalledWith(
    "mattermost: slash commands registered (2 commands across 2 teams, callback=https://openclaw.test/slash)",
  );
});

it("falls back to the configured gateway port when the env port is out of range", async () => {
  vi.stubEnv("OPENCLAW_GATEWAY_PORT", "65536");
  registerSlashCommands.mockResolvedValue([{ token: "token-1", trigger: "ping" }]);

  await registerMonitor({ gateway: { port: 18789 } });

  expect(resolveCallbackUrl).toHaveBeenCalledWith(expect.objectContaining({ gatewayPort: 18789 }));
});

it("warns on loopback callback urls and reports partial team failures", async () => {
  fetchMattermostUserTeams.mockResolvedValue([{ id: "team-1" }, { id: "team-2" }]);
  resolveCallbackUrl.mockReturnValue("http://127.0.0.1:18789/slash");
  registerSlashCommands
    .mockResolvedValueOnce([{ token: "token-1", trigger: "ping" }])
    .mockRejectedValueOnce(new Error("boom"));

  await registerMonitor({ gateway: { customBindHost: "loopback" } });

  expect(runtime.error).toHaveBeenCalledWith(
    "mattermost: slash commands callbackUrl resolved to http://127.0.0.1:18789/slash (loopback) while baseUrl is https://chat.example.com. This MAY be unreachable depending on your deployment. If native slash commands don't work, set channels.mattermost.commands.callbackUrl to a URL reachable from the Mattermost server (e.g. your public reverse proxy URL).",
  );
  expect(runtime.error).toHaveBeenCalledWith(
    "mattermost: failed to register slash commands for team team-2: Error: boom",
  );
  expect(runtime.error).toHaveBeenCalledWith(
    "mattermost: slash command registration completed with 1 team error(s)",
  );
});
