import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerPreActionHooks } from "../cli/program/preaction.js";
import { withCliPluginInvocation } from "../cli/run-main-plugin-cache.js";
import { withCliProcessScope } from "../cli/runtime-cleanup-scope.js";
import { captureRuntimeConfigWithSource } from "../config/runtime-config-capture-state.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  captureRuntimeConfig,
  projectConfigOntoRuntimeSourceSnapshot,
} from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withLocalGatewayRequestScope } from "../gateway/local-request-context.js";
import { createHookRunner } from "../plugins/hooks.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { pluginInvocationContext } from "../plugins/plugin-instance-scope.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  bindPluginRegistryGatewayOwner,
  isPluginRegistryRetired,
  markPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { clearActivePluginRegistry, getActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import {
  getPluginRuntimeLoadContext,
  getReusablePluginRuntimeActivation,
} from "../plugins/runtime/load-context.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  isDeliverableMessageChannel,
  listDeliverableMessageChannels,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import { runLocalAgentCommand } from "./agent-command-local.js";
import { bindActiveOperatorTurnAuthority } from "./cron-creator-authority-context.js";
import { prepareWorkspacePluginRegistries } from "./prepared-model-runtime.inbound-registry.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";
import { retainPreparedPluginRegistry } from "./prepared-model-runtime.plugin-lifetime.js";
import { PreparedModelRuntimeBuildResources } from "./prepared-model-runtime.resources.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";
import { resolveLocalAgentPluginRegistry } from "./runtime-local-plugin-registry.js";
import { withLocalAgentPluginRegistry } from "./runtime-plugins.js";
import { getSandboxBackendFactory } from "./sandbox/backend.js";

// Stop at the actual admitted run callback, not an HTTP transport or a mocked registry.
// Config/session preparation and unrelated CLI presentation have their own boundary tests.
const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));
// Real recipient preparation (including the predicate) is exercised in the
// separate unmocked recipient suite; these fixtures own plugin custody only.
vi.mock("./command/prepare.js", () => ({
  prepareAgentCommandExecution: mocks.prepare,
  isAgentCommandExplicitRecipientCandidate: () => false,
}));
vi.mock("./command/runtime-loaders.js", () => ({ resolveAgentCommandDeps: async () => ({}) }));
vi.mock("../cli/program/config-guard.js", () => ({ ensureConfigReady: async () => {} }));
vi.mock("../cli/banner.js", () => ({ emitCliBanner: () => {} }));
vi.mock("../cli/state-dir-gateway-check.js", () => ({
  checkCliGatewayStateDir: async () => ({ kind: "allow" }),
}));
let state: OpenClawTestState;
let argv: string[];
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "local-plugin-root" });
  argv = process.argv;
  useNoBundledPlugins();
});
afterEach(async () => {
  process.argv = argv;
  await resetPreparedModelRuntimeSnapshotsForTest();
  resetPluginLoaderTestStateForTest();
  vi.unstubAllEnvs();
  await state.cleanup();
});
afterAll(cleanupPluginLoaderFixturesForTest);

