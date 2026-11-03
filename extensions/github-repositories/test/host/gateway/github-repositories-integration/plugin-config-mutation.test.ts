import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { pruneAgentConfig } from "../../../../../../src/commands/agents.config.js";
import { mutateAgentScopedPluginConfig } from "../../../../../../src/config/plugin-config-mutation.js";
import type { OpenClawConfig } from "../../../../../../src/config/types.openclaw.js";
import { withTempHomeCore as withTempHome } from "../../../../../../src/plugin-sdk/test-helpers/temp-home.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../../../../../src/state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../../../../../src/state/openclaw-state-db.paths.js";
import { updateGitHubToolIdentityConfig } from "../../../../tool-identity-config-api.js";

async function withPluginConfigFixture(
  run: (fixture: {
    configPath: string;
    pluginPath: string;
    config: OpenClawConfig;
  }) => Promise<void>,
  options: { workspaceScoped?: boolean } = {},
) {
  await withTempHome(
    async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      const pluginPath = path.join(stateDir, "example.json5");
      const workspace = path.join(home, "build-workspace");
      const pluginRoot = options.workspaceScoped
        ? path.join(workspace, ".openclaw", "extensions", "config-example")
        : path.join(stateDir, "extensions", "config-example");
      await fs.mkdir(pluginRoot, { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, "openclaw.plugin.json"),
        JSON.stringify({
          id: "config-example",
          configSchema: { type: "object", additionalProperties: true },
          configContracts: { agentConfigMaps: ["accounts.agents"] },
        }),
      );
      await fs.writeFile(
        path.join(pluginRoot, "package.json"),
        JSON.stringify({
          name: "config-example",
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        }),
      );
      await fs.writeFile(
        path.join(pluginRoot, "index.cjs"),
        'throw new Error("runtime must not load");',
      );
      const config: OpenClawConfig = {
        agents: {
          entries: { build: { workspace }, keeper: {}, other: {} },
          ownership: "explicit",
        },
        plugins: {
          ...(!options.workspaceScoped ? { load: { paths: [pluginRoot] } } : {}),
          entries: {
            "config-example": {
              enabled: false,
              config: { $include: "./example.json5" },
            },
            unrelated: { enabled: false, config: { value: "untouched" } },
          },
        },
      };
      await fs.writeFile(configPath, JSON.stringify(config));
      await fs.writeFile(
        pluginPath,
        JSON.stringify({ selection: "previous", policy: { allowInSandbox: false } }),
      );
      try {
        await run({ configPath, pluginPath, config });
      } finally {
        await closeOpenClawStateDatabaseByPathAsync(
          resolveOpenClawStateSqlitePath({ HOME: home, OPENCLAW_STATE_DIR: stateDir }),
        );
      }
    },
    {
      env: {
        OPENCLAW_CONFIG_PATH: (home) => path.join(home, ".openclaw", "openclaw.json"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    },
  );
}

it("keeps plugin mutation inside its include, preserves siblings, and honors caller CAS", async () => {
  await withPluginConfigFixture(async ({ configPath, pluginPath }) => {
    const params = {
      pluginId: "config-example",
      agent: { id: "build", createIfMissing: false },
    };
    await mutateAgentScopedPluginConfig(params, (current) => {
      if (current?.selection !== "previous") {
        throw new Error("selection changed");
      }
      return { ...current, selection: "next" };
    });
    const root = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(root.plugins.entries).toMatchObject({
      "config-example": { enabled: false, config: { $include: "./example.json5" } },
      unrelated: { enabled: false, config: { value: "untouched" } },
    });
    const included = await fs.readFile(pluginPath, "utf8");
    expect(JSON.parse(included)).toEqual({
      selection: "next",
      policy: { allowInSandbox: false },
    });
    await expect(
      mutateAgentScopedPluginConfig(params, (current) => {
        if (current?.selection !== "previous") {
          throw new Error("selection changed");
        }
        return { ...current, selection: "stale" };
      }),
    ).rejects.toThrow("selection changed");
    expect(await fs.readFile(pluginPath, "utf8")).toBe(included);
  });
});

it("does not publish setup for an absent uncreated agent or caller rejection", async () => {
  await withPluginConfigFixture(async ({ configPath, pluginPath }) => {
    const originalRoot = await fs.readFile(configPath, "utf8");
    const originalInclude = await fs.readFile(pluginPath, "utf8");
    await expect(
      mutateAgentScopedPluginConfig(
        { pluginId: "config-example", agent: { id: "new-agent", createIfMissing: true } },
        () => {
          throw new Error("setup selection expired");
        },
      ),
    ).rejects.toThrow("setup selection expired");
    expect(await fs.readFile(configPath, "utf8")).toBe(originalRoot);
    expect(await fs.readFile(pluginPath, "utf8")).toBe(originalInclude);
    const unchanged = await mutateAgentScopedPluginConfig(
      { pluginId: "config-example", agent: { id: "new-agent", createIfMissing: false } },
      (current) => ({ ...current, selection: "not-admitted" }),
    );
    expect(unchanged.agents?.entries?.["new-agent"]).toBeUndefined();
    expect(await fs.readFile(pluginPath, "utf8")).toBe(originalInclude);
  });
});

it("prunes only manifest-declared agent maps through native deletion even for a disabled plugin", async () => {
  await withPluginConfigFixture(async ({ config }) => {
    const nextConfig: OpenClawConfig = {
      ...config,
      plugins: {
        ...config.plugins,
        entries: {
          ...config.plugins?.entries,
          "config-example": {
            enabled: false,
            config: {
              accounts: {
                agents: { Build: { selection: "one" }, build: { selection: "two" }, keeper: {} },
              },
              unrelatedMap: { build: "retain" },
            },
          },
        },
      },
    };
    const result = pruneAgentConfig(nextConfig, "build").config;
    expect(result.agents?.entries).toEqual({ keeper: {}, other: {} });
    expect(result.plugins?.entries?.["config-example"]).toEqual({
      enabled: false,
      config: { accounts: { agents: { keeper: {} } }, unrelatedMap: { build: "retain" } },
    });
    expect(result.plugins?.entries?.unrelated).toEqual(config.plugins?.entries?.unrelated);
    expect(nextConfig.plugins?.entries?.["config-example"]?.config?.accounts).toEqual({
      agents: { Build: { selection: "one" }, build: { selection: "two" }, keeper: {} },
    });
  });
});

it("prunes agent maps declared by a plugin in the deleted agent's workspace", async () => {
  await withPluginConfigFixture(
    async ({ config }) => {
      const configured: OpenClawConfig = {
        ...config,
        plugins: {
          ...config.plugins,
          entries: {
            "config-example": {
              enabled: false,
              config: { accounts: { agents: { build: { selection: "remove" }, keeper: {} } } },
            },
          },
        },
      };

      const result = pruneAgentConfig(configured, "build").config;

      expect(result.plugins?.entries?.["config-example"]?.config).toEqual({
        accounts: { agents: { keeper: {} } },
      });
      expect(result.agents?.entries?.build).toBeUndefined();
    },
    { workspaceScoped: true },
  );
});

it("keeps canonical GitHub mutation inside its include and preserves identity CAS and agent sandbox policy", async () => {
  await withTempHome(
    async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      const pluginPath = path.join(stateDir, "github.json5");
      await fs.mkdir(stateDir, { recursive: true });
      const previous = { profileId: "ghp_11111111111111111111111111111111", allowInSandbox: false };
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: { entries: { Build: {} } },
          plugins: {
            entries: {
              "github-repositories": { enabled: false, config: { $include: "./github.json5" } },
            },
          },
        }),
      );
      await fs.writeFile(
        pluginPath,
        JSON.stringify({
          agents: { build: previous },
          repositorySearch: { useNativeCredentials: false },
          service: { host: "github.com" },
        }),
      );
      const env = { HOME: home, OPENCLAW_STATE_DIR: stateDir };
      try {
        await updateGitHubToolIdentityConfig({
          scope: "agent",
          agentId: "Build",
          expectedIdentity: previous,
          identity: { profileId: "ghp_22222222222222222222222222222222" },
        });
        const root = JSON.parse(await fs.readFile(configPath, "utf8"));
        expect(root.plugins.entries["github-repositories"]).toMatchObject({
          enabled: false,
          config: { $include: "./github.json5" },
        });
        const includedRaw = await fs.readFile(pluginPath, "utf8");
        expect(JSON.parse(includedRaw)).toMatchObject({
          agents: {
            build: { profileId: "ghp_22222222222222222222222222222222", allowInSandbox: false },
          },
          repositorySearch: { useNativeCredentials: false },
          service: { host: "github.com" },
        });
        await expect(
          updateGitHubToolIdentityConfig({
            scope: "agent",
            agentId: "Build",
            expectedIdentity: previous,
            identity: { profileId: "ghp_33333333333333333333333333333333" },
          }),
        ).rejects.toThrow("GitHub identity changed");
        expect(await fs.readFile(pluginPath, "utf8")).toBe(includedRaw);
      } finally {
        await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
      }
    },
    { env: { OPENCLAW_CONFIG_PATH: (home) => path.join(home, ".openclaw", "openclaw.json") } },
  );
});
