// Register native mocks before migration modules load.
// oxfmt-ignore
import {
  appServerRequest,
  sourceAppServerClientScope,
  createCodexFixture,
  createCodexTestRoot,
  createConfigRuntime,
  createFailingConfigRuntime,
  expectRecordFields,
  fakeJwt,
  findItem,
  loadTargetAuthStore,
  makeContext,
  writeFile,
} from "./provider.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { defaultCodexAppInventoryCache } from "../app-server/app-inventory-cache.js";
import { codexAppInventoryResponse } from "../app-server/app-inventory.test-helpers.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "../app-server/config.js";
import { buildCodexPluginAppCacheKey } from "../app-server/plugin-app-cache-key.js";
import { pluginList, pluginSummary } from "../app-server/plugin-inventory.test-helpers.js";
import type { CodexGetAccountResponse, v2 } from "../app-server/protocol.js";
import { buildCodexMigrationProvider } from "./provider.js";
import { discoverCodexSource } from "./source.js";

describe("buildCodexMigrationProvider", () => {
  it("preserves whitespace in nonempty CODEX_HOME values", async () => {
    const root = await createCodexTestRoot();
    const codexHome = path.join(root, " spaced ");
    await writeFile(path.join(codexHome, "memories", "MEMORY.md"), "# Memory\n");
    vi.stubEnv("CODEX_HOME", codexHome);

    const source = await discoverCodexSource({ memoryOnly: true });

    expect(source.codexHome).toBe(codexHome);
    expect(source.memoryFiles.map((entry) => entry.path)).toEqual([
      path.join(codexHome, "memories", "MEMORY.md"),
    ]);
  });

  it("plans and imports only consolidated Codex memory into the selected agent", async () => {
    const fixture = await createCodexFixture();
    const targetWorkspace = path.join(fixture.root, "workspace-research");
    const reportDir = path.join(fixture.root, "report");
    await writeFile(path.join(fixture.codexHome, "memories", "MEMORY.md"), "# Memory\n");
    await writeFile(path.join(fixture.codexHome, "memories", "memory_summary.md"), "# Summary\n");
    await writeFile(
      path.join(fixture.codexHome, "memories", "rollout_summaries", "private.md"),
      "# Raw rollout\n",
    );
    const config = {
      agents: {
        defaults: { workspace: fixture.workspaceDir },
        list: [
          { id: "main", default: true },
          { id: "research", workspace: targetWorkspace },
        ],
      },
    } as MigrationProviderContext["config"];
    const context = makeContext({
      source: fixture.codexHome,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      reportDir,
      config,
      targetAgentId: "research",
      itemKinds: ["memory"],
      verifyPluginApps: true,
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(context);

    expect(appServerRequest).not.toHaveBeenCalled();
    expect(plan.items.map((item) => item.id)).toEqual([
      "memory:codex:MEMORY.md",
      "memory:codex:memory_summary.md",
    ]);
    expect(plan.items.every((item) => item.kind === "memory")).toBe(true);
    expect(plan.items.every((item) => item.target?.startsWith(targetWorkspace))).toBe(true);

    const result = await provider.apply(context, plan);

    expect(result.summary).toMatchObject({ migrated: 2, errors: 0, conflicts: 0 });
    await expect(
      fs.readFile(path.join(targetWorkspace, "memory", "imports", "codex", "MEMORY.md"), "utf8"),
    ).resolves.toBe("# Memory\n");
    await expect(
      fs.access(path.join(targetWorkspace, "memory", "imports", "codex", "private.md")),
    ).rejects.toThrow();
  });

  it("skips unrelated Codex app-server preparation for memory-only imports", async () => {
    const fixture = await createCodexFixture();
    const provider = buildCodexMigrationProvider();
    const preparation = provider.prepareApply?.(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        itemKinds: ["memory"],
      }),
    );

    expect(preparation).toBeUndefined();
  });

  it("rejects non-file Codex consolidated memory candidates", async () => {
    const fixture = await createCodexFixture();
    await fs.mkdir(path.join(fixture.codexHome, "memories", "MEMORY.md"), {
      recursive: true,
    });
    const provider = buildCodexMigrationProvider();

    await expect(
      provider.plan(
        makeContext({
          source: fixture.codexHome,
          stateDir: fixture.stateDir,
          workspaceDir: fixture.workspaceDir,
          itemKinds: ["memory"],
        }),
      ),
    ).rejects.toThrow("must be a regular file");
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlinked Codex consolidated memory candidates",
    async () => {
      const fixture = await createCodexFixture();
      const actualMemory = path.join(fixture.root, "actual-memory.md");
      const memoryPath = path.join(fixture.codexHome, "memories", "MEMORY.md");
      await writeFile(actualMemory, "# Memory\n");
      await fs.mkdir(path.dirname(memoryPath), { recursive: true });
      await fs.symlink(actualMemory, memoryPath);
      const provider = buildCodexMigrationProvider();

      await expect(
        provider.plan(
          makeContext({
            source: fixture.codexHome,
            stateDir: fixture.stateDir,
            workspaceDir: fixture.workspaceDir,
            itemKinds: ["memory"],
          }),
        ),
      ).rejects.toThrow("must not be a symbolic link");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked import destination that resolves into Codex memory",
    async () => {
      const fixture = await createCodexFixture();
      const memoryDir = path.join(fixture.codexHome, "memories");
      await writeFile(path.join(memoryDir, "MEMORY.md"), "# Memory\n");
      await fs.mkdir(fixture.workspaceDir, { recursive: true });
      await fs.symlink(memoryDir, path.join(fixture.workspaceDir, "memory"));
      const provider = buildCodexMigrationProvider();

      await expect(
        provider.plan(
          makeContext({
            source: fixture.codexHome,
            stateDir: fixture.stateDir,
            workspaceDir: fixture.workspaceDir,
            itemKinds: ["memory"],
          }),
        ),
      ).rejects.toThrow("destination must stay in the selected workspace");
    },
  );

  it.runIf(process.platform !== "win32")(
    "marks a dangling Codex memory destination symlink as a conflict",
    async () => {
      const fixture = await createCodexFixture();
      const target = path.join(fixture.workspaceDir, "memory", "imports", "codex", "MEMORY.md");
      await writeFile(path.join(fixture.codexHome, "memories", "MEMORY.md"), "# Memory\n");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(path.join(fixture.root, "missing-memory.md"), target);
      const provider = buildCodexMigrationProvider();

      const plan = await provider.plan(
        makeContext({
          source: fixture.codexHome,
          stateDir: fixture.stateDir,
          workspaceDir: fixture.workspaceDir,
          itemKinds: ["memory"],
          overwrite: true,
        }),
      );

      expect(findItem(plan.items, "memory:codex:MEMORY.md")).toMatchObject({
        status: "conflict",
        reason: "target is not a regular file",
      });
    },
  );

  it("plans Codex skills while keeping plugins and native config explicit", async () => {
    const fixture = await createCodexFixture();
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
      }),
    );

    expect(plan.providerId).toBe("codex");
    expect(plan.source).toBe(fixture.codexHome);
    expectRecordFields(findItem(plan.items, "skill:tweet-helper"), {
      kind: "skill",
      action: "copy",
      status: "planned",
      target: path.join(fixture.workspaceDir, "skills", "tweet-helper"),
    });
    expectRecordFields(findItem(plan.items, "skill:personal-style"), {
      kind: "skill",
      action: "copy",
      status: "planned",
      target: path.join(fixture.workspaceDir, "skills", "personal-style"),
    });
    expectRecordFields(findItem(plan.items, "plugin:documents:1"), {
      kind: "manual",
      action: "manual",
      status: "skipped",
    });
    expectRecordFields(findItem(plan.items, "archive:config.toml"), {
      kind: "archive",
      action: "archive",
      status: "planned",
    });
    expectRecordFields(findItem(plan.items, "archive:hooks/hooks.json"), {
      kind: "archive",
      action: "archive",
      status: "planned",
    });
    expect(plan.items.some((item) => item.id === "skill:system-skill")).toBe(false);
  });

  it("plans source-installed curated plugins without installing during dry-run", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("google-calendar", { installed: true, enabled: true }),
        ]);
      }
      if (method === "plugin/read") {
        return pluginRead("google-calendar");
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
      }),
    );

    expect(appServerRequest).toHaveBeenCalledTimes(2);
    expect(sourceAppServerClientScope).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(appServerRequest), {
      method: "plugin/installed",
      requestParams: { cwds: [] },
    });
    expectRecordFields((mockCallArg(appServerRequest) as { startOptions?: unknown }).startOptions, {
      command: "codex",
      commandSource: "managed",
      managedCommandOrder: "desktop-first",
      env: {
        CODEX_HOME: fixture.codexHome,
        HOME: path.dirname(fixture.codexHome),
      },
    });
    expect(
      appServerRequest.mock.calls.some(
        ([arg]) => (arg as { method?: string }).method === "plugin/install",
      ),
    ).toBe(false);
    const pluginItem = findItem(plan.items, "plugin:google-calendar");
    expectRecordFields(pluginItem, {
      kind: "plugin",
      action: "install",
      status: "planned",
    });
    expectRecordFields(pluginItem.details, {
      configKey: "google-calendar",
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
      pluginName: "google-calendar",
    });
    expectRecordFields(findItem(plan.items, "config:codex-plugins"), {
      kind: "config",
      action: "merge",
      status: "planned",
    });
  });

  it("migrates valid curated plugins when an unrelated marketplace fails", async () => {
    const fixture = await createCodexFixture();
    const installed = {
      marketplaces: pluginList([
        pluginSummary("google-calendar", { installed: true, enabled: true }),
      ]).marketplaces,
      marketplaceLoadErrors: [
        {
          marketplacePath: "/marketplaces/broken-custom/.claude-plugin/marketplace.json",
          message: "unrelated custom marketplace is unavailable",
        },
      ],
    } satisfies v2.PluginInstalledResponse;
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed") {
        return installed;
      }
      if (method === "plugin/read") {
        return pluginRead("google-calendar");
      }
      throw new Error(`unexpected request ${method}`);
    });

    const source = await discoverCodexSource({
      input: fixture.codexHome,
      evaluatePluginMigrationEligibility: true,
    });

    expect(source.pluginDiscoveryError).toBeUndefined();
    expect(source.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginName: "google-calendar",
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          migratable: true,
        }),
      ]),
    );
    expect(sourceAppServerClientScope).toHaveBeenCalledTimes(1);
  });

  it("discovers installed plugins from the API-key curated marketplace", async () => {
    const { codexHome } = await createCodexFixture();
    const marketplacePath = path.join(
      codexHome,
      ".tmp/plugins/.agents/plugins/api_marketplace.json",
    );
    appServerRequest
      .mockResolvedValueOnce({
        marketplaces: pluginList(
          [
            pluginSummary("google-calendar@openai-api-curated", {
              name: "google-calendar",
              installed: true,
              enabled: true,
            }),
          ],
          { name: "openai-api-curated", path: marketplacePath },
        ).marketplaces,
        marketplaceLoadErrors: [],
      })
      .mockResolvedValueOnce(pluginRead("google-calendar"));

    const source = await discoverCodexSource({
      input: codexHome,
      evaluatePluginMigrationEligibility: true,
    });

    expect(source.pluginDiscoveryError).toBeUndefined();
    expectRecordFields(
      source.plugins.find((plugin) => plugin.pluginName === "google-calendar"),
      { marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME, migratable: true },
    );
    expect(appServerRequest.mock.calls.map(([request]) => request.method)).toEqual([
      "plugin/installed",
      "plugin/read",
    ]);
    expect(mockCallArg(appServerRequest, 1).requestParams).toEqual({
      marketplacePath,
      pluginName: "google-calendar",
    });
  });

  it("ignores unrelated marketplace errors when no curated plugins are installed", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed") {
        return {
          marketplaces: [],
          marketplaceLoadErrors: [
            {
              marketplacePath: "/marketplaces/broken-custom/.agents/plugins/marketplace.json",
              message: "unrelated custom marketplace is unavailable",
            },
          ],
        } satisfies v2.PluginInstalledResponse;
      }
      throw new Error(`unexpected request ${method}`);
    });

    const source = await discoverCodexSource({ input: fixture.codexHome });

    expect(source.pluginDiscoveryError).toBeUndefined();
    expect(source.plugins.every((plugin) => plugin.marketplaceName === undefined)).toBe(true);
    expect(sourceAppServerClientScope).toHaveBeenCalledTimes(1);
    expect(appServerRequest).toHaveBeenCalledTimes(1);
  });

  // Codex reports load failures by manifest file path under the curated sync
  // root `<codexHome>/.tmp/plugins`; cover both curated manifest variants.
  it.each([[".agents/plugins/marketplace.json"], [".agents/plugins/api_marketplace.json"]])(
    "fails closed when the curated %s manifest cannot load",
    async (manifestRelativePath) => {
      const fixture = await createCodexFixture();
      appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
        if (method === "plugin/installed") {
          return {
            marketplaces: [],
            marketplaceLoadErrors: [
              {
                marketplacePath: path.join(fixture.codexHome, ".tmp/plugins", manifestRelativePath),
                message: "curated marketplace is unavailable",
              },
            ],
          } satisfies v2.PluginInstalledResponse;
        }
        throw new Error(`unexpected request ${method}`);
      });

      const source = await discoverCodexSource({ input: fixture.codexHome });

      expect(source.pluginDiscoveryError).toBe("curated marketplace is unavailable");
      expect(source.plugins.some((plugin) => plugin.marketplaceName !== undefined)).toBe(false);
      expect(sourceAppServerClientScope).toHaveBeenCalledTimes(1);
    },
  );

  it("does not trust a curated marketplace that reports its own load error", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed") {
        return {
          marketplaces: pluginList([
            pluginSummary("google-calendar", { installed: true, enabled: true }),
          ]).marketplaces,
          marketplaceLoadErrors: [
            {
              marketplacePath: path.join(
                fixture.codexHome,
                ".tmp/plugins/.agents/plugins/marketplace.json",
              ),
              message: "curated marketplace was only partially loaded",
            },
          ],
        } satisfies v2.PluginInstalledResponse;
      }
      throw new Error(`unexpected request ${method}`);
    });

    const source = await discoverCodexSource({ input: fixture.codexHome });

    expect(source.pluginDiscoveryError).toBe("curated marketplace was only partially loaded");
    expect(source.plugins.some((plugin) => plugin.marketplaceName !== undefined)).toBe(false);
  });

  it("prefers remotely installed curated plugins and reads their opaque source id", async () => {
    const fixture = await createCodexFixture();
    const remotePluginId = "plugins~Plugin_11111111111111111111111111111111";
    const local = pluginSummary("linear@openai-curated", {
      name: "linear",
      installed: true,
      enabled: true,
    });
    const remote = pluginSummary("linear@openai-curated-remote", {
      name: "linear",
      remotePluginId,
      installed: true,
      enabled: true,
    });
    appServerRequest.mockImplementation(
      async ({ method, requestParams }: { method: string; requestParams?: unknown }) => {
        if (method === "plugin/installed") {
          return {
            marketplaces: [
              {
                name: CODEX_PLUGINS_MARKETPLACE_NAME,
                path: "/marketplaces/openai-curated",
                interface: null,
                plugins: [local],
              },
              {
                name: `${CODEX_PLUGINS_MARKETPLACE_NAME}-remote`,
                path: null,
                interface: null,
                plugins: [remote],
              },
            ],
            marketplaceLoadErrors: [],
          } satisfies v2.PluginInstalledResponse;
        }
        if (method === "plugin/read") {
          expect(requestParams).toEqual({
            remoteMarketplaceName: `${CODEX_PLUGINS_MARKETPLACE_NAME}-remote`,
            pluginName: remotePluginId,
          });
          return pluginRead("linear");
        }
        throw new Error(`unexpected request ${method}`);
      },
    );
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
      }),
    );

    expect(plan.items.filter((item) => item.id === "plugin:linear")).toHaveLength(1);
    expectRecordFields(findItem(plan.items, "plugin:linear"), {
      action: "install",
      status: "planned",
    });
    expectRecordFields(findItem(plan.items, "plugin:linear").details, {
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
      pluginName: "linear",
    });
    expect(sourceAppServerClientScope).toHaveBeenCalledTimes(1);
    expect(appServerRequest.mock.calls.map(([request]) => request.method)).toEqual([
      "plugin/installed",
      "plugin/read",
    ]);
  });

  it("fails closed when a remotely installed plugin omits its opaque source id", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed") {
        return {
          marketplaces: [
            {
              name: `${CODEX_PLUGINS_MARKETPLACE_NAME}-remote`,
              path: null,
              interface: null,
              plugins: [
                pluginSummary("linear@openai-curated-remote", {
                  name: "linear",
                  remotePluginId: null,
                  installed: true,
                  enabled: true,
                }),
              ],
            },
          ],
          marketplaceLoadErrors: [],
        } satisfies v2.PluginInstalledResponse;
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
      }),
    );

    expect(plan.items.some((item) => item.id === "plugin:linear")).toBe(false);
    expectRecordFields(findItemByReason(plan.items, "plugin_read_unavailable"), {
      action: "manual",
      status: "skipped",
    });
    expect(appServerRequest.mock.calls.map(([request]) => request.method)).toEqual([
      "plugin/installed",
    ]);
    expect(sourceAppServerClientScope).toHaveBeenCalledTimes(1);
  });

  it("imports Codex auth.json OAuth into the selected agent and seeds cached models", async () => {
    const fixture = await createCodexFixture();
    const reportDir = path.join(fixture.root, "report");
    const configState: MigrationProviderContext["config"] = {
      agents: {
        defaults: {
          model: { fallbacks: [] },
          workspace: fixture.workspaceDir,
        },
        list: [{ id: "main", default: true }, { id: "research" }],
      },
    } as MigrationProviderContext["config"];
    const accessToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: "codex@example.test" },
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_test",
        chatgpt_plan_type: "plus",
      },
    });
    await writeFile(
      path.join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-test-token",
          id_token: "id-test-token",
          account_id: "acct_test",
        },
      }),
    );
    await writeFile(
      path.join(fixture.codexHome, "models_cache.json"),
      JSON.stringify({ models: [{ slug: "gpt-5.5" }, { slug: "gpt-5.4-mini" }] }),
    );
    const provider = buildCodexMigrationProvider();

    const skippedPlan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
      }),
    );
    expectRecordFields(findItem(skippedPlan.items, "auth:openai"), {
      kind: "auth",
      status: "skipped",
      sensitive: true,
    });

    const ctx = makeContext({
      source: fixture.codexHome,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      config: configState,
      runtime: createConfigRuntime(configState),
      reportDir,
      includeSecrets: true,
      targetAgentId: "research",
    });
    const plan = await provider.plan(ctx);
    expectRecordFields(findItem(plan.items, "auth:openai"), {
      kind: "auth",
      status: "planned",
      sensitive: true,
    });

    const result = await provider.apply(ctx, plan);

    expectRecordFields(findItem(result.items, "auth:openai"), { status: "migrated" });
    const authStore = loadTargetAuthStore(fixture, "research");
    expect(authStore.profiles?.["openai:account-acct_test"]).toEqual(
      expect.objectContaining({
        type: "oauth",
        provider: "openai",
        access: accessToken,
        refresh: "refresh-test-token",
      }),
    );
    expect(loadTargetAuthStore(fixture).profiles?.["openai:account-acct_test"]).toBeUndefined();
    expect(configState.auth?.profiles?.["openai:account-acct_test"]).toEqual(
      expect.objectContaining({
        provider: "openai",
        mode: "oauth",
      }),
    );
    expect(configState.agents?.defaults?.models?.["openai/gpt-5.4-mini"]).toEqual({});
    expect(configState.agents?.defaults?.models?.["openai/gpt-5.5"]).toEqual({});
    expect(configState.agents?.defaults?.models?.["openai/gpt-6-astra"]).toEqual({});
    expect(configState.agents?.defaults?.model).toEqual({
      fallbacks: [],
      primary: "openai/gpt-6-astra",
    });
  });

  it("returns Codex auth config patches without direct config writes in return mode", async () => {
    const fixture = await createCodexFixture();
    const reportDir = path.join(fixture.root, "report");
    const accessToken = fakeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_test",
      },
      "https://api.openai.com/profile": {
        email: "codex@example.test",
      },
    });
    await writeFile(
      path.join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-test-token",
          account_id: "acct_test",
        },
      }),
    );
    await writeFile(
      path.join(fixture.codexHome, "models_cache.json"),
      JSON.stringify({ models: [{ slug: "gpt-5.5" }, { slug: "gpt-5.4-mini" }] }),
    );
    const configState: MigrationProviderContext["config"] = {
      agents: {
        defaults: {
          workspace: fixture.workspaceDir,
        },
      },
    };
    const provider = buildCodexMigrationProvider();
    const ctx = makeContext({
      source: fixture.codexHome,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      config: configState,
      runtime: createFailingConfigRuntime(configState),
      reportDir,
      includeSecrets: true,
      providerOptions: { configPatchMode: "return" },
    });
    const plan = await provider.plan(ctx);

    const result = await provider.apply(ctx, plan);

    expect(findItem(result.items, "auth:openai").details).toEqual(
      expect.objectContaining({
        configUpdated: false,
        configPatchReturned: true,
      }),
    );
    expect(findItem(result.items, "auth:openai:config:auth")).toEqual(
      expect.objectContaining({
        kind: "config",
        action: "merge",
        status: "migrated",
        details: expect.objectContaining({
          path: ["auth"],
          value: expect.objectContaining({
            profiles: expect.objectContaining({
              "openai:account-acct_test": expect.objectContaining({
                provider: "openai",
                mode: "oauth",
              }),
            }),
          }),
        }),
      }),
    );
    expect(findItem(result.items, "auth:openai:config:agents-defaults")).toEqual(
      expect.objectContaining({
        kind: "config",
        action: "merge",
        status: "migrated",
        details: expect.objectContaining({
          path: ["agents", "defaults"],
          value: expect.objectContaining({
            model: { primary: "openai/gpt-6-astra" },
            models: expect.objectContaining({
              "openai/gpt-5.4-mini": {},
              "openai/gpt-5.5": {},
              "openai/gpt-6-astra": {},
            }),
          }),
        }),
      }),
    );
    expect(configState.auth).toBeUndefined();
    expect(configState.agents?.defaults?.model).toBeUndefined();
  });

  it.each([
    {
      state: "missing from the committed installed runtime",
      installedApp: undefined,
      metadataAvailable: true,
      reason: "app_missing",
      expectedApp: { id: "asdk_app_readwise", name: "Readwise" },
    },
    {
      state: "disabled in the committed runtime despite authorized metadata",
      metadataAvailable: true,
      installedApp: {
        id: "asdk_app_readwise",
        runtimeName: "Readwise",
        enabled: false,
        callable: false,
      } satisfies v2.InstalledApp,
      reason: "app_disabled",
      expectedApp: {
        id: "asdk_app_readwise",
        name: "Readwise",
        isAccessible: true,
        isEnabled: false,
      },
    },
    {
      state: "enabled but not callable in the committed runtime",
      metadataAvailable: true,
      installedApp: {
        id: "asdk_app_readwise",
        runtimeName: "Readwise",
        enabled: true,
        callable: false,
      } satisfies v2.InstalledApp,
      reason: "app_inaccessible",
      expectedApp: {
        id: "asdk_app_readwise",
        name: "Readwise",
        isAccessible: false,
        isEnabled: true,
        isCallable: false,
      },
    },
    {
      state: "disabled in the committed runtime with missing metadata",
      installedApp: {
        id: "asdk_app_readwise",
        runtimeName: "Readwise",
        enabled: false,
        callable: false,
      } satisfies v2.InstalledApp,
      metadataAvailable: false,
      reason: "app_disabled",
      expectedApp: { id: "asdk_app_readwise", name: "Readwise", isEnabled: false },
    },
  ])(
    "fails closed when an authorized source app is $state",
    async ({ installedApp, metadataAvailable, reason, expectedApp }) => {
      const fixture = await createCodexFixture();
      appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
        if (method === "plugin/installed") {
          return pluginMetadata(method, [
            pluginSummary("readwise", { installed: true, enabled: true }),
          ]);
        }
        if (method === "plugin/read") {
          return pluginRead("readwise", [pluginApp("asdk_app_readwise", { name: "Readwise" })]);
        }
        if (method === "account/read") {
          return chatGptAccount();
        }
        if (method === "app/installed") {
          return { apps: installedApp ? [installedApp] : [] } satisfies v2.AppsInstalledResponse;
        }
        if (method === "app/read") {
          return codexAppInventoryResponse(
            "app/read",
            metadataAvailable ? [appInfo("asdk_app_readwise", { name: "Readwise" })] : [],
          );
        }
        throw new Error(`unexpected request ${method}`);
      });
      const provider = buildCodexMigrationProvider();

      const plan = await provider.plan(
        makeContext({
          source: fixture.codexHome,
          stateDir: fixture.stateDir,
          workspaceDir: fixture.workspaceDir,
          verifyPluginApps: true,
        }),
      );

      expect(plan.items.some((item) => item.id === "plugin:readwise")).toBe(false);
      expect(plan.items.some((item) => item.id === "config:codex-plugins")).toBe(false);
      const manualItem = findItemByReason(plan.items, reason);
      expectRecordFields(manualItem, { reason, status: "skipped" });
      expectRecordFields(manualItem.details, {
        pluginName: "readwise",
        marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
        apps: [expectedApp],
      });
      if (installedApp?.enabled && !installedApp.callable) {
        expect(manualItem.message).toEqual(expect.stringContaining("not callable"));
      }
      expect(sourceAppServerClientScope).toHaveBeenCalledTimes(1);
    },
  );

  it("reports installed apps without authorized metadata as inaccessible", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("readwise", { installed: true, enabled: true }),
        ]);
      }
      if (method === "plugin/read") {
        return pluginRead("readwise", [pluginApp("asdk_app_readwise", { name: "Readwise" })]);
      }
      if (method === "account/read") {
        return chatGptAccount();
      }
      if (method === "app/installed") {
        return codexAppInventoryResponse(method, [
          appInfo("asdk_app_readwise", { name: "Readwise" }),
        ]);
      }
      if (method === "app/read") {
        return codexAppInventoryResponse(method, []);
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
      }),
    );

    const manualItem = findItemByReason(plan.items, "app_inaccessible");
    expectRecordFields(manualItem, {
      reason: "app_inaccessible",
      status: "skipped",
    });
    expectRecordFields(manualItem.details, {
      pluginName: "readwise",
      apps: [
        {
          id: "asdk_app_readwise",
          name: "Readwise",
          isAccessible: false,
          isEnabled: true,
        },
      ],
    });
    expect(plan.items.some((item) => item.id === "plugin:readwise")).toBe(false);
  });

  it("plans app-backed plugins without source app inventory by default", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [pluginSummary("gmail", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("gmail", [pluginApp("app-gmail", { name: "Gmail" })]);
      }
      if (method === "account/read") {
        return chatGptAccount();
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
      }),
    );

    expectRecordFields(findItem(plan.items, "plugin:gmail"), {
      kind: "plugin",
      action: "install",
      status: "planned",
    });
    expectRecordFields(findItem(plan.items, "config:codex-plugins"), {
      kind: "config",
      action: "merge",
      status: "planned",
    });
    expect(plan.warnings).toEqual([]);
    expect(
      appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/installed"),
    ).toHaveLength(0);
  });

  it("warns and skips app-backed plugins when source Codex account is not ChatGPT subscription auth", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [pluginSummary("gmail", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("gmail", [pluginApp("app-gmail", { name: "Gmail" })]);
      }
      if (method === "account/read") {
        return {
          account: { type: "apiKey" },
          requiresOpenaiAuth: true,
        } satisfies CodexGetAccountResponse;
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
      }),
    );

    expect(plan.items.some((item) => item.id === "plugin:gmail")).toBe(false);
    expect(plan.items.some((item) => item.id === "config:codex-plugins")).toBe(false);
    const manualItem = findItemByReason(plan.items, "codex_subscription_required");
    expectRecordFields(manualItem, {
      kind: "manual",
      action: "manual",
      status: "skipped",
      reason: "codex_subscription_required",
    });
    const details = expectRecordFields(manualItem.details, {
      pluginName: "gmail",
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
    });
    expect(details).not.toHaveProperty("code");
    expect(details.apps).toEqual([
      {
        id: "app-gmail",
        name: "Gmail",
      },
    ]);
    expect(plan.warnings).toEqual([
      "Codex app-backed plugin migration requires the Codex app-server source account to be logged in with a ChatGPT subscription account. Log in to the Codex app with subscription auth; OpenClaw auth or API-key auth does not satisfy Codex app connector access.",
    ]);
    expect(
      appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/installed"),
    ).toHaveLength(0);
  });

  it.each([
    { name: "missing", account: null },
    { name: "malformed", account: { type: "unknown" } },
  ])(
    "reports an unavailable source account when Codex returns a $name account",
    async ({ account }) => {
      const fixture = await createCodexFixture();
      appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
        if (method === "plugin/installed" || method === "plugin/list") {
          return pluginMetadata(method, [
            pluginSummary("gmail", { installed: true, enabled: true }),
          ]);
        }
        if (method === "plugin/read") {
          return pluginRead("gmail", [pluginApp("app-gmail", { name: "Gmail" })]);
        }
        if (method === "account/read") {
          const response: unknown = {
            account,
            requiresOpenaiAuth: true,
          };
          return response;
        }
        throw new Error(`unexpected request ${method}`);
      });
      const provider = buildCodexMigrationProvider();

      const plan = await provider.plan(
        makeContext({
          source: fixture.codexHome,
          stateDir: fixture.stateDir,
          workspaceDir: fixture.workspaceDir,
        }),
      );

      expect(plan.items.some((item) => item.id === "plugin:gmail")).toBe(false);
      expect(plan.items.some((item) => item.id === "config:codex-plugins")).toBe(false);
      const manualItem = findItemByReason(plan.items, "codex_account_unavailable");
      expectRecordFields(manualItem, {
        reason: "codex_account_unavailable",
        status: "skipped",
      });
      expectRecordFields(manualItem.details, {
        error: "Codex app-server did not report an authenticated source account.",
      });
      expect(plan.warnings).toEqual([]);
      expect(
        appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/installed"),
      ).toHaveLength(0);
    },
  );

  it("verifies source apps when account metadata is unavailable for backend auth", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [pluginSummary("gmail", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("gmail", [pluginApp("app-gmail", { name: "Gmail" })]);
      }
      if (method === "account/read") {
        return {
          account: null,
          requiresOpenaiAuth: true,
        } satisfies CodexGetAccountResponse;
      }
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, [appInfo("app-gmail")]);
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
      }),
    );

    expectRecordFields(findItem(plan.items, "plugin:gmail"), {
      kind: "plugin",
      action: "install",
      status: "planned",
    });
    expect(
      appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/installed"),
    ).toHaveLength(1);
  });

  it("falls through to app inventory when source account read fails and app verification is requested", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [pluginSummary("gmail", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("gmail", [pluginApp("app-gmail", { name: "Gmail" })]);
      }
      if (method === "account/read") {
        throw new Error("account unavailable");
      }
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, [appInfo("app-gmail")]);
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
      }),
    );

    expectRecordFields(findItem(plan.items, "plugin:gmail"), {
      kind: "plugin",
      action: "install",
      status: "planned",
    });
    expect(
      appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/installed"),
    ).toHaveLength(1);
  });

  it("skips app-backed plugins by default when source account read fails", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [pluginSummary("gmail", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("gmail", [pluginApp("app-gmail", { name: "Gmail" })]);
      }
      if (method === "account/read") {
        throw new Error("account unavailable");
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
      }),
    );

    expect(plan.items.some((item) => item.id === "plugin:gmail")).toBe(false);
    expect(plan.items.some((item) => item.id === "config:codex-plugins")).toBe(false);
    const manualItem = findItemByReason(plan.items, "codex_account_unavailable");
    expectRecordFields(manualItem, {
      kind: "manual",
      action: "manual",
      reason: "codex_account_unavailable",
      status: "skipped",
    });
    expectRecordFields(manualItem.details, { error: "account unavailable" });
    expect(
      appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/installed"),
    ).toHaveLength(0);
  });

  it("reads source plugin readiness with native source auth instead of target agent auth", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("google-calendar", { installed: true, enabled: true }),
        ]);
      }
      if (method === "plugin/read") {
        return pluginRead("google-calendar", [
          pluginApp("app-google-calendar", { name: "Google Calendar" }),
        ]);
      }
      if (method === "account/read") {
        return chatGptAccount();
      }
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, [appInfo("app-google-calendar")]);
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
        config: {
          agents: {
            defaults: {
              workspace: fixture.workspaceDir,
            },
          },
          auth: {
            order: {
              openai: ["openai:target"],
            },
          },
        } as MigrationProviderContext["config"],
      }),
    );

    expect(appServerRequest).toHaveBeenCalledTimes(5);
    for (const [arg] of appServerRequest.mock.calls) {
      expect(arg.authProfileId).toBeNull();
      expect(arg.isolated).toBe(true);
      expect(arg.startOptions?.env).toEqual({
        CODEX_HOME: fixture.codexHome,
        HOME: path.dirname(fixture.codexHome),
      });
      expect(arg).not.toHaveProperty("agentDir");
      expect(arg).not.toHaveProperty("config");
    }
  });

  it("reports inaccessible before missing when multiple owned apps are blocked", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("readwise", { installed: true, enabled: true }),
        ]);
      }
      if (method === "plugin/read") {
        return pluginRead("readwise", [
          pluginApp("asdk_app_readwise", { name: "Readwise" }),
          pluginApp("asdk_app_reader", { name: "Reader" }),
        ]);
      }
      if (method === "account/read") {
        return chatGptAccount();
      }
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, [
          appInfo("asdk_app_readwise", {
            name: "Readwise",
            isAccessible: false,
            isEnabled: true,
          }),
        ]);
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
      }),
    );

    const manualItem = findItemByReason(plan.items, "app_inaccessible");
    expectRecordFields(manualItem, {
      reason: "app_inaccessible",
      status: "skipped",
    });
    const details = expectRecordFields(manualItem.details, {
      pluginName: "readwise",
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
    });
    expect(details).not.toHaveProperty("code");
    expect(details.apps).toEqual([
      {
        id: "asdk_app_reader",
        name: "Reader",
      },
      {
        id: "asdk_app_readwise",
        name: "Readwise",
        isAccessible: false,
        isEnabled: true,
      },
    ]);
  });

  it("force-refreshes source app inventory once for app-backed plugins sharing a cache key", async () => {
    const fixture = await createCodexFixture();
    await defaultCodexAppInventoryCache.refreshNow({
      key: sourceAppCacheKey(fixture),
      request: async (method, params) =>
        codexAppInventoryResponse(
          method,
          [appInfo("app-google-calendar", { isAccessible: false })],
          params,
        ),
    });
    appServerRequest.mockImplementation(
      async ({ method, requestParams }: { method: string; requestParams?: unknown }) => {
        if (method === "plugin/installed" || method === "plugin/list") {
          return pluginMetadata(method, [
            pluginSummary("google-calendar", { installed: true, enabled: true }),
            pluginSummary("gmail", { installed: true, enabled: true }),
          ]);
        }
        if (method === "plugin/read") {
          const pluginName = (requestParams as v2.PluginReadParams).pluginName;
          return pluginRead(pluginName, [pluginApp(`app-${pluginName}`)]);
        }
        if (method === "account/read") {
          return chatGptAccount();
        }
        if (method === "app/installed" || method === "app/read") {
          if (method === "app/installed") {
            expectRecordFields(requestParams, { forceRefresh: true });
          }
          return codexAppInventoryResponse(method, [
            appInfo("app-google-calendar"),
            appInfo("app-gmail"),
          ]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    );
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
      }),
    );

    expectRecordFields(findItem(plan.items, "plugin:google-calendar"), { status: "planned" });
    expectRecordFields(findItem(plan.items, "plugin:gmail"), { status: "planned" });
    expect(sourceAppServerClientScope).toHaveBeenCalledTimes(1);
    expect(
      appServerRequest.mock.calls.filter(([arg]) => arg.method === "plugin/installed"),
    ).toHaveLength(1);
    expect(
      appServerRequest.mock.calls.filter(([arg]) => arg.method === "plugin/read"),
    ).toHaveLength(2);
    expect(appServerRequest.mock.calls.some(([arg]) => arg.method === "plugin/list")).toBe(false);
    expect(
      appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/installed"),
    ).toHaveLength(1);
  });

  it("fails closed for disabled plugins and plugin/read failures", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(
      async ({ method, requestParams }: { method: string; requestParams?: unknown }) => {
        if (method === "plugin/installed" || method === "plugin/list") {
          return pluginMetadata(method, [
            pluginSummary("readwise", { installed: true, enabled: false }),
            pluginSummary("gmail", { installed: true, enabled: true }),
          ]);
        }
        if (method === "plugin/read") {
          expectRecordFields(requestParams, { pluginName: "gmail" });
          throw new Error("detail unavailable");
        }
        throw new Error(`unexpected request ${method}`);
      },
    );
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
      }),
    );

    expectRecordFields(findItemByReason(plan.items, "plugin_disabled"), {
      reason: "plugin_disabled",
      status: "skipped",
    });
    expectRecordFields(findItemByReason(plan.items, "plugin_read_unavailable"), {
      reason: "plugin_read_unavailable",
      status: "skipped",
    });
    expect(plan.items.some((item) => item.id === "config:codex-plugins")).toBe(false);
    expect(
      appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/installed"),
    ).toHaveLength(0);
  });

  it("fails closed when app inventory refresh fails for app-backed plugins", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("readwise", { installed: true, enabled: true }),
        ]);
      }
      if (method === "plugin/read") {
        return pluginRead("readwise", [pluginApp("asdk_app_readwise", { name: "Readwise" })]);
      }
      if (method === "account/read") {
        return chatGptAccount();
      }
      if (method === "app/installed") {
        throw new Error("app inventory unavailable");
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
      }),
    );

    expectRecordFields(findItemByReason(plan.items, "app_inventory_unavailable"), {
      reason: "app_inventory_unavailable",
      status: "skipped",
    });
    expect(plan.items.some((item) => item.id === "plugin:readwise")).toBe(false);
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

    await fs.access(path.join(fixture.workspaceDir, "skills", "tweet-helper", "SKILL.md"));
    await fs.access(path.join(fixture.workspaceDir, "skills", "personal-style", "SKILL.md"));
    await fs.access(path.join(reportDir, "archive", "config.toml"));
    expectRecordFields(findItem(result.items, "plugin:documents:1"), { status: "skipped" });
    expectRecordFields(findItem(result.items, "skill:tweet-helper"), { status: "migrated" });
    expectRecordFields(findItem(result.items, "archive:config.toml"), { status: "migrated" });
    await fs.access(path.join(reportDir, "report.json"));
  });

  it.each([
    { marketplace: "openai-curated", initiallyMissing: true },
    { marketplace: "openai-curated-remote", initiallyMissing: false },
    { marketplace: "openai-api-curated", initiallyMissing: false },
  ])(
    "installs selected $marketplace plugins as soon as the catalog loads",
    async ({ marketplace, initiallyMissing }) => {
      const fixture = await createCodexFixture();
      const reportDir = path.join(fixture.root, "report");
      const configState: MigrationProviderContext["config"] = {
        plugins: {
          entries: {
            codex: {
              enabled: true,
              config: {
                appServer: { sandbox: "workspace-write" },
              },
            },
          },
        },
        agents: { defaults: { workspace: fixture.workspaceDir } },
      } as MigrationProviderContext["config"];
      let targetPluginListCalls = 0;
      let targetPluginListCallsAtInstall = 0;
      appServerRequest.mockImplementation(
        async ({ method, agentDir }: { method: string; agentDir?: string }) => {
          const isTarget = typeof agentDir === "string";
          if (method === "plugin/installed" && !isTarget) {
            return pluginMetadata(method, [
              pluginSummary("google-calendar", { installed: true, enabled: true }),
            ]);
          }
          if (method === "plugin/list" && isTarget) {
            targetPluginListCalls += 1;
            if (initiallyMissing && targetPluginListCalls === 1) {
              return { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] };
            }
            if (
              targetPluginListCalls > (initiallyMissing ? 2 : 1) &&
              !targetPluginListCallsAtInstall
            ) {
              throw new Error("Curated inventory was polled again before installation");
            }
            const listed = pluginList([
              pluginSummary(`google-calendar@${marketplace}`, {
                installed: true,
                enabled: true,
                remotePluginId:
                  marketplace === "openai-curated-remote" ? "remote-calendar-id" : null,
              }),
            ]);
            listed.marketplaces[0]!.name = marketplace;
            listed.marketplaces[0]!.path =
              marketplace === "openai-curated-remote" ? null : `/marketplaces/${marketplace}`;
            return listed;
          }
          if (method === "plugin/read") {
            return pluginRead("google-calendar");
          }
          if (method === "plugin/install") {
            targetPluginListCallsAtInstall = targetPluginListCalls;
            return { authPolicy: "ON_USE", appsNeedingAuth: [] } satisfies v2.PluginInstallResponse;
          }
          if (method === "app/installed" || method === "app/read") {
            return codexAppInventoryResponse(method, []);
          }
          throw new Error(`unexpected request ${method}`);
        },
      );
      const provider = buildCodexMigrationProvider({
        runtime: createConfigRuntime(configState),
      });

      const result = await provider.apply(
        makeContext({
          source: fixture.codexHome,
          stateDir: fixture.stateDir,
          workspaceDir: fixture.workspaceDir,
          reportDir,
          config: configState,
        }),
      );

      const installCall = appServerRequest.mock.calls.find(
        ([arg]) => (arg as { method?: string }).method === "plugin/install",
      )?.[0] as Record<string, unknown>;
      expect(targetPluginListCallsAtInstall).toBe(initiallyMissing ? 2 : 1);
      expectRecordFields(installCall, {
        method: "plugin/install",
        requestParams:
          marketplace === "openai-curated-remote"
            ? { remoteMarketplaceName: marketplace, pluginName: "remote-calendar-id" }
            : { marketplacePath: `/marketplaces/${marketplace}`, pluginName: "google-calendar" },
      });
      const pluginItem = findItem(result.items, "plugin:google-calendar");
      expectRecordFields(pluginItem, {
        status: "migrated",
        reason: "already active",
      });
      expectRecordFields(pluginItem.details, {
        code: "already_active",
        installAttempted: true,
      });
      expectRecordFields(findItem(result.items, "config:codex-plugins"), {
        status: "migrated",
      });
      expect(configState.plugins?.entries?.codex?.enabled).toBe(true);
      expect(configState.plugins?.entries?.codex?.config?.appServer).toEqual({
        sandbox: "workspace-write",
      });
      expect(configState.plugins?.entries?.codex?.config?.codexPlugins).toEqual({
        enabled: true,
        allow_destructive_actions: true,
        plugins: {
          "google-calendar": {
            enabled: true,
            marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
            pluginName: "google-calendar",
          },
        },
      });
      expect(configState.plugins?.entries?.codex?.config?.codexPlugins).not.toHaveProperty("*");
    },
  );

  it("leaves selected Codex plugins as warnings when target curated plugins never load", async () => {
    vi.stubEnv("OPENCLAW_CODEX_MIGRATION_PLUGIN_LIST_TIMEOUT_MS", "1");
    const fixture = await createCodexFixture();
    const configState: MigrationProviderContext["config"] = {
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(
      async ({ method, agentDir }: { method: string; agentDir?: string }) => {
        const isTarget = typeof agentDir === "string";
        if (method === "plugin/installed" && !isTarget) {
          return pluginMetadata(method, [
            pluginSummary("google-calendar", { installed: true, enabled: true }),
          ]);
        }
        if (method === "plugin/read" && !isTarget) {
          return pluginRead("google-calendar");
        }
        if (method === "plugin/list" && isTarget) {
          return {
            marketplaces: [],
            marketplaceLoadErrors: [],
            featuredPluginIds: [],
          } satisfies v2.PluginListResponse;
        }
        if (method === "app/installed" || method === "app/read") {
          return codexAppInventoryResponse(method, []);
        }
        throw new Error(`unexpected request ${method}`);
      },
    );
    const provider = buildCodexMigrationProvider({
      runtime: createConfigRuntime(configState),
    });

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
      }),
    );

    expect(
      appServerRequest.mock.calls.some(
        ([arg]) => (arg as { method?: string }).method === "plugin/install",
      ),
    ).toBe(false);
    expectRecordFields(findItem(result.items, "plugin:google-calendar"), {
      kind: "plugin",
      action: "install",
      status: "warning",
      reason: "marketplace_missing",
    });
    expect(result.warnings).toContain(
      "Some Codex plugins could not be migrated. Run `openclaw migrate codex` after onboarding.",
    );
    expect(result.nextSteps).toContain(
      "Some Codex plugins could not be migrated. Run `openclaw migrate codex` after onboarding.",
    );
    expect(configState.plugins?.entries?.codex?.config?.codexPlugins).toBeUndefined();
  });

  it("leaves selected Codex plugins as warnings when target inventory times out", async () => {
    const fixture = await createCodexFixture();
    const configState: MigrationProviderContext["config"] = {
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(
      async ({ method, agentDir }: { method: string; agentDir?: string }) => {
        const isTarget = typeof agentDir === "string";
        if (method === "plugin/installed" && !isTarget) {
          return pluginMetadata(method, [
            pluginSummary("google-calendar", { installed: true, enabled: true }),
          ]);
        }
        if (method === "plugin/read" && !isTarget) {
          return pluginRead("google-calendar");
        }
        if (method === "plugin/list" && isTarget) {
          throw new Error("codex app-server plugin/list timed out");
        }
        if (method === "app/installed" || method === "app/read") {
          return codexAppInventoryResponse(method, []);
        }
        throw new Error(`unexpected request ${method}`);
      },
    );
    const provider = buildCodexMigrationProvider({
      runtime: createConfigRuntime(configState),
    });

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
      }),
    );

    expectRecordFields(findItem(result.items, "plugin:google-calendar"), {
      kind: "plugin",
      action: "install",
      status: "warning",
      reason: "plugin_inventory_unavailable",
      message: 'Codex plugin "google-calendar" could not be migrated automatically',
    });
    expect(result.warnings).toContain(
      "Some Codex plugins could not be migrated. Run `openclaw migrate codex` after onboarding.",
    );
    expect(result.nextSteps).toContain(
      "Some Codex plugins could not be migrated. Run `openclaw migrate codex` after onboarding.",
    );
    expect(result.summary.errors).toBe(0);
    expect(configState.plugins?.entries?.codex?.config?.codexPlugins).toBeUndefined();
  });

  it("plans already configured target Codex plugins as plugin-level conflicts", async () => {
    const fixture = await createCodexFixture();
    const configState: MigrationProviderContext["config"] = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              codexPlugins: {
                enabled: true,
                allow_destructive_actions: false,
                plugins: {
                  "google-calendar": {
                    enabled: true,
                    marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
                    pluginName: "google-calendar",
                  },
                },
              },
            },
          },
        },
      },
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("google-calendar", { installed: true, enabled: true }),
          pluginSummary("gmail", { installed: true, enabled: true }),
        ]);
      }
      if (method === "plugin/read") {
        return pluginRead("google-calendar");
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const result = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
      }),
    );

    expectRecordFields(findItem(result.items, "plugin:google-calendar"), {
      status: "conflict",
      reason: "plugin exists",
    });
    expectRecordFields(findItem(result.items, "plugin:gmail"), { status: "planned" });
    expectRecordFields(findItem(result.items, "config:codex-plugins"), { status: "planned" });
  });

  it("returns Codex plugin config patches without mutating config in return mode", async () => {
    const fixture = await createCodexFixture();
    const configState: MigrationProviderContext["config"] = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              appServer: { sandbox: "workspace-write" },
            },
          },
        },
      },
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(createCalendarPluginMigrationRequest());
    const mutateConfigFile = vi.fn(async () => {
      throw new Error("mutateConfigFile should not be called in return mode");
    });
    const provider = buildCodexMigrationProvider({
      runtime: {
        config: {
          current: () => configState,
          mutateConfigFile,
        },
      } as unknown as MigrationProviderContext["runtime"],
    });

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
        providerOptions: { configPatchMode: "return" },
      }),
    );

    expect(mutateConfigFile).not.toHaveBeenCalled();
    expect(configState.plugins?.entries?.codex?.config?.codexPlugins).toBeUndefined();
    const configItem = findItem(result.items, "config:codex-plugins");
    expectRecordFields(configItem, { status: "migrated" });
    const configDetails = configItem.details as Record<string, unknown>;
    expectRecordFields(configDetails, {
      path: ["plugins", "entries", "codex"],
    });
    expect(configDetails.value).toEqual({
      enabled: true,
      config: {
        codexPlugins: {
          enabled: true,
          allow_destructive_actions: true,
          plugins: {
            "google-calendar": {
              enabled: true,
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
    });
  });

  it("merges migrated plugin config with existing Codex plugins when entries do not conflict", async () => {
    const fixture = await createCodexFixture();
    const sourceKey = sourceAppCacheKey(fixture);
    await defaultCodexAppInventoryCache.refreshNow({
      key: sourceKey,
      request: async (method, params) =>
        codexAppInventoryResponse(method, [appInfo("source-only-app")], params),
    });
    const configState: MigrationProviderContext["config"] = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              codexPlugins: {
                enabled: true,
                allow_destructive_actions: true,
                plugins: {
                  slack: {
                    enabled: true,
                    marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
                    pluginName: "slack",
                    allow_destructive_actions: "on-request",
                  },
                },
              },
            },
          },
        },
      },
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(createCalendarPluginMigrationRequest());
    const provider = buildCodexMigrationProvider({
      runtime: createConfigRuntime(configState),
    });

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
      }),
    );

    expectRecordFields(findItem(result.items, "config:codex-plugins"), { status: "migrated" });
    const sourceCacheRead = defaultCodexAppInventoryCache.read({
      key: sourceKey,
      request: async () => {
        throw new Error("source app cache was cleared");
      },
    });
    expect(sourceCacheRead.state).toBe("fresh");
    expect(sourceCacheRead.snapshot?.apps.map((app) => app.id)).toEqual(["source-only-app"]);
    expect(configState.plugins?.entries?.codex?.config?.codexPlugins).toEqual({
      allow_destructive_actions: true,
      plugins: {
        "google-calendar": {
          enabled: true,
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          pluginName: "google-calendar",
        },
        slack: {
          enabled: true,
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          pluginName: "slack",
          allow_destructive_actions: "auto",
        },
      },
      enabled: true,
    });
  });

  it("preserves existing destructive plugin policy when overwrite is explicit", async () => {
    const fixture = await createCodexFixture();
    const configState: MigrationProviderContext["config"] = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              codexPlugins: {
                enabled: true,
                allow_destructive_actions: true,
                plugins: {},
              },
            },
          },
        },
      },
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(createCalendarPluginMigrationRequest());
    const provider = buildCodexMigrationProvider({
      runtime: createConfigRuntime(configState),
    });

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
      }),
    );

    expectRecordFields(findItem(result.items, "config:codex-plugins"), { status: "migrated" });
    expect(configState.plugins?.entries?.codex?.config?.codexPlugins).toEqual({
      enabled: true,
      allow_destructive_actions: true,
      plugins: {
        "google-calendar": {
          enabled: true,
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          pluginName: "google-calendar",
        },
      },
    });
  });

  it("repairs old approval-routed destructive plugin policy during migration", async () => {
    const fixture = await createCodexFixture();
    const configState: MigrationProviderContext["config"] = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              codexPlugins: {
                enabled: true,
                allow_destructive_actions: "on-request",
                plugins: {
                  "google-calendar": {
                    enabled: true,
                    marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
                    pluginName: "google-calendar",
                    allow_destructive_actions: "on-request",
                  },
                },
              },
            },
          },
        },
      },
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(createCalendarPluginMigrationRequest());
    const provider = buildCodexMigrationProvider({
      runtime: createConfigRuntime(configState),
    });

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
      }),
    );

    expectRecordFields(findItem(result.items, "config:codex-plugins"), { status: "migrated" });
    expect(configState.plugins?.entries?.codex?.config?.codexPlugins).toEqual({
      enabled: true,
      allow_destructive_actions: "auto",
      plugins: {
        "google-calendar": {
          enabled: true,
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          pluginName: "google-calendar",
          allow_destructive_actions: "auto",
        },
      },
    });
  });

  it("preserves global ask destructive plugin policy during migration", async () => {
    const fixture = await createCodexFixture();
    const configState: MigrationProviderContext["config"] = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              codexPlugins: {
                enabled: true,
                allow_destructive_actions: "ask",
                plugins: {},
              },
            },
          },
        },
      },
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(createCalendarPluginMigrationRequest());
    const provider = buildCodexMigrationProvider({
      runtime: createConfigRuntime(configState),
    });

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
      }),
    );

    expectRecordFields(findItem(result.items, "config:codex-plugins"), { status: "migrated" });
    expect(configState.plugins?.entries?.codex?.config?.codexPlugins).toEqual({
      enabled: true,
      allow_destructive_actions: "ask",
      plugins: {
        "google-calendar": {
          enabled: true,
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          pluginName: "google-calendar",
        },
      },
    });
  });

  it("records fieldless auth-required plugin install apps as disabled explicit config entries", async () => {
    const fixture = await createCodexFixture();
    const configState: MigrationProviderContext["config"] = {
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("google-calendar", { installed: true, enabled: true }),
        ]);
      }
      if (method === "plugin/read") {
        return pluginRead("google-calendar");
      }
      if (method === "plugin/install") {
        return {
          authPolicy: "ON_USE",
          appsNeedingAuth: [
            {
              id: "google-calendar",
              name: "Google Calendar",
              description: "Calendar",
              installUrl: "https://example.invalid/auth",
              category: "productivity",
            },
          ],
        } satisfies v2.PluginInstallResponse;
      }
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, []);
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider({
      runtime: createConfigRuntime(configState),
    });

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
      }),
    );

    const pluginItem = findItem(result.items, "plugin:google-calendar");
    expectRecordFields(pluginItem, {
      status: "skipped",
      reason: "auth_required",
    });
    expectRecordFields(pluginItem.details, {
      code: "auth_required",
      appsNeedingAuth: [
        {
          id: "google-calendar",
          name: "Google Calendar",
          needsAuth: true,
        },
      ],
    });
    expect(configState.plugins?.entries?.codex?.config?.codexPlugins).toEqual({
      enabled: true,
      allow_destructive_actions: true,
      plugins: {
        "google-calendar": {
          enabled: false,
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          pluginName: "google-calendar",
        },
      },
    });
  });

  it("does not write config entries for failed plugin installs", async () => {
    const fixture = await createCodexFixture();
    const configState: MigrationProviderContext["config"] = {
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("google-calendar", { installed: true, enabled: true }),
        ]);
      }
      if (method === "plugin/read") {
        return pluginRead("google-calendar");
      }
      if (method === "plugin/install") {
        throw new Error("install failed");
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider({
      runtime: createConfigRuntime(configState),
    });

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
      }),
    );

    expectRecordFields(findItem(result.items, "plugin:google-calendar"), {
      status: "error",
      reason: "install failed",
    });
    expectRecordFields(findItem(result.items, "config:codex-plugins"), {
      status: "warning",
      reason: "selected Codex plugin activation is incomplete",
    });
    expect(configState.plugins?.entries?.codex?.config?.codexPlugins).toBeUndefined();
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

    expectRecordFields(findItem(plan.items, "skill:tweet-helper"), { status: "conflict" });
    expectRecordFields(findItem(overwritePlan.items, "skill:tweet-helper"), {
      status: "planned",
    });
  });
});

