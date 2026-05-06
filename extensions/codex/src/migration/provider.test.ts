import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing as applyTesting } from "./apply.js";
import { buildCodexMigrationProvider } from "./provider.js";
import { __testing as sourceTesting } from "./source.js";

const tempRoots = new Set<string>();

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-migrate-codex-"));
  tempRoots.add(root);
  return root;
}

async function writeFile(filePath: string, content = ""): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function makeContext(params: {
  source: string;
  stateDir: string;
  workspaceDir: string;
  overwrite?: boolean;
  reportDir?: string;
  plugins?: string[];
  config?: MigrationProviderContext["config"];
  runtime?: MigrationProviderContext["runtime"];
}): MigrationProviderContext {
  return {
    config:
      params.config ??
      ({
        agents: {
          defaults: {
            workspace: params.workspaceDir,
          },
        },
      } as MigrationProviderContext["config"]),
    source: params.source,
    stateDir: params.stateDir,
    overwrite: params.overwrite,
    reportDir: params.reportDir,
    ...(params.plugins ? { plugins: params.plugins } : {}),
    ...(params.runtime ? { runtime: params.runtime } : {}),
    logger,
  } as MigrationProviderContext;
}

function createConfigRuntime(initialConfig: MigrationProviderContext["config"]): {
  runtime: NonNullable<MigrationProviderContext["runtime"]>;
  getConfig: () => MigrationProviderContext["config"];
} {
  let currentConfig = structuredClone(initialConfig);
  const runtime = {
    config: {
      current: () => currentConfig,
      mutateConfigFile: async (params: {
        mutate: (draft: MigrationProviderContext["config"]) => void | Promise<void>;
      }) => {
        const draft = structuredClone(currentConfig);
        await params.mutate(draft);
        currentConfig = draft;
        return { nextConfig: currentConfig };
      },
    },
  } as unknown as NonNullable<MigrationProviderContext["runtime"]>;
  return { runtime, getConfig: () => currentConfig };
}

function pluginListResponse(params: {
  gmail?: { installed?: boolean; enabled?: boolean };
  slack?: { installed?: boolean; enabled?: boolean };
  includeOtherMarketplace?: boolean;
}) {
  return {
    marketplaces: [
      {
        name: "openai-curated",
        path: "/tmp/openai-curated",
        interface: null,
        plugins: [
          {
            id: "gmail@openai-curated",
            name: "gmail",
            source: { type: "local", path: "/tmp/openai-curated/gmail" },
            installed: params.gmail?.installed ?? true,
            enabled: params.gmail?.enabled ?? true,
            installPolicy: "AVAILABLE",
            authPolicy: "ON_USE",
            availability: "AVAILABLE",
            interface: { displayName: "Gmail" },
          },
          {
            id: "slack@openai-curated",
            name: "slack",
            source: { type: "local", path: "/tmp/openai-curated/slack" },
            installed: params.slack?.installed ?? true,
            enabled: params.slack?.enabled ?? false,
            installPolicy: "AVAILABLE",
            authPolicy: "ON_USE",
            availability: "AVAILABLE",
            interface: { displayName: "Slack" },
          },
        ],
      },
      ...(params.includeOtherMarketplace
        ? [
            {
              name: "openai-primary-runtime",
              path: "/tmp/openai-primary-runtime",
              interface: null,
              plugins: [
                {
                  id: "documents@openai-primary-runtime",
                  name: "documents",
                  source: { type: "local", path: "/tmp/openai-primary-runtime/documents" },
                  installed: true,
                  enabled: true,
                  installPolicy: "AVAILABLE",
                  authPolicy: "ON_USE",
                  availability: "AVAILABLE",
                  interface: { displayName: "Documents" },
                },
              ],
            },
          ]
        : []),
    ],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  };
}

