import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  createAgentToolResultMiddlewareRunner,
  createCodexAppServerToolResultExtensionRunner,
} from "../plugin-sdk/agent-harness.js";
import { listAgentToolResultMiddlewares } from "../plugins/agent-tool-result-middleware.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { clearActivePluginRegistry } from "../plugins/runtime.js";
import {
  cleanupTempPluginTestEnvironment,
  createTempPluginDir,
  resetActivePluginRegistryForTest,
  writeTempPlugin,
} from "./test-helpers/temp-plugin-extension-fixtures.js";

const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalDisableBundledPlugins = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
const tempDirs: string[] = [];
const middlewareId = "tool-result-middleware";
const toolResultEvent = () => ({
  threadId: "thread-1",
  turnId: "turn-1",
  toolCallId: "call-1",
  toolName: "exec",
  args: { command: "git status" },
  result: { content: [{ type: "text" as const, text: "raw" }], details: {} },
});
const enabledOptions = (id: string) => ({
  config: { plugins: { entries: { [id]: { enabled: true } } } },
  onlyPluginIds: [id],
});

function writeMiddleware(
  dir: string,
  id: string,
  text: string,
  bundled = false,
  declaredRuntime = "codex",
) {
  return writeTempPlugin({
    dir,
    id,
    ...(bundled ? { filename: "index.mjs" } : {}),
    manifest: {
      ...(!bundled ? { activation: { onStartup: false } } : {}),
      contracts: { agentToolResultMiddleware: [declaredRuntime] },
    },
    body: `export default { id: ${JSON.stringify(id)}, register(api) {
  api.registerAgentToolResultMiddleware(async (event) => ({
    result: { ...event.result, content: [{ type: "text", text: ${text} }] }
  }), { runtimes: ["codex"] });
} };`,
  });
}

function createBundledTempDir(): string {
  // Bundled-only extension points are tested from the dist-runtime shape because
  // production rejects equivalent registrations from arbitrary plugin paths.
  delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  const dir = createTempPluginDir(tempDirs, "openclaw-codex-ext-", {
    parentDir: path.join(process.cwd(), "dist-runtime", "extensions"),
  });
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;
  return dir;
}

afterEach(async () => {
  await clearActivePluginRegistry();
  clearRuntimeConfigSnapshot();
  cleanupTempPluginTestEnvironment(
    tempDirs,
    originalBundledPluginsDir,
    originalDisableBundledPlugins,
  );
});

it("does not treat auto-enabled runtime config as explicit middleware opt-in", async () => {
  const tmp = createTempPluginDir(tempDirs, "openclaw-codex-ext-");
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

  const pluginFile = writeMiddleware(tmp, middlewareId, 'event.toolName + " should not run"');

  const sourceConfig = { plugins: { load: { paths: [pluginFile] } } };
  setRuntimeConfigSnapshot(
    {
      plugins: {
        ...sourceConfig.plugins,
        entries: enabledOptions(middlewareId).config.plugins.entries,
      },
    },
    sourceConfig,
  );
  resetActivePluginRegistryForTest();

  const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" });
  const result = await runner.applyToolResultMiddleware(toolResultEvent());

  expect(result.content).toEqual([{ type: "text", text: "raw" }]);
  expect(listAgentToolResultMiddlewares("codex")).toHaveLength(0);
});

it("loads missing installed middleware when bundled middleware is already active", async () => {
  const bundledDir = createBundledTempDir();
  const installedDir = createTempPluginDir(tempDirs, "openclaw-codex-ext-");
  writeMiddleware(bundledDir, "bundled", 'event.result.content[0].text + " | bundled"', true);
  const installedPluginFile = writeMiddleware(
    installedDir,
    "installed",
    'event.result.content[0].text + " | installed"',
  );

  const config = {
    plugins: {
      load: { paths: [installedPluginFile] },
      allow: ["bundled", "installed"],
      entries: enabledOptions("bundled").config.plugins.entries,
    },
  };
  loadOpenClawPlugins({ config, onlyPluginIds: ["bundled"] });
  setRuntimeConfigSnapshot(config);

  expect(listAgentToolResultMiddlewares("codex")).toHaveLength(1);

  const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" });
  const result = await runner.applyToolResultMiddleware(toolResultEvent());

  expect(result.content).toEqual([{ type: "text", text: "raw | bundled | installed" }]);
  expect(listAgentToolResultMiddlewares("codex")).toHaveLength(1);
});

it("preserves tool output when published Codex plugins omit factories", async () => {
  const runner = createCodexAppServerToolResultExtensionRunner({ sessionKey: "agent:main:test" });
  const event = toolResultEvent();
  await expect(runner.applyToolResultExtensions(event)).resolves.toBe(event.result);
});

it("initializes async Codex app-server extension factories in registration order", async () => {
  const steps: string[] = [];
  const firstFactory = Promise.withResolvers<void>();
  const runner = createCodexAppServerToolResultExtensionRunner({}, [
    async (codex) => {
      await firstFactory.promise;
      codex.on("tool_result", async () => {
        steps.push("first");
      });
    },
    async (codex) => {
      codex.on("tool_result", async ({ result }) => {
        steps.push("second");
        return { result };
      });
    },
  ]);

  firstFactory.resolve();
  await runner.applyToolResultExtensions(toolResultEvent());

  expect(steps).toEqual(["first", "second"]);
});

it("restores plugin-registered middleware from cache", async () => {
  const dir = createBundledTempDir();
  writeMiddleware(dir, middlewareId, 'event.toolName + " compacted"', true);
  const options = enabledOptions(middlewareId);
  setRuntimeConfigSnapshot(options.config);
  loadOpenClawPlugins(options);
  expect(listAgentToolResultMiddlewares("codex")).toHaveLength(1);
  expect(listAgentToolResultMiddlewares("openclaw")).toHaveLength(0);
  resetActivePluginRegistryForTest();
  expect(listAgentToolResultMiddlewares("codex")).toHaveLength(0);
  loadOpenClawPlugins(options);
  const result = await createAgentToolResultMiddlewareRunner({
    runtime: "codex",
  }).applyToolResultMiddleware(toolResultEvent());
  expect(result.content).toEqual([{ type: "text", text: "exec compacted" }]);
});

it("rejects middleware without its runtime contract", () => {
  const dir = createBundledTempDir();
  writeMiddleware(dir, middlewareId, '"unreachable"', true, "openclaw");
  const registry = loadOpenClawPlugins(enabledOptions(middlewareId));
  expect(registry.diagnostics).toContainEqual(
    expect.objectContaining({
      level: "error",
      pluginId: middlewareId,
      message: "plugin must declare contracts.agentToolResultMiddleware for: codex",
    }),
  );
  expect(listAgentToolResultMiddlewares("codex")).toHaveLength(0);
});
