import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { clearActivePluginRegistry } from "../plugins/runtime.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { runLocalAgentCommand } from "./agent-command-local.js";

const mocks = vi.hoisted(() => ({
  config: {} as import("../config/types.openclaw.js").OpenClawConfig,
  secretResolution: vi.fn(),
}));
// Stub only the external command-secret resolution boundary. The runtime-config
// owner still selects target IDs and paths, and prepare/routing remain real.
vi.mock("../cli/command-config-resolution.runtime.js", () => ({
  resolveCommandConfigWithSecrets: mocks.secretResolution,
}));
vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => mocks.config,
  readConfigFileSnapshotForWrite: async () => ({
    snapshot: { valid: true, resolved: mocks.config },
    writeOptions: {},
  }),
}));
// Production installs its process-stable channel target catalog before a CLI
// turn. This fixture disables bundled plugins and installs its owner per test.
vi.mock("../secrets/target-registry.js", async (importOriginal) => {
  const registry = await importOriginal<typeof import("../secrets/target-registry.js")>();
  return {
    ...registry,
    listSecretTargetRegistryEntries: () => [
      ...registry.listSecretTargetRegistryEntries(),
      ...[
        "channels.discord.accounts.*.token",
        "channels.telegram.botToken",
        "channels.fixture-disabled.token",
      ].map((id) => ({
        id,
        targetType: id,
        configFile: "openclaw.json" as const,
        pathPattern: id,
        secretShape: "secret_input" as const,
        expectedResolvedValue: "string" as const,
        includeInPlan: true,
        includeInConfigure: true,
        includeInAudit: true,
      })),
    ],
  };
});
vi.mock("./command/runtime-loaders.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./command/runtime-loaders.js")>()),
  resolveAgentCommandDeps: async () => ({}),
}));

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "local-recipient" });
  useNoBundledPlugins();
});
afterEach(async () => {
  clearSecretsRuntimeSnapshot();
  mocks.secretResolution.mockReset();
  closeOpenClawStateDatabaseForTest();
  await clearActivePluginRegistry();
  resetPluginLoaderTestStateForTest();
  await state.cleanup();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it("does not resolve a disabled external recipient's required secret", async () => {
  const plugin = writePlugin({
    id: "disabled-recipient-fixture",
    registration:
      'if (api.registrationMode === "full") api.registerChannel({ plugin: { id: "fixture-disabled", meta: { id: "fixture-disabled", label: "Disabled" }, capabilities: { chatTypes: ["direct"] }, config: { listAccountIds: () => [], resolveAccount: () => ({}) }, outbound: { sendText: async () => { throw new Error("must not send"); } } });',
  });
  const manifest = path.join(plugin.dir, "openclaw.plugin.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(manifest, "utf8")),
      channels: ["fixture-disabled"],
    }),
  );
  const missingRef = { source: "env" as const, provider: "default", id: "FIXTURE_MISSING_TOKEN" };
  mocks.config = {
    agents: { list: [{ id: "main" }, { id: "ops", workspace: state.path("ops-workspace") }] },
    plugins: { load: { paths: [plugin.file] }, entries: { [plugin.id]: { enabled: false } } },
    channels: { "fixture-disabled": { token: missingRef } },
  };
  mocks.secretResolution.mockImplementation(() => {
    throw new Error("disabled channel secret must not be resolved");
  });
  const result = await runLocalAgentCommand({
    opts: { message: "prepare only", agentId: "ops", channel: "fixture-disabled", to: "user-42" },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    run: async (prepared) => prepared.sessionKey,
  });
  expect(result).toBe("agent:ops:main");
  expect(mocks.secretResolution).not.toHaveBeenCalled();
});