function localFixture() {
  const event = "local-registration:" + state.root;
  const captures: Array<{ id: string; mode: string; directory: string }> = [];
  const onRegistration = (id: string, mode: string, directory: string) =>
    captures.push({ id, mode, directory });
  process.on(event, onRegistration);
  const plugin = writePlugin({
    id: "local-full-owner",
    configSchema: { type: "object", properties: { label: { type: "string" } } },
    registration: [
      "process.emit(" + JSON.stringify(event) + ", api.id, api.registrationMode, __dirname);",
      'if (api.registrationMode !== "full") return;',
      'const unregister = require("openclaw/plugin-sdk/sandbox").registerSandboxBackend("local-fixture", async () => { throw new Error("not provisioned by this fixture"); });',
      "api.lifecycle.onDispose(unregister);",
      'api.on("before_prompt_build", async () => ({ prependContext: api.pluginConfig.label }));',
      'api.registerTool(() => ({ name: "local_context", description: api.config.agents.defaults.workspace, parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) }), { name: "local_context" });',
      'api.registerMediaUnderstandingProvider({ id: "local-media", capabilities: ["image"], describeImage: async () => ({ text: "image" }) });',
      'api.registerChannel({ plugin: { id: "local-channel", meta: { id: "local-channel", label: "Local", aliases: ["local-alias"] }, capabilities: { chatTypes: ["direct"] }, config: { listAccountIds: () => [], resolveAccount: () => ({}) } } });',
    ].join("\n"),
  });
  const localManifest = path.join(plugin.dir, "openclaw.plugin.json");
  fs.writeFileSync(
    localManifest,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(localManifest, "utf8")),
      channels: ["local-channel"],
      contracts: { tools: ["local_context"] },
    }),
  );
  const future = writePlugin({
    id: "future-provider",
    dir: state.path("bundled", "future-provider"),
    filename: "index.cjs",
    registration:
      "process.emit(" +
      JSON.stringify(event) +
      ', api.id, api.registrationMode, __dirname); api.registerProvider({ id: "future-provider", label: "Future", auth: [] });',
  });
  const manifest = path.join(future.dir, "openclaw.plugin.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(manifest, "utf8")),
      providers: [future.id],
      activation: { onStartup: false },
    }),
  );
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", state.path("bundled"));
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "0");
  vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        model: "custom/model",
        models: { "future-provider/model": { alias: "unused picker entry" } },
      },
    },
    plugins: {
      load: { paths: [plugin.file] },
      slots: { memory: "none" },
      entries: {
        [plugin.id]: {
          enabled: true,
          config: { label: "local full capability" },
          hooks: { allowConversationAccess: true },
        },
      },
    },
  };
  return {
    config,
    plugin,
    future,
    captures,
    [Symbol.dispose]: () => process.off(event, onRegistration),
  };
}

async function assertFullCapabilities(
  registry: PluginRegistry,
  workspaceDir: string,
  label = "local full capability",
) {
  expect(
    await createHookRunner(registry, { catchErrors: false }).runBeforePromptBuild(
      { prompt: "Reply only OK", messages: [] },
      {},
    ),
  ).toEqual({ prependContext: label });
  expect(
    registry.tools.find(({ pluginId }) => pluginId === "local-full-owner")?.factory({}),
  ).toMatchObject({ description: workspaceDir });
  expect(registry.channels.map(({ plugin }) => plugin.id)).toContain("local-channel");
  expect(normalizeMessageChannel("local-alias")).toBe("local-channel");
  expect(isDeliverableMessageChannel("local-channel")).toBe(true);
  expect(listDeliverableMessageChannels()).toContain("local-channel");
  expect(registry.mediaUnderstandingProviders.map(({ provider }) => provider.id)).toContain(
    "local-media",
  );
  expect(getSandboxBackendFactory("local-fixture")).not.toBeNull();
}

async function withExecutableCli<T>(run: () => Promise<T>): Promise<T> {
  return await withCliProcessScope(() =>
    withCliPluginInvocation(false, async (cleanup) => {
      try {
        return await run();
      } finally {
        await cleanup?.pluginResources?.release();
      }
    }),
  );
}

