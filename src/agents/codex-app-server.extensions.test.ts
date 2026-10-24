import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
const middlewareContract = { agentToolResultMiddleware: ["codex"] };
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

function writeMiddleware(dir: string, id: string, text: string, bundled = false) {
  return writeTempPlugin({
    dir,
    id,
    ...(bundled ? { filename: "index.mjs" } : {}),
    manifest: {
      ...(!bundled ? { activation: { onStartup: false } } : {}),
      contracts: middlewareContract,
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
  return createTempPluginDir(tempDirs, "openclaw-codex-ext-", {
    parentDir: path.join(process.cwd(), "dist-runtime", "extensions"),
  });
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

describe("agent tool result middleware", () => {
  it("does not treat auto-enabled runtime config as explicit middleware opt-in", async () => {
    const tmp = createTempPluginDir(tempDirs, "openclaw-codex-ext-");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    const pluginFile = writeMiddleware(
      tmp,
      "tool-result-middleware",
      'event.toolName + " should not run"',
    );

    const sourceConfig = { plugins: { load: { paths: [pluginFile] } } };
    setRuntimeConfigSnapshot(
      {
        plugins: {
          load: { paths: [pluginFile] },
          entries: enabledOptions("tool-result-middleware").config.plugins.entries,
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
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

    writeMiddleware(
      bundledDir,
      "bundled-tool-result-middleware",
      'event.result.content[0].text + " | bundled"',
      true,
    );
    const installedPluginFile = writeMiddleware(
      installedDir,
      "installed-tool-result-middleware",
      'event.result.content[0].text + " | installed"',
    );

    const config = {
      plugins: {
        load: { paths: [installedPluginFile] },
        allow: ["bundled-tool-result-middleware", "installed-tool-result-middleware"],
        entries: enabledOptions("bundled-tool-result-middleware").config.plugins.entries,
      },
    };
    loadOpenClawPlugins({ config, onlyPluginIds: ["bundled-tool-result-middleware"] });
    setRuntimeConfigSnapshot(config);

    expect(listAgentToolResultMiddlewares("codex")).toHaveLength(1);

    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" });
    const result = await runner.applyToolResultMiddleware(toolResultEvent());

    expect(result.content).toEqual([{ type: "text", text: "raw | bundled | installed" }]);
    expect(listAgentToolResultMiddlewares("codex")).toHaveLength(1);
  });
});

describe("standalone Codex tool result extension runner", () => {
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
        codex.on("tool_result", async ({ result }) => {
          steps.push("first");
          return {
            result: {
              ...result,
              content: [{ type: "text", text: `${result.content[0]?.type}:${steps.length}` }],
            },
          };
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
});

it("restores plugin-registered middleware from cache", async () => {
  const dir = createBundledTempDir();
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;
  const id = "tool-result-middleware";
  writeMiddleware(dir, id, 'event.toolName + " compacted"', true);
  const options = enabledOptions(id);
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
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;
  const id = "tool-result-middleware";
  writeTempPlugin({
    dir,
    id,
    manifest: { contracts: { agentToolResultMiddleware: ["openclaw"] } },
    filename: "index.mjs",
    body: `export default { id: "tool-result-middleware", register(api) {
  api.registerAgentToolResultMiddleware(() => undefined, { runtimes: ["codex"] });
} };`,
  });
  const registry = loadOpenClawPlugins(enabledOptions(id));
  expect(registry.diagnostics).toContainEqual(
    expect.objectContaining({
      level: "error",
      pluginId: id,
      message: "plugin must declare contracts.agentToolResultMiddleware for: codex",
    }),
  );
  expect(listAgentToolResultMiddlewares("codex")).toHaveLength(0);
});