it("materializes an active external recipient after its full registration reveals the channel", async () => {
  const routeEvent = "external-secret-route:" + state.root;
  const routeConfigs: unknown[] = [];
  const record = (cfg: unknown) => routeConfigs.push(cfg);
  process.on(routeEvent, record);
  try {
    const plugin = writePlugin({
      id: "external-recipient-fixture",
      registration: [
        'if (api.registrationMode !== "full") return;',
        'api.registerChannel({ plugin: { id: "fixture-disabled", meta: { id: "fixture-disabled", label: "External" }, capabilities: { chatTypes: ["direct"] }, config: { listAccountIds: () => [], resolveAccount: () => ({}) }, outbound: { sendText: async () => { throw new Error("must not send"); } }, messaging: { resolveOutboundSessionRoute: ({ cfg, agentId, target }) => { process.emit(' +
          JSON.stringify(routeEvent) +
          ', cfg); return { sessionKey: "agent:" + agentId + ":fixture-disabled:direct:" + target, baseSessionKey: "agent:" + agentId + ":fixture-disabled:direct:" + target, recipientSessionExact: true, peer: { kind: "direct", id: target }, chatType: "direct", from: "user:" + target, to: target }; } } } });',
      ].join("\n"),
    });
    const manifest = path.join(plugin.dir, "openclaw.plugin.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(manifest, "utf8")),
        channels: ["fixture-disabled"],
      }),
    );
    const missingRef = {
      source: "env" as const,
      provider: "default",
      id: "FIXTURE_SELECTED_TOKEN",
    };
    const source = {
      agents: { list: [{ id: "main" }, { id: "ops", workspace: state.path("ops-workspace") }] },
      plugins: { load: { paths: [plugin.file] }, entries: { [plugin.id]: { enabled: true } } },
      channels: { "fixture-disabled": { token: missingRef } },
    };
    mocks.config = source;
    mocks.secretResolution.mockImplementation(
      async (params: { config: typeof source; targetIds: Set<string> }) => {
        expect(params.targetIds.has("channels.fixture-disabled.token")).toBe(true);
        const resolvedConfig = {
          ...params.config,
          channels: { "fixture-disabled": { token: "synthetic-selected-token" } },
        };
        return { resolvedConfig, effectiveConfig: resolvedConfig, diagnostics: [] };
      },
    );
    const result = await runLocalAgentCommand({
      opts: { message: "prepare only", agentId: "ops", channel: "fixture-disabled", to: "user-42" },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      run: async (prepared) => ({ sessionKey: prepared.sessionKey, cfg: prepared.cfg }),
    });
    expect(result.sessionKey).toBe("agent:ops:fixture-disabled:direct:user-42");
    expect(result.cfg.channels?.["fixture-disabled"]?.token).toBe("synthetic-selected-token");
    expect(routeConfigs).toEqual([result.cfg]);
    expect(mocks.secretResolution).toHaveBeenCalledTimes(1);
  } finally {
    process.off(routeEvent, record);
  }
});

it.each([
  {
    channel: "local-channel",
    to: "user-42",
    sessionKey: "agent:ops:local-channel:direct:user-42",
    selectedChannel: "local-channel",
  },
  {
    channel: "local-alias",
    to: "user-42",
    sessionKey: "agent:ops:local-channel:direct:user-42",
    selectedChannel: "local-channel",
  },
  {
    channel: "not-a-channel",
    to: "user-42",
    sessionKey: "agent:ops:main",
    selectedChannel: "not-a-channel",
  },
  { channel: "webchat", to: "user-42", sessionKey: "agent:ops:main", selectedChannel: "webchat" },
  {
    channel: "local-alias",
    to: "agent:ops:fixed",
    sessionKey: "agent:ops:fixed",
    selectedChannel: "local-alias",
  },
  {
    channel: "local-alias",
    to: "user-42",
    explicitSessionKey: "agent:ops:fixed",
    sessionKey: "agent:ops:fixed",
    selectedChannel: "local-alias",
  },
  {
    channel: "local-alias",
    to: "user-42",
    agentId: "missing",
    expectedError: 'Unknown agent id "missing"',
  },
  {
    channel: "local-alias",
    to: "user-42",
    pluginEnabled: false,
    sessionKey: "agent:ops:main",
    selectedChannel: "local-alias",
  },
])(
  "selects $sessionKey for $channel and $to without sending",
  async ({
    channel,
    to,
    explicitSessionKey,
    sessionKey,
    selectedChannel,
    agentId,
    expectedError,
    pluginEnabled,
  }) => {
    const event = "local-recipient:" + state.root;
    const captures: string[] = [];
    const record = (mode: string) => captures.push(mode);
    process.on(event, record);
    try {
      const plugin = writePlugin({
        id: "recipient-fixture",
        registration: [
          "process.emit(" + JSON.stringify(event) + ", api.registrationMode);",
          'if (api.registrationMode !== "full") return;',
          'api.registerChannel({ plugin: { id: "local-channel", meta: { id: "local-channel", label: "Local", aliases: ["local-alias"] }, capabilities: { chatTypes: ["direct"] }, config: { listAccountIds: () => [], resolveAccount: () => ({}) }, outbound: { sendText: async () => { throw new Error("fixture must not deliver"); } }, messaging: { resolveOutboundSessionRoute: ({ agentId, target }) => ({ sessionKey: "agent:" + agentId + ":local-channel:direct:" + target, baseSessionKey: "agent:" + agentId + ":local-channel:direct:" + target, recipientSessionExact: true, peer: { kind: "direct", id: target }, chatType: "direct", from: "user:" + target, to: target }) } } });',
        ].join("\n"),
      });
      const manifest = path.join(plugin.dir, "openclaw.plugin.json");
      fs.writeFileSync(
        manifest,
        JSON.stringify({
          ...JSON.parse(fs.readFileSync(manifest, "utf8")),
          channels: ["local-channel"],
        }),
      );
      const workspace = state.path("ops-workspace");
      mocks.config = {
        agents: { list: [{ id: "main" }, { id: "ops", workspace }] },
        session: { dmScope: "per-channel-peer" },
        plugins: {
          load: { paths: [plugin.file] },
          entries: { [plugin.id]: { enabled: pluginEnabled !== false } },
        },
      };
      const run = () =>
        runLocalAgentCommand({
          opts: {
            message: "prepare only",
            agentId: agentId ?? "ops",
            channel,
            to,
            sessionKey: explicitSessionKey,
          },
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          run: async (prepared) => ({
            sessionKey: prepared.sessionKey,
            channel: prepared.opts.channel,
            workspaceDir: prepared.workspaceDir,
          }),
        });
      if (expectedError) {
        await expect(run()).rejects.toThrow(expectedError);
        expect(captures).toEqual([]);
        return;
      }
      const result = await run();
      expect(result).toEqual({
        sessionKey,
        channel: selectedChannel,
        workspaceDir: workspace,
      });
      expect(captures).toEqual(pluginEnabled === false ? [] : ["full"]);
    } finally {
      process.off(event, record);
    }
  },
);