it.each(["unchanged JSON", "admitted workspace/config text", "materialized provider SecretRef"])(
  "captures once from preaction through model admission and the run callback: %s",
  async (scenario) => {
    using fixture = localFixture();
    const { config, captures, plugin } = fixture;
    const changed = scenario === "admitted workspace/config text";
    const materializedSecret = scenario === "materialized provider SecretRef";
    const workspaceDir = changed ? state.path("ops-workspace") : state.workspaceDir;
    fs.mkdirSync(workspaceDir, { recursive: true });
    const admitted = changed || materializedSecret ? structuredClone(config) : config;
    if (changed) {
      admitted.agents!.defaults!.workspace = workspaceDir;
      admitted.plugins!.entries![plugin.id]!.config = { label: "resolved local secret" };
    }
    const authored = materializedSecret ? structuredClone(admitted) : admitted;
    if (materializedSecret) {
      admitted.agents!.defaults!.model = "openai/mock";
      admitted.agents!.defaults!.models!["openai/mock"] = { agentRuntime: { id: "openclaw" } };
      admitted.models = {
        providers: {
          openai: {
            baseUrl: "http://127.0.0.1:12345/v1",
            api: "openai-responses",
            apiKey: "synthetic-resolved-key",
            models: [],
          },
        },
      };
      authored.agents = structuredClone(admitted.agents);
      authored.models = structuredClone(admitted.models);
      authored.models!.providers!.openai!.apiKey = {
        source: "env",
        provider: "default",
        id: "OPENAI_API_KEY",
      };
    }
    setRuntimeConfigSnapshot(config, config);
    mocks.prepare.mockImplementation(async () => {
      if (changed) {
        vi.stubEnv("LOCAL_CAPTURE_TEST", "admitted environment");
      }
      setRuntimeConfigSnapshot(admitted, authored);
      return {
        cfg: admitted,
        opts: { runId: "local-root", senderIsOwner: true },
        runId: "local-root",
        sessionAgentId: changed ? "ops" : "main",
        agentDir: state.agentDir(changed ? "ops" : "main"),
        workspaceDir,
      };
    });
    let late: (() => void) | undefined;
    let retainedAuthority: ReturnType<typeof bindActiveOperatorTurnAuthority>;
    const run = vi.fn(async () => {
      const registry = getPluginRuntimeGenerationRegistry()!;
      retainedAuthority = bindActiveOperatorTurnAuthority("local-root");
      expect(retainedAuthority?.source).toBe("local");
      expect(captures).toHaveLength(1);
      expect(captures[0]?.mode).toBe("full");
      expect(captures[0]?.directory).not.toBe(plugin.dir);
      expect(fs.existsSync(path.join(captures[0]!.directory, path.basename(plugin.file)))).toBe(
        true,
      );
      await assertFullCapabilities(
        registry,
        workspaceDir,
        changed ? "resolved local secret" : undefined,
      );
      late = AsyncLocalStorage.bind(() => registry.tools[0]!.factory({}));
      return "OK";
    });
    const program = new Command().name("openclaw");
    program
      .command("agent")
      .option("--local")
      .option("--agent <id>")
      .option("--message <text>")
      .option("--thinking <level>")
      .option("--json")
      .action(async () => {
        expect(
          await runLocalAgentCommand({
            opts: {
              message: "Reply only OK",
              agentId: changed ? "ops" : "main",
              runId: "local-root",
            },
            runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
            operatorAuthority: true,
            run,
          }),
        ).toBe("OK");
      });
    registerPreActionHooks(program, "test");
    process.argv = [
      "node",
      "openclaw",
      "agent",
      "--agent",
      changed ? "ops" : "main",
      "--local",
      "--message",
      "Reply only OK",
      "--thinking",
      "off",
      ...(changed ? [] : ["--json"]),
    ];
    await withExecutableCli(() => program.parseAsync(process.argv));
    expect(run).toHaveBeenCalledOnce();
    expect(() => late?.()).toThrow();
    expect(() => retainedAuthority?.assertActive()).toThrow();
    expect(getSandboxBackendFactory("local-fixture")).toBeNull();
    expect(captures.every(({ directory }) => !fs.existsSync(directory))).toBe(true);
  },
);