function appsListResponse(params: { accessible?: boolean; extraAppAccessible?: boolean } = {}) {
  return {
    data: [
      {
        id: "gmail",
        name: "Gmail",
        description: null,
        logoUrl: null,
        logoUrlDark: null,
        distributionChannel: null,
        branding: null,
        appMetadata: null,
        labels: null,
        installUrl: null,
        isAccessible: params.accessible ?? true,
        isEnabled: true,
        pluginDisplayNames: ["Gmail"],
      },
      ...(params.extraAppAccessible === undefined
        ? []
        : [
            {
              id: "gmail-extra",
              name: "Gmail extra",
              description: null,
              logoUrl: null,
              logoUrlDark: null,
              distributionChannel: null,
              branding: null,
              appMetadata: null,
              labels: null,
              installUrl: null,
              isAccessible: params.extraAppAccessible,
              isEnabled: true,
              pluginDisplayNames: ["Gmail"],
            },
          ]),
    ],
    nextCursor: null,
  };
}

async function createCodexFixture(): Promise<{
  root: string;
  homeDir: string;
  codexHome: string;
  stateDir: string;
  workspaceDir: string;
}> {
  const root = await makeTempRoot();
  const homeDir = path.join(root, "home");
  const codexHome = path.join(root, ".codex");
  const stateDir = path.join(root, "state");
  const workspaceDir = path.join(root, "workspace");
  vi.stubEnv("HOME", homeDir);
  sourceTesting.setAppServerRequestForTests(async () => {
    throw new Error("app-server unavailable");
  });
  await writeFile(path.join(codexHome, "skills", "tweet-helper", "SKILL.md"), "# Tweet helper\n");
  await writeFile(path.join(codexHome, "skills", ".system", "system-skill", "SKILL.md"));
  await writeFile(path.join(homeDir, ".agents", "skills", "personal-style", "SKILL.md"));
  await writeFile(
    path.join(
      codexHome,
      "plugins",
      "cache",
      "openai-primary-runtime",
      "documents",
      "1.0.0",
      ".codex-plugin",
      "plugin.json",
    ),
    JSON.stringify({ name: "documents" }),
  );
  await writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-5.5"\n');
  await writeFile(path.join(codexHome, "hooks", "hooks.json"), "{}\n");
  return { root, homeDir, codexHome, stateDir, workspaceDir };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  sourceTesting.setAppServerRequestForTests(undefined);
  applyTesting.setAppServerRequestForTests(undefined);
  for (const root of tempRoots) {
    await fs.rm(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

describe("buildCodexMigrationProvider", () => {
  it("plans Codex skills while keeping plugins and native config explicit", async () => {
    const fixture = await createCodexFixture();
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
      }),
    );

    expect(plan.providerId).toBe("codex");
    expect(plan.source).toBe(fixture.codexHome);
    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "skill:tweet-helper",
          kind: "skill",
          action: "copy",
          status: "planned",
          target: path.join(fixture.workspaceDir, "skills", "tweet-helper"),
        }),
        expect.objectContaining({
          id: "skill:personal-style",
          kind: "skill",
          action: "copy",
          status: "planned",
          target: path.join(fixture.workspaceDir, "skills", "personal-style"),
        }),
        expect.objectContaining({
          id: "plugin:documents:1",
          kind: "manual",
          action: "manual",
          status: "skipped",
        }),
        expect.objectContaining({
          id: "archive:config.toml",
          kind: "archive",
          action: "archive",
          status: "planned",
        }),
        expect.objectContaining({
          id: "archive:hooks/hooks.json",
          kind: "archive",
          action: "archive",
          status: "planned",
        }),
      ]),
    );
    expect(plan.items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "skill:system-skill" })]),
    );
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Codex app-server plugin discovery was unavailable"),
        expect.stringContaining("Cached Codex plugin bundles are manual-review fallback items"),
      ]),
    );
  });

  it("plans installed openai-curated Codex plugins for native app-server activation", async () => {
    const fixture = await createCodexFixture();
    const request = vi.fn(async (method: string) => {
      if (method === "plugin/list") {
        return pluginListResponse({ includeOtherMarketplace: true });
      }
      if (method === "app/list") {
        return appsListResponse();
      }
      throw new Error(`unexpected ${method}`);
    });
    sourceTesting.setAppServerRequestForTests(request);
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
      }),
    );

    expect(request).toHaveBeenCalledWith("plugin/list", { cwds: [] });
    expect(request).toHaveBeenCalledWith("app/list", {
      limit: 100,
      forceRefetch: true,
    });
    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "plugin:gmail",
          kind: "plugin",
          action: "install",
          status: "planned",
          details: expect.objectContaining({
            marketplaceName: "openai-curated",
            pluginName: "gmail",
          }),
        }),
        expect.objectContaining({
          id: "plugin:slack",
          kind: "plugin",
          action: "install",
          status: "planned",
          details: expect.objectContaining({
            marketplaceName: "openai-curated",
            pluginName: "slack",
          }),
        }),
        expect.objectContaining({
          id: "config:codex-enabled",
          kind: "config",
          action: "merge",
          details: expect.objectContaining({
            path: ["plugins", "entries", "codex", "enabled"],
            value: true,
          }),
        }),
      ]),
    );
    expect(plan.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "plugin:documents:1" })]),
    );
  });

  it("filters Codex plugin migration with repeated plugin selections", async () => {
    const fixture = await createCodexFixture();
    sourceTesting.setAppServerRequestForTests(async (method: string) => {
      if (method === "plugin/list") {
        return pluginListResponse({});
      }
      if (method === "app/list") {
        return appsListResponse();
      }
      throw new Error(`unexpected ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        plugins: ["gmail"],
      }),
    );

    expect(plan.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "plugin:gmail" })]),
    );
    expect(plan.items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "plugin:slack" })]),
    );
  });

  it("copies planned skills and archives native config during apply", async () => {
    const fixture = await createCodexFixture();
    const reportDir = path.join(fixture.root, "report");
    const provider = buildCodexMigrationProvider();

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        reportDir,
      }),
    );

    await expect(
      fs.access(path.join(fixture.workspaceDir, "skills", "tweet-helper", "SKILL.md")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(fixture.workspaceDir, "skills", "personal-style", "SKILL.md")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(reportDir, "archive", "config.toml")),
    ).resolves.toBeUndefined();
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "plugin:documents:1", status: "skipped" }),
        expect.objectContaining({ id: "skill:tweet-helper", status: "migrated" }),
        expect.objectContaining({ id: "archive:config.toml", status: "migrated" }),
      ]),
    );
    await expect(fs.access(path.join(reportDir, "report.json"))).resolves.toBeUndefined();
  });

  it("activates selected source-installed curated plugins natively during apply", async () => {
    const fixture = await createCodexFixture();
    sourceTesting.setAppServerRequestForTests(async (method: string) => {
      if (method === "plugin/list") {
        return pluginListResponse({});
      }
      if (method === "app/list") {
        return appsListResponse();
      }
      throw new Error(`unexpected plan ${method}`);
    });
    const applyRequest = vi.fn(async (method: string, params: unknown) => {
      if (method === "plugin/list") {
        return pluginListResponse({
          gmail: { installed: false, enabled: false },
          slack: { installed: true, enabled: false },
        });
      }
      if (method === "plugin/install") {
        return { authPolicy: "ON_USE", appsNeedingAuth: [] };
      }
      if (method === "skills/list") {
        return { data: [] };
      }
      if (method === "config/mcpServer/reload") {
        return undefined;
      }
      if (method === "app/list") {
        return appsListResponse();
      }
      throw new Error(`unexpected apply ${method} ${JSON.stringify(params)}`);
    });
    applyTesting.setAppServerRequestForTests(applyRequest);
    const config = {
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    const { runtime, getConfig } = createConfigRuntime(config);
    const provider = buildCodexMigrationProvider();
    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        plugins: ["gmail"],
        config,
      }),
    );

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        reportDir: path.join(fixture.root, "report"),
        config,
        runtime,
      }),
      plan,
    );

    expect(applyRequest).toHaveBeenCalledWith("plugin/install", {
      marketplacePath: "/tmp/openai-curated",
      pluginName: "gmail",
    });
    expect(applyRequest).not.toHaveBeenCalledWith(
      "plugin/install",
      expect.objectContaining({ pluginName: "slack" }),
    );
    expect(applyRequest).toHaveBeenCalledWith("skills/list", {
      cwds: [],
      forceReload: true,
    });
    expect(applyRequest).toHaveBeenCalledWith("config/mcpServer/reload", undefined);
    expect(applyRequest).toHaveBeenCalledWith("app/list", {
      limit: 100,
      forceRefetch: true,
    });
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "plugin:gmail", status: "migrated" }),
        expect.objectContaining({ id: "config:codex-enabled", status: "migrated" }),
      ]),
    );
    expect(getConfig()).toMatchObject({
      plugins: {
        entries: {
          codex: {
            enabled: true,
          },
        },
      },
    });
    expect(getConfig()).not.toMatchObject({
      plugins: { entries: { codex: { config: expect.anything() } } },
    });
  });

  it("merges Codex into existing plugin allowlists during apply", async () => {
    const fixture = await createCodexFixture();
    sourceTesting.setAppServerRequestForTests(async (method: string) => {
      if (method === "plugin/list") {
        return pluginListResponse({});
      }
      if (method === "app/list") {
        return appsListResponse();
      }
      throw new Error(`unexpected plan ${method}`);
    });
    applyTesting.setAppServerRequestForTests(async (method: string) => {
      if (method === "plugin/list") {
        return pluginListResponse({});
      }
      throw new Error(`unexpected apply ${method}`);
    });
    const config = {
      agents: { defaults: { workspace: fixture.workspaceDir } },
      plugins: { allow: ["browser"] },
      tools: { alsoAllow: ["browser"] },
    } as MigrationProviderContext["config"];
    const { runtime, getConfig } = createConfigRuntime(config);
    const provider = buildCodexMigrationProvider();
    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        plugins: ["gmail"],
        config,
      }),
    );

    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "config:codex-plugin-allowlist", status: "planned" }),
      ]),
    );

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        reportDir: path.join(fixture.root, "report"),
        config,
        runtime,
      }),
      plan,
    );

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "config:codex-plugin-allowlist", status: "migrated" }),
      ]),
    );
    expect(getConfig()).toMatchObject({
      plugins: { allow: ["browser", "codex"] },
      tools: { alsoAllow: ["browser"] },
    });
  });

  it("reports native plugin activation errors when app auth is still required", async () => {
    const fixture = await createCodexFixture();
    sourceTesting.setAppServerRequestForTests(async (method: string) => {
      if (method === "plugin/list") {
        return pluginListResponse({});
      }
      if (method === "app/list") {
        return appsListResponse();
      }
      throw new Error(`unexpected plan ${method}`);
    });
    const applyRequest = vi.fn(async (method: string) => {
      if (method === "plugin/list") {
        return pluginListResponse({ gmail: { installed: false, enabled: false } });
      }
      if (method === "plugin/install") {
        return {
          authPolicy: "ON_USE",
          appsNeedingAuth: [
            {
              id: "gmail",
              name: "Gmail",
              description: null,
              installUrl: "https://example.invalid/auth",
              needsAuth: true,
            },
          ],
        };
      }
      if (method === "skills/list") {
        return { data: [] };
      }
      if (method === "config/mcpServer/reload") {
        return undefined;
      }
      if (method === "app/list") {
        return appsListResponse();
      }
      throw new Error(`unexpected apply ${method}`);
    });
    applyTesting.setAppServerRequestForTests(applyRequest);
    const config = {
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    const { runtime } = createConfigRuntime(config);
    const provider = buildCodexMigrationProvider();
    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        plugins: ["gmail"],
        config,
      }),
    );

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        reportDir: path.join(fixture.root, "report"),
        config,
        runtime,
      }),
      plan,
    );

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "plugin:gmail",
          status: "error",
          reason: expect.stringContaining("requires app authorization"),
        }),
        expect.objectContaining({ id: "config:codex-enabled", status: "migrated" }),
      ]),
    );
  });

  it("reports native plugin activation errors when an already-installed app is inaccessible", async () => {
    const fixture = await createCodexFixture();
    sourceTesting.setAppServerRequestForTests(async (method: string) => {
      if (method === "plugin/list") {
        return pluginListResponse({});
      }
      if (method === "app/list") {
        return appsListResponse({ accessible: false });
      }
      throw new Error(`unexpected plan ${method}`);
    });
    const applyRequest = vi.fn(async (method: string) => {
      if (method === "plugin/list") {
        return pluginListResponse({});
      }
      throw new Error(`unexpected apply ${method}`);
    });
    applyTesting.setAppServerRequestForTests(applyRequest);
    const config = {
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    const { runtime } = createConfigRuntime(config);
    const provider = buildCodexMigrationProvider();
    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        plugins: ["gmail"],
        config,
      }),
    );

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        reportDir: path.join(fixture.root, "report"),
        config,
        runtime,
      }),
      plan,
    );

    expect(applyRequest).not.toHaveBeenCalledWith("plugin/install", expect.anything());
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "plugin:gmail",
          status: "error",
          reason: expect.stringContaining("app is not accessible"),
        }),
        expect.objectContaining({ id: "config:codex-enabled", status: "migrated" }),
      ]),
    );
  });

  it("reports native plugin activation errors when any related app is inaccessible", async () => {
    const fixture = await createCodexFixture();
    sourceTesting.setAppServerRequestForTests(async (method: string) => {
      if (method === "plugin/list") {
        return pluginListResponse({});
      }
      if (method === "app/list") {
        return appsListResponse({ accessible: true, extraAppAccessible: false });
      }
      throw new Error(`unexpected plan ${method}`);
    });
    applyTesting.setAppServerRequestForTests(async (method: string) => {
      if (method === "plugin/list") {
        return pluginListResponse({});
      }
      throw new Error(`unexpected apply ${method}`);
    });
    const config = {
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    const { runtime } = createConfigRuntime(config);
    const provider = buildCodexMigrationProvider();
    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        plugins: ["gmail"],
        config,
      }),
    );

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        reportDir: path.join(fixture.root, "report"),
        config,
        runtime,
      }),
      plan,
    );

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "plugin:gmail",
          status: "error",
          reason: expect.stringContaining("app is not accessible"),
        }),
        expect.objectContaining({ id: "config:codex-enabled", status: "migrated" }),
      ]),
    );
  });

  it("does not call plugin install during dry-run planning", async () => {
    const fixture = await createCodexFixture();
    const request = vi.fn(async (method: string) => {
      if (method === "plugin/list") {
        return pluginListResponse({ gmail: { installed: false, enabled: false } });
      }
      if (method === "app/list") {
        return appsListResponse();
      }
      if (method === "plugin/install") {
        throw new Error("dry-run must not install");
      }
      throw new Error(`unexpected ${method}`);
    });
    sourceTesting.setAppServerRequestForTests(request);
    const provider = buildCodexMigrationProvider();

    await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
      }),
    );

    expect(request).not.toHaveBeenCalledWith("plugin/install", expect.anything());
  });

  it("reports existing skill targets as conflicts unless overwrite is set", async () => {
    const fixture = await createCodexFixture();
    await writeFile(path.join(fixture.workspaceDir, "skills", "tweet-helper", "SKILL.md"));
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
      }),
    );
    const overwritePlan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        overwrite: true,
      }),
    );

    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "skill:tweet-helper", status: "conflict" }),
      ]),
    );
    expect(overwritePlan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "skill:tweet-helper", status: "planned" }),
      ]),
    );
  });
});
