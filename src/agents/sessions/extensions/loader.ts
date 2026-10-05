import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { createJiti } from "jiti/static";
// Static imports of packages that extensions may use.
// These MUST be static so Bun bundles them into the compiled binary.
// The virtualModules option then makes them available to extensions.
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxError from "typebox/error";
import * as bundledTypeboxFormat from "typebox/format";
import * as bundledTypeboxGuard from "typebox/guard";
import * as bundledTypeboxSchema from "typebox/schema";
import * as bundledTypeboxSystem from "typebox/system";
import * as bundledTypeboxType from "typebox/type";
import * as bundledTypeboxValue from "typebox/value";
import * as bundledAgentCore from "../../../plugin-sdk/agent-core.js";
import * as bundledLlm from "../../../plugin-sdk/llm.js";
import { installOpenClawInternalCorePackageNativeResolver } from "../../../plugins/plugin-sdk-native-resolver.js";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
} from "../../../plugins/sdk-alias.js";
import { isBunBinary } from "../../package-metadata.js";
import { createEventBus, type EventBus } from "../event-bus.js";
import type { ExecOptions } from "../exec.js";
import { execCommand } from "../exec.js";
import * as bundledAgentSessions from "../extension-sdk.js";
import { warnSessionPersistenceDeprecation } from "../session-persistence-deprecation.js";
import { createSyntheticSourceInfo } from "../source-info.js";
import type {
  Extension,
  ExtensionAPI,
  ExtensionFactory,
  ExtensionRuntime,
  ExtensionRuntimeV2,
  ExtensionShortcut,
  LoadExtensionsResult,
  MessageRenderer,
  RegisteredCommand,
  ToolDefinition,
} from "./types.js";

/** Canonical host modules shared by source extensions and compiled binaries. */
const VIRTUAL_MODULES: Record<string, unknown> = {
  typebox: bundledTypebox,
  "typebox/compile": bundledTypeboxCompile,
  "typebox/error": bundledTypeboxError,
  "typebox/format": bundledTypeboxFormat,
  "typebox/guard": bundledTypeboxGuard,
  "typebox/schema": bundledTypeboxSchema,
  "typebox/system": bundledTypeboxSystem,
  "typebox/type": bundledTypeboxType,
  "typebox/value": bundledTypeboxValue,
  "@sinclair/typebox": bundledTypebox,
  "@sinclair/typebox/compile": bundledTypeboxCompile,
  "@sinclair/typebox/format": bundledTypeboxFormat,
  "@sinclair/typebox/value": bundledTypeboxValue,
  "openclaw/plugin-sdk/agent-core": bundledAgentCore,
  "@openclaw/plugin-sdk/agent-core": bundledAgentCore,
  "openclaw/plugin-sdk/llm": bundledLlm,
  "@openclaw/plugin-sdk/llm": bundledLlm,
  "openclaw/plugin-sdk/agent-sessions": bundledAgentSessions,
  "@openclaw/plugin-sdk/agent-sessions": bundledAgentSessions,
};

const require = createRequire(import.meta.url);

let createJitiLoaderFactory: typeof createJiti | undefined;
let nativeExtensionLoadCounter = 0;
// One cwd slot bounds the process cache. The generation keeps an in-flight
// load from repopulating it after an explicit reload or cwd change.
let extensionCacheCwd: string | undefined;
let extensionCacheGeneration = 0;
const extensionFactoryCache = new Map<string, ExtensionFactory>();
const EXTENSION_LOADER_ALIAS_IMPORT_PATTERN =
  /(?:@openclaw\/plugin-sdk|openclaw\/plugin-sdk|@sinclair\/typebox|typebox)(?:\/[A-Za-z0-9_-]+)?/u;