it.each([
  "matching",
  "explicit allow",
  "deny wins",
  "config",
  "source config",
  "environment",
  "workspace",
  "metadata",
  "retired",
  "no invocation",
  "future selection",
  "provider-only",
  "model catalog",
] as const)("admits only compatible live local facts: %s", async (scenario) => {
  using fixture = localFixture();
  const { config, captures } = fixture;
  if (scenario === "explicit allow" || scenario === "deny wins") {
    config.plugins!.allow = [fixture.plugin.id, fixture.future.id];
    if (scenario === "deny wins") {
      config.plugins!.deny = [fixture.future.id];
    }
  }
  setRuntimeConfigSnapshot(config, config);
  const metadataCache = createPluginCache();
  try {
    await withExecutableCli(() =>
      withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => config }, () =>
        withLocalAgentPluginRegistry({
          config,
          workspaceDir: state.workspaceDir,
          run: async (root) => {
            const context = getPluginRuntimeLoadContext(root)!;
            let metadata = context.metadataSnapshot!;
            const input: PreparedModelRuntimeInput = {
              config,
              agentId: "main",
              agentDir: state.agentDir(),
              workspaceDir: state.workspaceDir,
            };
            if (scenario === "config") {
              input.config = { ...config, gateway: { port: 19099 } };
            }
            if (scenario === "source config") {
              input.config = captureRuntimeConfigWithSource(config, {
                ...config,
                gateway: { port: 19098 },
              });
            }
            if (scenario === "environment") {
              input.env = { ...process.env, LOCAL_CAPTURE_TEST: "changed" };
            }
            if (scenario === "workspace") {
              input.workspaceDir = state.path("other-workspace");
            }
            if (scenario === "metadata") {
              metadata = withPluginCache(metadataCache, () =>
                loadPluginMetadataSnapshot({
                  config,
                  workspaceDir: state.workspaceDir,
                  allowCurrent: false,
                }),
              );
            }
            if (scenario === "retired") {
              markPluginRegistryRetired(root);
            }
            if (
              scenario === "future selection" ||
              scenario === "provider-only" ||
              scenario === "model catalog"
            ) {
              input.runtimePluginSelections = [
                { provider: "future-provider", modelId: "model", runtime: "openclaw" },
              ];
              if (scenario !== "future selection") {
                input.loadRuntimePlugins = true;
              }
            }
            await using resources = new PreparedModelRuntimeBuildResources(
              retainPreparedPluginRegistry,
            );
            const prepare = () =>
              prepareWorkspacePluginRegistries(
                input,
                metadata,
                (registry) => resources.retainRegistry(registry),
                undefined,
                false,
                undefined,
                () => [],
                undefined,
                resources.load.bind(resources),
                scenario === "model catalog" ? "model-catalog" : undefined,
              );
            const prepared = await (scenario === "no invocation"
              ? pluginInvocationContext.exit(prepare)
              : prepare());
            if (
              scenario === "matching" ||
              scenario === "explicit allow" ||
              scenario === "deny wins"
            ) {
              expect(prepared.runtimePluginRegistry).toBe(root);
              expect(captures.map(({ id, mode }) => ({ id, mode }))).toEqual([
                { id: "local-full-owner", mode: "full" },
                ...(scenario === "explicit allow" ? [{ id: "future-provider", mode: "full" }] : []),
              ]);
              await assertFullCapabilities(root, state.workspaceDir);
            } else {
              expect(prepared.runtimePluginRegistry).not.toBe(root);
              if (scenario === "model catalog") {
                expect(captures).toHaveLength(1);
              } else {
                expect(captures.length).toBeGreaterThan(1);
              }
              if (scenario === "future selection") {
                expect(
                  prepared.runtimePluginRegistry?.providers.map(({ provider }) => provider.id),
                ).toContain("future-provider");
                await assertFullCapabilities(prepared.runtimePluginRegistry!, state.workspaceDir);
              } else if (scenario === "provider-only" || scenario === "model catalog") {
                expect(
                  prepared.runtimePluginRegistry?.plugins
                    .filter(({ status }) => status === "loaded")
                    .map(({ id }) => id),
                ).toEqual(scenario === "model catalog" ? [] : [fixture.future.id]);
                if (scenario !== "model catalog") {
                  expect(captures.at(-1)?.mode).toBe("discovery");
                }
                await assertFullCapabilities(root, state.workspaceDir);
              }
            }
          },
        }),
      ),
    );
  } finally {
    await retirePluginCache(metadataCache);
  }
});

