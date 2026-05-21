import {
  createEventBus,
  createExtensionRuntime,
  createSyntheticSourceInfo,
  type EventBus,
  type Extension,
  type ExtensionAPI,
  type ExtensionFactory,
  type ExtensionRuntime,
  type LoadExtensionsResult,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

type EmbeddedPiResourceLoaderOptions = {
  cwd: string;
  extensionFactories: ExtensionFactory[];
};

export const EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS = {
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
} as const;

function createInlineExtensionApi(params: {
  cwd: string;
  eventBus: EventBus;
  extension: Extension;
  runtime: ExtensionRuntime;
}): ExtensionAPI {
  const { cwd, eventBus, extension, runtime } = params;
  const assertActive = () => runtime.assertActive();
  return {
    on(event: string, handler: unknown) {
      assertActive();
      const handlers = extension.handlers.get(event) ?? [];
      handlers.push(handler as (typeof handlers)[number]);
      extension.handlers.set(event, handlers);
    },
    registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]) {
      assertActive();
      extension.tools.set(tool.name, {
        definition: tool,
        sourceInfo: extension.sourceInfo,
      });
      runtime.refreshTools();
    },
    registerCommand(
      name: Parameters<ExtensionAPI["registerCommand"]>[0],
      options: Parameters<ExtensionAPI["registerCommand"]>[1],
    ) {
      assertActive();
      extension.commands.set(name, {
        name,
        sourceInfo: extension.sourceInfo,
        ...options,
      });
    },
    registerShortcut(
      shortcut: Parameters<ExtensionAPI["registerShortcut"]>[0],
      options: Parameters<ExtensionAPI["registerShortcut"]>[1],
    ) {
      assertActive();
      extension.shortcuts.set(shortcut, {
        shortcut,
        extensionPath: extension.path,
        ...options,
      });
    },
    registerFlag(
      name: Parameters<ExtensionAPI["registerFlag"]>[0],
      options: Parameters<ExtensionAPI["registerFlag"]>[1],
    ) {
      assertActive();
      extension.flags.set(name, {
        name,
        extensionPath: extension.path,
        ...options,
      });
      if (options.default !== undefined && !runtime.flagValues.has(name)) {
        runtime.flagValues.set(name, options.default);
      }
    },
    getFlag(name: Parameters<ExtensionAPI["getFlag"]>[0]) {
      assertActive();
      return extension.flags.has(name) ? runtime.flagValues.get(name) : undefined;
    },
    registerMessageRenderer(
      customType: Parameters<ExtensionAPI["registerMessageRenderer"]>[0],
      renderer: Parameters<ExtensionAPI["registerMessageRenderer"]>[1],
    ) {
      assertActive();
      extension.messageRenderers.set(customType, renderer);
    },
    sendMessage(
      message: Parameters<ExtensionAPI["sendMessage"]>[0],
      options: Parameters<ExtensionAPI["sendMessage"]>[1],
    ) {
      assertActive();
      runtime.sendMessage(message, options);
    },
    sendUserMessage(
      content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
      options: Parameters<ExtensionAPI["sendUserMessage"]>[1],
    ) {
      assertActive();
      runtime.sendUserMessage(content, options);
    },
    appendEntry(
      customType: Parameters<ExtensionAPI["appendEntry"]>[0],
      data: Parameters<ExtensionAPI["appendEntry"]>[1],
    ) {
      assertActive();
      runtime.appendEntry(customType, data);
    },
    setSessionName(name: Parameters<ExtensionAPI["setSessionName"]>[0]) {
      assertActive();
      runtime.setSessionName(name);
    },
    getSessionName() {
      assertActive();
      return runtime.getSessionName();
    },
    setLabel(
      entryId: Parameters<ExtensionAPI["setLabel"]>[0],
      label: Parameters<ExtensionAPI["setLabel"]>[1],
    ) {
      assertActive();
      runtime.setLabel(entryId, label);
    },
    exec(
      command: Parameters<ExtensionAPI["exec"]>[0],
      args: Parameters<ExtensionAPI["exec"]>[1],
      options: Parameters<ExtensionAPI["exec"]>[2],
    ) {
      assertActive();
      void args;
      throw new Error(
        `Embedded inline extension attempted to execute ${command} from ${options?.cwd ?? cwd}`,
      );
    },
    getActiveTools() {
      assertActive();
      return runtime.getActiveTools();
    },
    getAllTools() {
      assertActive();
      return runtime.getAllTools();
    },
    setActiveTools(toolNames: Parameters<ExtensionAPI["setActiveTools"]>[0]) {
      assertActive();
      runtime.setActiveTools(toolNames);
    },
    getCommands() {
      assertActive();
      return runtime.getCommands();
    },
    setModel(model: Parameters<ExtensionAPI["setModel"]>[0]) {
      assertActive();
      return runtime.setModel(model);
    },
    getThinkingLevel() {
      assertActive();
      return runtime.getThinkingLevel();
    },
    setThinkingLevel(level: Parameters<ExtensionAPI["setThinkingLevel"]>[0]) {
      assertActive();
      runtime.setThinkingLevel(level);
    },
    registerProvider(
      name: Parameters<ExtensionAPI["registerProvider"]>[0],
      config: Parameters<ExtensionAPI["registerProvider"]>[1],
    ) {
      assertActive();
      runtime.registerProvider(name, config, extension.path);
    },
    unregisterProvider(name: Parameters<ExtensionAPI["unregisterProvider"]>[0]) {
      assertActive();
      runtime.unregisterProvider(name);
    },
    events: eventBus,
  } as ExtensionAPI;
}

function createInlineExtension(index: number): Extension {
  const path = `<openclaw-inline:${index}>`;
  return {
    path,
    resolvedPath: path,
    sourceInfo: createSyntheticSourceInfo(path, {
      source: "temporary",
      origin: "top-level",
      scope: "temporary",
    }),
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

class EmbeddedPiResourceLoader implements ResourceLoader {
  private extensionsResult: LoadExtensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };

  constructor(private readonly options: EmbeddedPiResourceLoaderOptions) {}

  getExtensions() {
    return this.extensionsResult;
  }

  getSkills() {
    return { skills: [], diagnostics: [] };
  }

  getPrompts() {
    return { prompts: [], diagnostics: [] };
  }

  getThemes() {
    return { themes: [], diagnostics: [] };
  }

  getAgentsFiles() {
    return { agentsFiles: [] };
  }

  getSystemPrompt() {
    return undefined;
  }

  getAppendSystemPrompt() {
    return [];
  }

  extendResources() {}

  async reload() {
    const runtime = createExtensionRuntime();
    const eventBus = createEventBus();
    const extensions: Extension[] = [];
    const errors: LoadExtensionsResult["errors"] = [];
    for (const [index, factory] of this.options.extensionFactories.entries()) {
      const extension = createInlineExtension(index);
      try {
        await factory(
          createInlineExtensionApi({
            cwd: this.options.cwd,
            eventBus,
            extension,
            runtime,
          }),
        );
        extensions.push(extension);
      } catch (error) {
        errors.push({
          path: extension.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.extensionsResult = { extensions, errors, runtime };
  }
}

export function createEmbeddedPiResourceLoader(
  options: EmbeddedPiResourceLoaderOptions & {
    agentDir: string;
    settingsManager: unknown;
  },
): ResourceLoader {
  return new EmbeddedPiResourceLoader({
    cwd: options.cwd,
    extensionFactories: options.extensionFactories,
  });
}
