import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const WORKER_DEPLOY_BUILD_PLUGIN_NAME = "openclaw:worker-deploy";
export const WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID = `${path.resolve("src/worker/worker-deploy-runtime.ts")}?optional-native`;

const PLAYWRIGHT_PACKAGE_INIT = `    packageRoot = import_path9.default.join(__dirname, "..");
    packageJSON = require(import_path9.default.join(packageRoot, "package.json"));
    binPath = import_path9.default.join(packageRoot, "bin");`;
const PLAYWRIGHT_BROWSER_REGISTRY_INIT =
  '    registry = new Registry(require(import_path20.default.join(packageRoot, "browsers.json")));';
// Keep Browser and Playwright initialization behind the admitted Browser factory.
const WORKER_BROWSER_RUNTIME_COMPOSITION = `export default {
  async createAttachedBrowserToolRuntime(params) {
    const { createAttachedBrowserToolRuntime } = await import("../../extensions/browser/runtime-api.js");
    return createAttachedBrowserToolRuntime(params);
  }
};`;
const WORKER_PLAYWRIGHT_RUNTIME = `import * as playwrightCore from "playwright-core";
import { getUserAgent } from "playwright-core/lib/coreBundle";
export function getPlaywrightCore() { return playwrightCore; }
export function getPlaywrightUserAgent() { return getUserAgent(); }`;
const UNDICI_REQUIRE_BOOTSTRAP = [
  'import { createRequire } from "node:module";',
  "const requireUndici = createRequire(import.meta.url);\n",
  'let undiciModule: typeof import("undici") | undefined;\n',
  'return (undiciModule ??= requireUndici("undici/index.js") as typeof import("undici"));',
] as const;
const WORKER_UNDICI_IMPORT = 'import * as bundledUndici from "undici/index.js";';
const WS_DIRECT_RUNTIME_FRAGMENTS = [
  'require.resolve("ws/package.json")',
  '"lib/websocket.js"',
  '"lib/websocket-server.js"',
  '"lib/stream.js"',
] as const;
const WS_DYNAMIC_IMPORT =
  'pathToFileURL(path.join(path.dirname(require.resolve("ws/package.json")), "wrapper.mjs")).href';
const TREE_SITTER_INIT = "TreeSitter.Parser.init()";
const TREE_SITTER_BASH_WASM = 'require.resolve("tree-sitter-bash/tree-sitter-bash.wasm")';

function resolveOptionalBuildSource(source: string): string {
  const resolved = path.resolve(source);
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
}

export function resolveWorkerDeployGeneratorInputs(rootDir = process.cwd()) {
  const playwrightRoot = fs.realpathSync(path.resolve(rootDir, "node_modules/playwright-core"));
  return [
    path.join(playwrightRoot, "package.json"),
    path.join(playwrightRoot, "browsers.json"),
    fs.realpathSync(path.resolve(rootDir, "node_modules/web-tree-sitter/web-tree-sitter.wasm")),
    fs.realpathSync(path.resolve(rootDir, "node_modules/tree-sitter-bash/tree-sitter-bash.wasm")),
  ] as const;
}

/** The worker archive stages entry files only; emitted runtime auxiliaries have no owner. */
export function isUnstagedWorkerDeployRuntimeArtifact(
  fileName: string,
  entrypoints: ReadonlySet<string>,
): boolean {
  return !entrypoints.has(fileName) && /\.(?:mjs|node|wasm)$/u.test(fileName);
}