it("diagnoses local materialized provider SecretRef admission through the prepared workspace", async () => {
  using fixture = localFixture();
  const source: OpenClawConfig = structuredClone(fixture.config);
  source.agents!.defaults!.model = "openai/mock";
  source.models = {
    providers: {
      openai: {
        baseUrl: "http://127.0.0.1:12345/v1",
        api: "openai-responses",
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        models: [],
      },
    },
  };
  const materialized: OpenClawConfig = structuredClone(source);
  materialized.models!.providers!.openai!.apiKey = "synthetic-resolved-key";
  setRuntimeConfigSnapshot(materialized, source);
  await withExecutableCli(() =>
    withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => materialized }, () =>
      withLocalAgentPluginRegistry({
        config: materialized,
        workspaceDir: state.workspaceDir,
        run: async (root) => {
          const input: PreparedModelRuntimeInput = {
            config: captureRuntimeConfig(materialized),
            agentId: "main",
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
          };
          const metadata = prepareOwnedPluginLoadContext(input, process.env, undefined);
          const context = getPluginRuntimeLoadContext(root)!;
          expect(context.rawConfig).toEqual(input.config);
          expect(Object.isFrozen(context.rawConfig)).toBe(true);
          expect(Object.isFrozen(context.rawConfig.models?.providers?.openai)).toBe(true);
          expect(projectConfigOntoRuntimeSourceSnapshot(input.config)).toEqual(
            context.activationSourceConfig,
          );
          expect(metadata).toBe(context.metadataSnapshot);
          expect(
            getReusablePluginRuntimeActivation(root, {
              config: input.config,
              env: process.env,
              workspaceDir: input.workspaceDir,
              metadataSnapshot: metadata,
            }),
          ).toBeDefined();
          expect(resolveLocalAgentPluginRegistry(input, metadata)).toBe(root);
          expect(
            resolveLocalAgentPluginRegistry(
              {
                ...input,
                config: captureRuntimeConfigWithSource(
                  { ...materialized, gateway: { port: 19099 } },
                  source,
                ),
              },
              metadata,
            ),
          ).toBeUndefined();
          expect(
            resolveLocalAgentPluginRegistry(
              {
                ...input,
                config: captureRuntimeConfigWithSource(materialized, {
                  ...source,
                  gateway: { port: 19098 },
                }),
              },
              metadata,
            ),
          ).toBeUndefined();
          expect(
            resolveLocalAgentPluginRegistry(
              {
                ...input,
                env: { ...process.env, LOCAL_CAPTURE_TEST: "changed" },
              },
              metadata,
            ),
          ).toBeUndefined();
          expect(
            resolveLocalAgentPluginRegistry(
              {
                ...input,
                workspaceDir: state.path("other-workspace"),
              },
              metadata,
            ),
          ).toBeUndefined();
          await using resources = new PreparedModelRuntimeBuildResources(
            retainPreparedPluginRegistry,
          );
          const prepared = await prepareWorkspacePluginRegistries(
            input,
            metadata,
            (registry) => resources.retainRegistry(registry),
            undefined,
            false,
            undefined,
            () => [],
            undefined,
            resources.load.bind(resources),
          );
          expect(prepared.runtimePluginRegistry).toBe(root);
          expect(fixture.captures.map(({ mode }) => mode)).toEqual(["full"]);
        },
      }),
    ),
  );
});

