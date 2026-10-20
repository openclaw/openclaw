import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  createAgentToolResultMiddlewareRunner,
  createCodexAppServerToolResultExtensionRunner,
} from "../plugin-sdk/agent-harness.js";
import { listAgentToolResultMiddlewares } from "../plugins/agent-tool-result-middleware.js";
import { listCodexAppServerExtensionFactories } from "../plugins/codex-app-server-extension-factory.js";
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
const extensionContract = { embeddedExtensionFactories: ["codex-app-server"] };
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

function expectDiagnostic(
  diagnostics: readonly { level?: string; pluginId?: string; message?: string }[],
  pluginId: string,
  message: string,
): void {
  expect(
    diagnostics.find(
      (diagnostic) => diagnostic.pluginId === pluginId && diagnostic.message === message,
    )?.level,
  ).toBe("error");
}

function createTempDir(): string {
  return createTempPluginDir(tempDirs, "openclaw-codex-ext-");
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
    const tmp = createTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

    const pluginFile = writeTempPlugin({
      dir: tmp,
      id: "tool-result-middleware",
      manifest: { activation: { onStartup: false }, contracts: middlewareContract },
      body: `export default { id: "tool-result-middleware", register(api) {
  api.registerAgentToolResultMiddleware(async (event) => ({
    result: { ...event.result, content: [{ type: "text", text: event.toolName + " should not run" }] }
  }), { runtimes: ["codex"] });
} };`,
    });

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
    const installedDir = createTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;

    writeTempPlugin({
      dir: bundledDir,
      id: "bundled-tool-result-middleware",
      filename: "index.mjs",
      manifest: { contracts: middlewareContract },
      body: `export default { id: "bundled-tool-result-middleware", register(api) {
  api.registerAgentToolResultMiddleware(async (event) => ({
    result: { ...event.result, content: [{ type: "text", text: event.result.content[0].text + " | bundled" }] }
  }), { runtimes: ["codex"] });
} };`,
    });
    const installedPluginFile = writeTempPlugin({
      dir: installedDir,
      id: "installed-tool-result-middleware",
      manifest: { activation: { onStartup: false }, contracts: middlewareContract },
      body: `export default { id: "installed-tool-result-middleware", register(api) {
  api.registerAgentToolResultMiddleware(async (event) => ({
    result: { ...event.result, content: [{ type: "text", text: event.result.content[0].text + " | installed" }] }
  }), { runtimes: ["codex"] });
} };`,
    });

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

describe("Codex app-server extension factories", () => {
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

it.each([
  {
    id: "tool-result-middleware",
    contracts: middlewareContract,
    text: "exec compacted",
    registration: `api.registerAgentToolResultMiddleware(async (event) => ({
    result: { ...event.result, content: [{ type: "text", text: event.toolName + " compacted" }] }
  }), { runtimes: ["codex"] });`,
    list: () => listAgentToolResultMiddlewares("codex"),
    apply: () =>
      createAgentToolResultMiddlewareRunner({ runtime: "codex" }).applyToolResultMiddleware(
        toolResultEvent(),
      ),
  },
  {
    id: "codex-ext",
    contracts: extensionContract,
    text: "compacted",
    registration: `api.registerCodexAppServerExtensionFactory((codex) => {
    codex.on("tool_result", async (event) => ({
      result: { ...event.result, content: [{ type: "text", text: "compacted" }] }
    }));
  });`,
    list: listCodexAppServerExtensionFactories,
    apply: () =>
      createCodexAppServerToolResultExtensionRunner({}).applyToolResultExtensions(
        toolResultEvent(),
      ),
  },
])(
  "restores plugin-registered $id from cache",
  async ({ id, contracts, registration, text, list, apply }) => {
    const dir = createBundledTempDir();
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;
    writeTempPlugin({
      dir,
      id,
      filename: "index.mjs",
      manifest: { contracts },
      body: `export default { id: ${JSON.stringify(id)}, register(api) {
  ${registration}
} };`,
    });
    const options = enabledOptions(id);
    setRuntimeConfigSnapshot(options.config);
    loadOpenClawPlugins(options);
    expect(list()).toHaveLength(1);
    if (id === "tool-result-middleware") {
      expect(listAgentToolResultMiddlewares("openclaw")).toHaveLength(0);
    }
    resetActivePluginRegistryForTest();
    expect(list()).toHaveLength(0);
    loadOpenClawPlugins(options);
    expect((await apply()).content).toEqual([{ type: "text", text }]);
  },
);

it.each([
  {
    name: "middleware without its runtime contract",
    bundled: true,
    middleware: true,
    manifest: { contracts: { agentToolResultMiddleware: ["openclaw"] } },
    diagnostic: "plugin must declare contracts.agentToolResultMiddleware for: codex",
  },
  {
    name: "external extension factories even with their contract",
    bundled: false,
    middleware: false,
    manifest: { contracts: extensionContract },
    diagnostic: "only bundled plugins can register Codex app-server extension factories",
  },
  {
    name: "bundled extension factories without their contract",
    bundled: true,
    middleware: false,
    manifest: {},
    diagnostic:
      'plugin must declare contracts.embeddedExtensionFactories: ["codex-app-server"] to register Codex app-server extension factories',
  },
])("rejects $name", ({ bundled, middleware, manifest, diagnostic }) => {
  const dir = bundled ? createBundledTempDir() : createTempDir();
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundled ? dir : "/nonexistent/bundled/plugins";
  const id = middleware ? "tool-result-middleware" : "codex-ext";
  const registration = middleware
    ? 'registerAgentToolResultMiddleware(() => undefined, { runtimes: ["codex"] })'
    : "registerCodexAppServerExtensionFactory(() => undefined)";
  const file = writeTempPlugin({
    dir,
    id,
    manifest,
    filename: bundled ? "index.mjs" : undefined,
    body: `export default { id: ${JSON.stringify(id)}, register(api) {
  api.${registration};
} };`,
  });
  const registry = loadOpenClawPlugins(
    bundled
      ? enabledOptions(id)
      : {
          workspaceDir: dir,
          onlyPluginIds: [id],
          config: { plugins: { load: { paths: [file] }, allow: [id] } },
        },
  );
  expectDiagnostic(registry.diagnostics, id, diagnostic);
  expect(
    middleware ? listAgentToolResultMiddlewares("codex") : listCodexAppServerExtensionFactories(),
  ).toHaveLength(0);
});