function findItemByReason(items: readonly { reason?: string }[], reason: string) {
  const item = items.find((entry) => entry.reason === reason);
  if (!item) {
    throw new Error(`Expected migration item reason ${reason}`);
  }
  return item as Record<string, unknown>;
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function sourceAppCacheKey(fixture: { codexHome: string }): string {
  return buildCodexPluginAppCacheKey({
    appServer: {
      start: {
        transport: "stdio",
        command: "codex",
        commandSource: "managed",
        managedCommandOrder: "desktop-first",
        args: ["app-server", "--listen", "stdio://"],
        headers: {},
        env: {
          CODEX_HOME: fixture.codexHome,
          HOME: path.dirname(fixture.codexHome),
        },
      },
    },
  });
}

function createCalendarPluginMigrationRequest() {
  return async ({ method }: { method: string }) => {
    if (method === "plugin/installed" || method === "plugin/list") {
      return pluginMetadata(method, [
        pluginSummary("google-calendar", { installed: true, enabled: true }),
      ]);
    }
    if (method === "plugin/read") {
      return pluginRead("google-calendar");
    }
    if (method === "plugin/install") {
      return { authPolicy: "ON_USE", appsNeedingAuth: [] } satisfies v2.PluginInstallResponse;
    }
    if (method === "app/installed" || method === "app/read") {
      return codexAppInventoryResponse(method, []);
    }
    throw new Error(`unexpected request ${method}`);
  };
}

function pluginMetadata(
  method: "plugin/installed" | "plugin/list",
  plugins: v2.PluginSummary[],
): v2.PluginInstalledResponse | v2.PluginListResponse {
  const response = pluginList(plugins);
  if (method === "plugin/installed") {
    return {
      marketplaces: response.marketplaces,
      marketplaceLoadErrors: [],
    };
  }
  return response;
}

function pluginRead(pluginName: string, apps: v2.AppSummary[] = []): v2.PluginReadResponse {
  return {
    plugin: {
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
      marketplacePath: "/marketplaces/openai-curated",
      summary: pluginSummary(pluginName, { installed: true, enabled: true }),
      description: null,
      skills: [],
      apps,
      mcpServers: [],
    },
  };
}

function pluginApp(id: string, overrides: Partial<v2.AppSummary> = {}): v2.AppSummary {
  return {
    id,
    name: id,
    description: null,
    installUrl: null,
    category: null,
    ...overrides,
  };
}

function appInfo(id: string, overrides: Partial<v2.AppInfo> = {}): v2.AppInfo {
  return {
    id,
    name: id,
    description: null,
    logoUrl: null,
    logoUrlDark: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: null,
    isAccessible: true,
    isEnabled: true,
    pluginDisplayNames: [],
    ...overrides,
  };
}

function chatGptAccount(): CodexGetAccountResponse {
  return {
    account: { type: "chatgpt", email: "codex@example.test", planType: "plus" },
    requiresOpenaiAuth: false,
  };
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