it.each([false, true])(
  "revokes the local invocation before physical root retirement (empty=%s)",
  async (empty) => {
    using fixture = localFixture();
    const config = empty ? { plugins: { enabled: false } } : fixture.config;
    setRuntimeConfigSnapshot(config, config);
    await withExecutableCli(() =>
      withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => config }, async () => {
        let late: (() => PluginRegistry | undefined) | undefined;
        await withLocalAgentPluginRegistry({
          config,
          workspaceDir: state.workspaceDir,
          run: async (root) => {
            const metadata = getPluginRuntimeLoadContext(root)!.metadataSnapshot!;
            late = AsyncLocalStorage.bind(() =>
              resolveLocalAgentPluginRegistry(
                { config, workspaceDir: state.workspaceDir },
                metadata,
              ),
            );
            expect(late()).toBe(root);
          },
        });
        expect(() => late?.()).toThrow("Plugin invocation scope is closed");
        if (!empty) {
          expect(getSandboxBackendFactory("local-fixture")).not.toBeNull();
        }
      }),
    );
    expect(getSandboxBackendFactory("local-fixture")).toBeNull();
  },
);

it("does not replace an unrelated active root while a programmatic local root runs", async () => {
  using fixture = localFixture();
  const rootPlugin = writePlugin({
    id: "unrelated-root-owner",
    registration: [
      'if (api.registrationMode !== "full") return;',
      'const unregister = require("openclaw/plugin-sdk/sandbox").registerSandboxBackend("unrelated-root", async () => { throw new Error("fixture"); });',
      "api.lifecycle.onDispose(unregister);",
      'api.on("before_prompt_build", async () => ({ prependContext: "unrelated root still alive" }));',
    ].join("\n"),
  });
  const config: OpenClawConfig = {
    plugins: {
      load: { paths: [rootPlugin.file] },
      entries: { [rootPlugin.id]: { enabled: true, hooks: { allowConversationAccess: true } } },
    },
  };
  const active = loadAndActivateRootPluginRegistry({
    config,
    workspaceDir: state.workspaceDir,
    onlyPluginIds: [rootPlugin.id],
    cache: false,
    throwOnLoadError: true,
  });
  let currentGateway: PluginRegistry | undefined = active;
  bindPluginRegistryGatewayOwner(active, { current: () => currentGateway });
  try {
    expect(getSandboxBackendFactory("unrelated-root")).not.toBeNull();
    await withPluginRuntimeRegistryScope(active, () =>
      withLocalAgentPluginRegistry({
        config,
        workspaceDir: state.workspaceDir,
        run: async (gateway) => expect(gateway).toBe(active),
      }),
    );
    currentGateway = undefined;
    await withPluginRuntimeRegistryScope(active, () =>
      withLocalAgentPluginRegistry({
        config: fixture.config,
        workspaceDir: state.workspaceDir,
        run: async (local) => {
          expect(local).not.toBe(active);
          await assertFullCapabilities(local, state.workspaceDir);
        },
      }),
    );
    await withLocalAgentPluginRegistry({
      config: fixture.config,
      workspaceDir: state.workspaceDir,
      run: async (local) => {
        expect(getActivePluginRegistry()).toBe(active);
        expect(local).not.toBe(active);
        await assertFullCapabilities(local, state.workspaceDir);
        expect(getSandboxBackendFactory("unrelated-root")).not.toBeNull();
      },
    });
    expect(getActivePluginRegistry()).toBe(active);
    expect(isPluginRegistryRetired(active)).toBe(false);
    expect(getSandboxBackendFactory("unrelated-root")).not.toBeNull();
    expect(getSandboxBackendFactory("local-fixture")).toBeNull();
    expect(fixture.captures.every(({ directory }) => !fs.existsSync(directory))).toBe(true);
    expect(
      await createHookRunner(active, { catchErrors: false }).runBeforePromptBuild(
        { prompt: "still active", messages: [] },
        {},
      ),
    ).toEqual({ prependContext: "unrelated root still alive" });
  } finally {
    await clearActivePluginRegistry(active);
  }
  expect(getSandboxBackendFactory("unrelated-root")).toBeNull();
});