/** Composes bundled-plugin runtime and removes dependency package reads from the worker build. */
export function createWorkerDeployBuildPlugin(rootDir = process.cwd()) {
  const require = createRequire(import.meta.url);
  const resolveWsWrapperUrl = () =>
    pathToFileURL(
      fs.realpathSync(path.join(path.dirname(require.resolve("ws/package.json")), "wrapper.mjs")),
    ).href;
  const playwrightRoot = fs.realpathSync(path.resolve(rootDir, "node_modules/playwright-core"));
  const coreBundlePath = fs.realpathSync(path.join(playwrightRoot, "lib/coreBundle.js"));
  const browserRuntimeBridgePath = fs.realpathSync(
    path.resolve("src/worker/worker-deploy-browser-runtime.ts"),
  );
  const playwrightRuntimePath = fs.realpathSync(
    path.resolve("extensions/browser/src/browser/playwright-core.runtime.ts"),
  );
  const undiciDispatcherOptionsPath = fs.realpathSync(
    path.resolve("src/infra/net/undici-dispatcher-options.ts"),
  );
  const treeSitterRuntimePath = fs.realpathSync(
    path.resolve("src/infra/command-explainer/tree-sitter-runtime.ts"),
  );
  const websocketRuntimePath = fs.realpathSync(
    path.resolve("packages/gateway-client/src/websocket.ts"),
  );
  const dynamicWebsocketRuntimePaths = new Set(
    [
      "src/node-host/node-stream-transport.ts",
      "src/realtime-transcription/websocket-session.ts",
    ].map(resolveOptionalBuildSource),
  );
  const [packageJsonPath, browsersJsonPath, treeSitterWasmPath, bashWasmPath] =
    resolveWorkerDeployGeneratorInputs(rootDir);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    name: string;
    version: string;
  };
  const browsersJson = JSON.parse(fs.readFileSync(browsersJsonPath, "utf8")) as unknown;
  const replacement = `    packageRoot = __dirname;
    packageJSON = ${JSON.stringify({ name: packageJson.name, version: packageJson.version })};
    binPath = packageRoot;`;

  return {
    name: WORKER_DEPLOY_BUILD_PLUGIN_NAME,
    generateBundle(
      this: { error(message: string): never },
      _options: unknown,
      bundle: Record<string, { type: string; fileName: string; isEntry?: boolean }>,
    ) {
      const files = Object.values(bundle);
      const entrypoints = new Set(
        files.filter((file) => file.type === "chunk" && file.isEntry).map((file) => file.fileName),
      );
      // Check the complete emitted graph: a root facade is outside the later worker-directory scan.
      for (const file of files) {
        if (isUnstagedWorkerDeployRuntimeArtifact(file.fileName, entrypoints)) {
          this.error(`Worker deploy artifact emits unstaged runtime asset ${file.fileName}.`);
        }
      }
    },
    load(id: string) {
      return id === WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID
        ? 'throw new Error("optional host-native dependency unavailable in portable worker runtime");'
        : null;
    },
    transform(this: { error(message: string): never }, code: string, id: string) {
      let resolvedId: string;
      try {
        resolvedId = fs.realpathSync(path.resolve(id));
      } catch {
        return null;
      }
      if (resolvedId === browserRuntimeBridgePath) {
        return WORKER_BROWSER_RUNTIME_COMPOSITION;
      }
      if (resolvedId === playwrightRuntimePath) {
        return WORKER_PLAYWRIGHT_RUNTIME;
      }
      if (resolvedId === treeSitterRuntimePath) {
        if (!code.includes(TREE_SITTER_INIT) || !code.includes(TREE_SITTER_BASH_WASM)) {
          this.error("tree-sitter bootstrap changed; update the worker deploy transform");
        }
        // Sealed workers cannot read dependency assets. Keep byte decoding in the lazy parser.
        return code
          .replace(
            TREE_SITTER_INIT,
            `TreeSitter.Parser.init({ wasmBinary: Buffer.from(${JSON.stringify(fs.readFileSync(treeSitterWasmPath).toString("base64"))}, "base64") })`,
          )
          .replace(
            TREE_SITTER_BASH_WASM,
            `Buffer.from(${JSON.stringify(fs.readFileSync(bashWasmPath).toString("base64"))}, "base64")`,
          );
      }
      // Installed ws paths avoid Bun's adapter; portable Node workers must bundle
      // that same transport instead of resolving a missing package at runtime.
      if (resolvedId === websocketRuntimePath) {
        if (WS_DIRECT_RUNTIME_FRAGMENTS.some((fragment) => !code.includes(fragment))) {
          this.error("ws bootstrap changed; update the worker deploy transform");
        }
        const wsWrapperUrl = resolveWsWrapperUrl();
        return `import * as bundledWebSocket from ${JSON.stringify(wsWrapperUrl)};
export const { WebSocket, WebSocketServer, createWebSocketStream } = bundledWebSocket;`;
      }
      if (dynamicWebsocketRuntimePaths.has(resolvedId)) {
        if (!code.includes(WS_DYNAMIC_IMPORT)) {
          this.error("ws dynamic bootstrap changed; update the worker deploy transform");
        }
        return code.replace(WS_DYNAMIC_IMPORT, JSON.stringify(resolveWsWrapperUrl()));
      }
      if (resolvedId === undiciDispatcherOptionsPath) {
        if (UNDICI_REQUIRE_BOOTSTRAP.some((fragment) => !code.includes(fragment))) {
          this.error("undici dispatcher bootstrap changed; update the worker deploy transform");
        }
        return code
          .replace(UNDICI_REQUIRE_BOOTSTRAP[0], WORKER_UNDICI_IMPORT)
          .replace(UNDICI_REQUIRE_BOOTSTRAP[1], "")
          .replace(UNDICI_REQUIRE_BOOTSTRAP[2], "")
          .replace(UNDICI_REQUIRE_BOOTSTRAP[3], "return bundledUndici;");
      }
      if (
        resolvedId !== coreBundlePath ||
        !id.replaceAll("\\", "/").endsWith("/playwright-core/lib/coreBundle.js")
      ) {
        return null;
      }
      if (
        !code.includes(PLAYWRIGHT_PACKAGE_INIT) ||
        !code.includes(PLAYWRIGHT_BROWSER_REGISTRY_INIT)
      ) {
        this.error("playwright-core package bootstrap changed; update the worker deploy transform");
      }
      return code
        .replace(PLAYWRIGHT_PACKAGE_INIT, replacement)
        .replace(
          PLAYWRIGHT_BROWSER_REGISTRY_INIT,
          `    registry = new Registry(${JSON.stringify(browsersJson)});`,
        );
    },
  };
}
