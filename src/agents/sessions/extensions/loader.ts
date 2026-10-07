import * as path from "node:path";
import type { EventBus } from "../event-bus.js";
import type { ExecOptions } from "../exec.js";
import { execCommand } from "../exec.js";
import { warnSessionPersistenceDeprecation } from "../session-persistence-deprecation.js";
import { createSyntheticSourceInfo } from "../source-info.js";
import type {
  Extension,
  ExtensionAPI,
  ExtensionFactory,
  ExtensionRuntime,
  ExtensionRuntimeV2,
  ExtensionShortcut,
  MessageRenderer,
  RegisteredCommand,
  ToolDefinition,
} from "./types.js";

type HandlerFn = NonNullable<ReturnType<Extension["handlers"]["get"]>>[number];

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

export async function loadExtensionFromFactory(
  factory: ExtensionFactory,
  cwd: string,
  eventBus: EventBus,
  runtime: ExtensionRuntime,
  extensionPath = "<inline>",
): Promise<Extension> {
  const source =
    extensionPath.startsWith("<") && extensionPath.endsWith(">")
      ? extensionPath.slice(1, -1).split(":")[0] || "temporary"
      : "local";
  const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(extensionPath);

  const extension: Extension = {
    path: extensionPath,
    resolvedPath: extensionPath,
    sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
  const api = createExtensionAPI(extension, runtime, cwd, eventBus);
  await factory(api);
  return extension;
}