it("reuses compatible nested local custody and admits a different workspace/config independently", async () => {
  using fixture = localFixture();
  const otherWorkspace = state.path("nested-workspace");
  fs.mkdirSync(otherWorkspace, { recursive: true });
  const nestedConfig = structuredClone(fixture.config);
  nestedConfig.agents!.defaults!.workspace = otherWorkspace;
  nestedConfig.plugins!.entries![fixture.plugin.id]!.config = { label: "nested full capability" };
  await withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => fixture.config }, () =>
    withLocalAgentPluginRegistry({
      config: fixture.config,
      workspaceDir: state.workspaceDir,
      run: async (outer) => {
        const outerFactory = getSandboxBackendFactory("local-fixture");
        await withLocalAgentPluginRegistry({
          config: fixture.config,
          workspaceDir: state.workspaceDir,
          run: async (compatible) => {
            expect(compatible).toBe(outer);
            await assertFullCapabilities(compatible, state.workspaceDir);
          },
        });
        expect(fixture.captures).toHaveLength(1);
        await withLocalAgentPluginRegistry({
          config: nestedConfig,
          workspaceDir: otherWorkspace,
          run: async (inner) => {
            expect(inner).not.toBe(outer);
            await assertFullCapabilities(inner, otherWorkspace, "nested full capability");
            expect(getSandboxBackendFactory("local-fixture")).not.toBe(outerFactory);
          },
        });
        expect(fixture.captures).toHaveLength(2);
        expect(getSandboxBackendFactory("local-fixture")).toBe(outerFactory);
        await assertFullCapabilities(outer, state.workspaceDir);
      },
    }),
  );
  expect(getSandboxBackendFactory("local-fixture")).toBeNull();
  expect(fixture.captures.every(({ directory }) => !fs.existsSync(directory))).toBe(true);
});

it("keeps the second overlapping local owner live when the first retires", async () => {
  using fixture = localFixture();
  let firstReady!: () => void;
  let finishFirst!: () => void;
  let secondReady!: () => void;
  let finishSecond!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    firstReady = resolve;
  });
  const firstFinish = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const secondStarted = new Promise<void>((resolve) => {
    secondReady = resolve;
  });
  const secondFinish = new Promise<void>((resolve) => {
    finishSecond = resolve;
  });
  let firstRegistry!: PluginRegistry;
  let secondRegistry!: PluginRegistry;
  const first = withLocalAgentPluginRegistry({
    config: fixture.config,
    workspaceDir: state.workspaceDir,
    run: async (registry) => {
      firstRegistry = registry;
      firstReady();
      await firstFinish;
    },
  });
  await firstStarted;
  const second = withLocalAgentPluginRegistry({
    config: fixture.config,
    workspaceDir: state.workspaceDir,
    run: async (registry) => {
      secondRegistry = registry;
      secondReady();
      await secondFinish;
    },
  });
  try {
    await secondStarted;
    expect(firstRegistry).not.toBe(secondRegistry);
    expect(getSandboxBackendFactory("local-fixture")).not.toBeNull();
    finishFirst();
    await first;
    expect(isPluginRegistryRetired(firstRegistry)).toBe(true);
    expect(isPluginRegistryRetired(secondRegistry)).toBe(false);
    await withPluginRuntimeRegistryScope(secondRegistry, () =>
      assertFullCapabilities(secondRegistry, state.workspaceDir),
    );
    finishSecond();
    await second;
    expect(isPluginRegistryRetired(secondRegistry)).toBe(true);
    expect(getSandboxBackendFactory("local-fixture")).toBeNull();
  } finally {
    finishFirst();
    finishSecond();
    await Promise.allSettled([first, second]);
  }
});