const RELATIVE_EXTENSION_IMPORT_PATTERN =
  /(?:import\s*(?:[^'"]*?\s*from\s*)?["']\.{1,2}\/|export\s*(?:[^'"]*?\s*from\s*)["']\.{1,2}\/|import\s*\(\s*["']\.{1,2}\/|require\s*\(\s*["']\.{1,2}\/)/u;

async function loadCreateJitiLoaderFactory(): Promise<typeof createJiti> {
  if (createJitiLoaderFactory) {
    return createJitiLoaderFactory;
  }
  ({ createJiti: createJitiLoaderFactory } = await import("jiti/static"));
  return createJitiLoaderFactory;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function expandPath(p: string): string {
  const normalized = p.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("~/")) {
    return path.join(os.homedir(), normalized.slice(2));
  }
  if (normalized.startsWith("~")) {
    return path.join(os.homedir(), normalized.slice(1));
  }
  return normalized;
}

function resolvePath(extPath: string, cwd: string): string {
  const expanded = expandPath(extPath);
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  return path.resolve(cwd, expanded);
}

type HandlerFn = NonNullable<ReturnType<Extension["handlers"]["get"]>>[number];

type ExtensionCacheScope = {
  cwd: string;
  generation: number;
};

type ExtensionLoadContext = {
  cacheScope: ExtensionCacheScope;
  sourceTransformLoader?: ReturnType<typeof createJiti>;
};

export function clearExtensionCache(): void {
  extensionFactoryCache.clear();
  extensionCacheCwd = undefined;
  extensionCacheGeneration++;
}

function useExtensionCacheCwd(cwd: string): ExtensionCacheScope {
  const resolvedCwd = path.resolve(expandPath(cwd));
  if (extensionCacheCwd !== undefined && extensionCacheCwd !== resolvedCwd) {
    clearExtensionCache();
  }
  extensionCacheCwd = resolvedCwd;
  return { cwd: resolvedCwd, generation: extensionCacheGeneration };
}

function isCurrentCacheScope(scope: ExtensionCacheScope): boolean {
  return extensionCacheCwd === scope.cwd && extensionCacheGeneration === scope.generation;
}

/**
 * Create a runtime with throwing stubs for action methods.
 * Runner.bindCore() replaces these with real implementations.
 */
export function createExtensionRuntime(): ExtensionRuntime {
  const notInitialized = () => {
    throw new Error(
      "Extension runtime not initialized. Action methods cannot be called during extension loading.",
    );
  };
  let staleMessage: string | undefined;
  const assertActive = () => {
    if (staleMessage) {
      throw new Error(staleMessage);
    }
  };

  const runtime: ExtensionRuntimeV2 = {
    sendMessage: notInitialized,
    sendUserMessage: notInitialized,
    appendEntry: notInitialized,
    appendEntryAsync: notInitialized,
    setSessionName: notInitialized,
    setSessionNameAsync: notInitialized,
    getSessionName: notInitialized,
    setLabel: notInitialized,
    setLabelAsync: notInitialized,
    getActiveTools: notInitialized,
    getAllTools: notInitialized,
    setActiveTools: notInitialized,
    // registerTool() is valid during extension load; refresh is only needed post-bind.
    refreshTools: () => {},
    getCommands: notInitialized,
    setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
    getThinkingLevel: notInitialized,
    setThinkingLevel: notInitialized,
    flagValues: new Map(),
    pendingProviderRegistrations: [],
    assertActive,
    invalidate: (message) => {
      staleMessage ??=
        message ??
        "This extension ctx is stale after session replacement or reload. Do not use a captured api or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
    },
    // Pre-bind: queue registrations so bindCore() can flush them once the
    // model registry is available. bindCore() replaces both with direct calls.
    registerProvider: (name, config, extensionPath = "<unknown>") => {
      runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
    },
    unregisterProvider: (name) => {
      runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter(
        (r) => r.name !== name,
      );
    },
  };

  return runtime;
}

/**
 * Create the ExtensionAPI for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
function createExtensionAPI(
  extension: Extension,
  runtime: ExtensionRuntime,
  cwd: string,
  eventBus: EventBus,
): ExtensionAPI {
  const activeRuntime = () => {
    runtime.assertActive();
    return runtime;
  };
  return {
    // Registration methods - write to extension
    on(event: string, handler: HandlerFn): void {
      runtime.assertActive();
      const list = extension.handlers.get(event) ?? [];
      list.push(handler);
      extension.handlers.set(event, list);
    },

    registerTool(tool: ToolDefinition): void {
      runtime.assertActive();
      extension.tools.set(tool.name, {
        definition: tool,
        sourceInfo: extension.sourceInfo,
      });
      runtime.refreshTools();
    },

    registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
      runtime.assertActive();
      extension.commands.set(name, {
        name,
        sourceInfo: extension.sourceInfo,
        ...options,
      });
    },

    registerShortcut(
      shortcut: ExtensionShortcut["shortcut"],
      options: {
        description?: string;
        handler: (ctx: import("./types.js").ExtensionContext) => Promise<void> | void;
      },
    ): void {
      runtime.assertActive();
      extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
    },

    registerFlag(
      name: string,
      options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
    ): void {
      runtime.assertActive();
      extension.flags.set(name, { name, extensionPath: extension.path, ...options });
      if (options.default !== undefined && !runtime.flagValues.has(name)) {
        runtime.flagValues.set(name, options.default);
      }
    },

    registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
      runtime.assertActive();
      extension.messageRenderers.set(customType, renderer as MessageRenderer);
    },

    // Flag access - checks extension registered it, reads from runtime
    getFlag(name: string): boolean | string | undefined {
      runtime.assertActive();
      if (!extension.flags.has(name)) {
        return undefined;
      }
      return runtime.flagValues.get(name);
    },

    sendMessage: (message, options) => {
      activeRuntime().sendMessage(message, options);
    },
    sendUserMessage: (content, options) => {
      activeRuntime().sendUserMessage(content, options);
    },
    // Retained synchronous adapters for third-party extensions until the next SDK major.
    appendEntry: (customType, data) => {
      warnSessionPersistenceDeprecation("ExtensionAPI.appendEntry", "appendEntryAsync");
      activeRuntime().appendEntry(customType, data);
    },
    appendEntryAsync: async (customType, data) => {
      const owner = activeRuntime();
      if (!owner.appendEntryAsync) {
        throw new Error("Extension host must bind worker persistence with bindCoreAsync");
      }
      const id = await owner.appendEntryAsync(customType, data);
      owner.assertActive();
      return id;
    },
    setSessionName: (name) => {
      warnSessionPersistenceDeprecation("ExtensionAPI.setSessionName", "setSessionNameAsync");
      activeRuntime().setSessionName(name);
    },
    setSessionNameAsync: async (name) => {
      const owner = activeRuntime();
      if (!owner.setSessionNameAsync) {
        throw new Error("Extension host must bind worker persistence with bindCoreAsync");
      }
      await owner.setSessionNameAsync(name);
      owner.assertActive();
    },
    getSessionName: () => activeRuntime().getSessionName(),
    setLabel: (entryId, label) => {
      warnSessionPersistenceDeprecation("ExtensionAPI.setLabel", "setLabelAsync");
      activeRuntime().setLabel(entryId, label);
    },
    setLabelAsync: async (entryId, label) => {
      const owner = activeRuntime();
      if (!owner.setLabelAsync) {
        throw new Error("Extension host must bind worker persistence with bindCoreAsync");
      }
      await owner.setLabelAsync(entryId, label);
      owner.assertActive();
    },
    exec(command: string, args: string[], options?: ExecOptions) {
      runtime.assertActive();
      return execCommand(command, args, options?.cwd ?? cwd, options);
    },
    getActiveTools: () => activeRuntime().getActiveTools(),
    getAllTools: () => activeRuntime().getAllTools(),
    setActiveTools: (toolNames) => {
      activeRuntime().setActiveTools(toolNames);
    },
    getCommands: () => activeRuntime().getCommands(),
    setModel: (model) => activeRuntime().setModel(model),
    getThinkingLevel: () => activeRuntime().getThinkingLevel(),
    setThinkingLevel: (level) => activeRuntime().setThinkingLevel(level),
    registerProvider: (name, config) => {
      activeRuntime().registerProvider(name, config, extension.path);
    },
    unregisterProvider: (name) => {
      activeRuntime().unregisterProvider(name, extension.path);
    },

    events: eventBus,
  } as ExtensionAPI;
}

function resolveExtensionFactory(module: unknown): ExtensionFactory | undefined {
  const candidate =
    typeof module === "object" && module !== null && "default" in module
      ? (module as { default?: unknown }).default
      : module;
  if (typeof candidate === "function") {
    return candidate as ExtensionFactory;
  }
  const nestedCandidate =
    typeof candidate === "object" && candidate !== null && "default" in candidate
      ? (candidate as { default?: unknown }).default
      : undefined;
  return typeof nestedCandidate === "function" ? (nestedCandidate as ExtensionFactory) : undefined;
}

function isJavaScriptExtensionPath(extensionPath: string): boolean {
  const extension = path.extname(extensionPath).toLowerCase();
  return extension === ".cjs" || extension === ".mjs";
}

function extensionSourceNeedsJitiAliasResolution(extensionPath: string): boolean {
  try {
    const source = fs.readFileSync(extensionPath, "utf8");
    return (
      EXTENSION_LOADER_ALIAS_IMPORT_PATTERN.test(source) ||
      RELATIVE_EXTENSION_IMPORT_PATTERN.test(source)
    );
  } catch {
    return true;
  }
}

function shouldLoadExtensionWithNativeImport(extensionPath: string): boolean {
  return (
    !isBunBinary &&
    isJavaScriptExtensionPath(extensionPath) &&
    !extensionSourceNeedsJitiAliasResolution(extensionPath)
  );
}

async function loadNativeExtensionModule(
  extensionPath: string,
): Promise<ExtensionFactory | undefined> {
  const url = pathToFileURL(extensionPath);
  url.searchParams.set("v", String(++nativeExtensionLoadCounter));
  try {
    const cachedPath = require.resolve(extensionPath);
    delete require.cache[cachedPath];
  } catch {
    // ESM-only entries are not present in require's cache.
  }
  return resolveExtensionFactory(await import(url.href));
}

async function loadExtensionSourceTransformModule(
  extensionPath: string,
  context: ExtensionLoadContext,
): Promise<ExtensionFactory | undefined> {
  if (!context.sourceTransformLoader) {
    installOpenClawInternalCorePackageNativeResolver({ moduleUrl: import.meta.url });
    const createJitiLoader = await loadCreateJitiLoaderFactory();
    const aliases = isBunBinary
      ? {}
      : buildPluginLoaderAliasMap(fileURLToPath(import.meta.url), process.argv[1], import.meta.url);
    context.sourceTransformLoader = createJitiLoader(import.meta.url, {
      ...buildPluginLoaderJitiOptions(aliases),
      // Share the host SDK graph; entry-file aliases misresolve package subpaths
      // and re-evaluate SDK dependencies instead of using their native owners.
      virtualModules: VIRTUAL_MODULES,
      // Extension entry modules must bypass the native ESM cache so an explicit
      // reload observes edited source. Product modules stay native via nativeModules.
      tryNative: false,
      moduleCache: false,
    });
  }

  return resolveExtensionFactory(
    await context.sourceTransformLoader.import(extensionPath, { default: true }),
  );
}

async function loadExtensionModule(
  extensionPath: string,
  context: ExtensionLoadContext,
): Promise<ExtensionFactory | undefined> {
  if (isCurrentCacheScope(context.cacheScope)) {
    const cachedFactory = extensionFactoryCache.get(extensionPath);
    if (cachedFactory) {
      return cachedFactory;
    }
  }

  const factory = shouldLoadExtensionWithNativeImport(extensionPath)
    ? await loadNativeExtensionModule(extensionPath)
    : await loadExtensionSourceTransformModule(extensionPath, context);
  if (factory && isCurrentCacheScope(context.cacheScope)) {
    extensionFactoryCache.set(extensionPath, factory);
  }
  return factory;
}

function createExtension(extensionPath: string, resolvedPath: string): Extension {
  const source =
    extensionPath.startsWith("<") && extensionPath.endsWith(">")
      ? extensionPath.slice(1, -1).split(":")[0] || "temporary"
      : "local";
  const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(resolvedPath);

  return {
    path: extensionPath,
    resolvedPath,
    sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

export async function loadExtensionFromFactory(
  factory: ExtensionFactory,
  cwd: string,
  eventBus: EventBus,
  runtime: ExtensionRuntime,
  extensionPath = "<inline>",
): Promise<Extension> {
  const extension = createExtension(extensionPath, extensionPath);
  const api = createExtensionAPI(extension, runtime, cwd, eventBus);
  await factory(api);
  return extension;
}

export async function loadExtensionsCached(
  paths: string[],
  cwd: string,
  eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
  const extensions: Extension[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  const resolvedEventBus = eventBus ?? createEventBus();
  const runtime = createExtensionRuntime();
  const cacheScope = useExtensionCacheCwd(cwd);
  const resolvedCwd = cacheScope.cwd;
  const context: ExtensionLoadContext = { cacheScope };

  for (const extPath of paths) {
    const resolvedPath = resolvePath(extPath, resolvedCwd);
    try {
      const factory = await loadExtensionModule(resolvedPath, context);
      if (!factory) {
        errors.push({
          path: extPath,
          error: `Extension does not export a valid factory function: ${extPath}`,
        });
        continue;
      }
      const extension = createExtension(extPath, resolvedPath);
      const api = createExtensionAPI(extension, runtime, resolvedCwd, resolvedEventBus);
      await factory(api);
      extensions.push(extension);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ path: extPath, error: `Failed to load extension: ${message}` });
    }
  }

  return {
    extensions,
    errors,
    runtime,
  };
}