it.each(["discord", "local-alias"])(
  "materializes only the selected channel for a %s recipient before its route hook",
  async (channel) => {
    const event = "local-secret-route:" + state.root;
    const routeConfigs: unknown[] = [];
    const registrationTokens: unknown[] = [];
    const record = (cfg: unknown) => routeConfigs.push(cfg);
    const recordRegistration = (token: unknown) => registrationTokens.push(token);
    process.on(event, record);
    process.on(event + ":registration", recordRegistration);
    try {
      const plugin = writePlugin({
        id: "recipient-secret-fixture",
        registration: [
          'if (api.registrationMode !== "full") return;',
          "process.emit(" +
            JSON.stringify(event + ":registration") +
            ", api.config.channels.discord.accounts.selected.token);",
          'api.registerChannel({ plugin: { id: "discord", meta: { id: "discord", label: "Fixture", aliases: ["local-alias"] }, capabilities: { chatTypes: ["direct"] }, config: { listAccountIds: () => ["selected", "cold"], resolveAccount: ({ cfg, accountId }) => cfg.channels.discord.accounts[accountId] }, outbound: { sendText: async () => { throw new Error("fixture must not deliver"); } }, messaging: { resolveOutboundSessionRoute: ({ cfg, agentId, target }) => { process.emit(' +
            JSON.stringify(event) +
            ', cfg); return { sessionKey: "agent:" + agentId + ":discord:direct:" + target, baseSessionKey: "agent:" + agentId + ":discord:direct:" + target, recipientSessionExact: true, peer: { kind: "direct", id: target }, chatType: "direct", from: "user:" + target, to: target }; } } } });',
        ].join("\n"),
      });
      fs.writeFileSync(
        path.join(plugin.dir, "secret-contract-api.cjs"),
        'module.exports = { secretTargetRegistryEntries: ["discord.accounts.*.token", "telegram.botToken"].map((suffix) => ({ id: "channels." + suffix, targetType: "channels." + suffix, configFile: "openclaw.json", pathPattern: "channels." + suffix, secretShape: "secret_input", expectedResolvedValue: "string", includeInPlan: true, includeInConfigure: true, includeInAudit: true })) };\n',
      );
      const manifest = path.join(plugin.dir, "openclaw.plugin.json");
      fs.writeFileSync(
        manifest,
        JSON.stringify({
          ...JSON.parse(fs.readFileSync(manifest, "utf8")),
          channels: ["discord"],
        }),
      );
      const ref = (id: string) => ({ source: "env" as const, provider: "default", id });
      const source = {
        agents: { list: [{ id: "main" }, { id: "ops", workspace: state.path("ops-workspace") }] },
        session: { dmScope: "per-channel-peer" as const },
        plugins: { load: { paths: [plugin.file] }, entries: { [plugin.id]: { enabled: true } } },
        channels: {
          discord: {
            accounts: {
              selected: { token: ref("FIXTURE_SELECTED_DISCORD_TOKEN") },
              cold: { token: ref("FIXTURE_COLD_DISCORD_TOKEN") },
            },
          },
          telegram: { botToken: ref("FIXTURE_UNSELECTED_TELEGRAM_TOKEN") },
        },
      };
      mocks.config = source;
      mocks.secretResolution.mockImplementation(
        async (params: {
          config: typeof source;
          targetIds: Set<string>;
          allowedPaths?: Set<string>;
        }) => {
          if (
            params.targetIds.has("channels.telegram.botToken") ||
            params.allowedPaths?.has("channels.discord.accounts.cold.token") ||
            params.allowedPaths?.has("channels.telegram.botToken")
          ) {
            throw new Error("fixture refused unrelated channel/account secret resolution");
          }
          const selected =
            params.targetIds.has("channels.discord.accounts.*.token") &&
            params.allowedPaths?.has("channels.discord.accounts.selected.token");
          const resolvedConfig = selected
            ? {
                ...params.config,
                channels: {
                  ...params.config.channels,
                  discord: {
                    accounts: {
                      ...params.config.channels.discord.accounts,
                      selected: { token: "synthetic-materialized-token" },
                    },
                  },
                },
              }
            : params.config;
          return { resolvedConfig, effectiveConfig: resolvedConfig, diagnostics: [] };
        },
      );
      const result = await runLocalAgentCommand({
        opts: {
          message: "prepare only",
          agentId: "ops",
          channel,
          accountId: "selected",
          to: "user-42",
        },
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        run: async (prepared) => ({ cfg: prepared.cfg, sessionKey: prepared.sessionKey }),
      });
      expect(result.sessionKey).toBe("agent:ops:discord:direct:user-42");
      expect(
        mocks.secretResolution.mock.calls.map(([params]) => ({
          ids: [...params.targetIds].filter((id: string) => id.includes("discord")),
          paths: params.allowedPaths ? [...params.allowedPaths] : undefined,
        })),
      ).toContainEqual(
        expect.objectContaining({
          ids: expect.arrayContaining(["channels.discord.accounts.*.token"]),
        }),
      );
      expect(result.cfg.channels?.discord?.accounts?.selected?.token).toBe(
        "synthetic-materialized-token",
      );
      expect(result.cfg).not.toBe(source);
      expect(getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig).toEqual(source);
      expect(
        getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig.channels?.discord?.accounts?.selected
          ?.token,
      ).toEqual(source.channels.discord.accounts.selected.token);
      expect(result.cfg.channels?.discord?.accounts?.cold?.token).toEqual(
        source.channels.discord.accounts.cold.token,
      );
      expect(result.cfg.channels?.telegram?.botToken).toEqual(source.channels.telegram.botToken);
      expect(routeConfigs).toHaveLength(1);
      expect(routeConfigs[0]).toBe(result.cfg);
      // Route preparation owns the first (and for aliases, second) full root.
      // The alias first reveals its owner. Model admission must then reuse the
      // materialized root rather than registering the same config again.
      expect(registrationTokens).toEqual(
        channel === "local-alias"
          ? [source.channels.discord.accounts.selected.token, "synthetic-materialized-token"]
          : ["synthetic-materialized-token"],
      );
      expect(mocks.secretResolution).toHaveBeenCalled();
      for (const [params] of mocks.secretResolution.mock.calls) {
        expect(params.config).toBe(source);
        expect(params.targetIds).not.toContain("channels.telegram.botToken");
        expect(params.allowedPaths ?? new Set()).not.toContain("channels.telegram.botToken");
        expect(params.allowedPaths ?? new Set()).not.toContain(
          "channels.discord.accounts.cold.token",
        );
      }
      const selectedCalls = mocks.secretResolution.mock.calls.filter(([params]) =>
        params.targetIds.has("channels.discord.accounts.*.token"),
      );
      expect(selectedCalls).toHaveLength(1);
      expect(selectedCalls[0]?.[0].allowedPaths).toContain(
        "channels.discord.accounts.selected.token",
      );
      if (channel === "local-alias") {
        expect(mocks.secretResolution.mock.calls.length).toBe(1);
      }
    } finally {
      process.off(event, record);
      process.off(event + ":registration", recordRegistration);
    }
  },
);
