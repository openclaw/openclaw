import { basename, dirname } from "node:path";
import { AgentSessionCompaction } from "./agent-session-compaction.js";
import type { ExtensionBindings } from "./agent-session-types.js";
import { ExtensionRunner, type ToolDefinition, wrapRegisteredTools } from "./extensions/index.js";
import { emitSessionShutdownEvent } from "./extensions/runner.js";
import type { ResourceExtensionPaths } from "./resource-loader.js";
import type { SlashCommandInfo } from "./slash-commands.js";
import { createSyntheticSourceInfo } from "./source-info.js";

export abstract class AgentSessionExtensions extends AgentSessionCompaction {
  async bindExtensions(bindings: ExtensionBindings): Promise<void> {
    if (bindings.uiContext !== undefined) {
      this.extensionUIContext = bindings.uiContext;
    }
    if (bindings.commandContextActions !== undefined) {
      this.extensionCommandContextActions = bindings.commandContextActions;
    }
    if (bindings.abortHandler !== undefined) {
      this.extensionAbortHandler = bindings.abortHandler;
    }
    if (bindings.shutdownHandler !== undefined) {
      this.extensionShutdownHandler = bindings.shutdownHandler;
    }
    if (bindings.onError !== undefined) {
      this.extensionErrorListener = bindings.onError;
    }

    this.applyExtensionBindings(this.currentExtensionRunner);
    await this.currentExtensionRunner.emit(this.sessionStartEvent);
    await this.extendResourcesFromExtensions(
      this.sessionStartEvent.reason === "reload" ? "reload" : "startup",
    );
  }

  private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
    if (!this.currentExtensionRunner.hasHandlers("resources_discover")) {
      return;
    }

    const { skillPaths, promptPaths, themePaths } =
      await this.currentExtensionRunner.emitResourcesDiscover(this.cwd, reason);

    if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
      return;
    }

    const extensionPaths: ResourceExtensionPaths = {
      skillPaths: this.buildExtensionResourcePaths(skillPaths),
      promptPaths: this.buildExtensionResourcePaths(promptPaths),
      themePaths: this.buildExtensionResourcePaths(themePaths),
    };

    this.sessionResourceLoader.extendResources(extensionPaths);
    this.agent.state.systemPrompt = this.baseSystemPrompt;
  }

  private buildExtensionResourcePaths(
    entries: Array<{ path: string; extensionPath: string }>,
  ): Array<{
    path: string;
    metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
  }> {
    return entries.map((entry) => {
      const synthetic = entry.extensionPath.startsWith("<");
      return {
        path: entry.path,
        metadata: {
          source: `extension:${
            synthetic
              ? entry.extensionPath.replace(/[<>]/g, "")
              : basename(entry.extensionPath).replace(/\.(ts|js)$/, "")
          }`,
          scope: "temporary",
          origin: "top-level",
          baseDir: synthetic ? undefined : dirname(entry.extensionPath),
        },
      };
    });
  }

  private applyExtensionBindings(runner: ExtensionRunner): void {
    runner.setUIContext(this.extensionUIContext);
    runner.bindCommandContext(this.extensionCommandContextActions);

    this.extensionErrorUnsubscriber?.();
    this.extensionErrorUnsubscriber = this.extensionErrorListener
      ? runner.onError(this.extensionErrorListener)
      : undefined;
  }

  private refreshCurrentModelFromRegistry(): void {
    const currentModel = this.model;
    if (!currentModel) {
      return;
    }

    const refreshedModel = this.sessionModelRegistry.find(currentModel.provider, currentModel.id);
    if (!refreshedModel || refreshedModel === currentModel) {
      return;
    }

    this.agent.state.model = refreshedModel;
  }

  private bindExtensionCore(runner: ExtensionRunner): void {
    const getCommands = (): SlashCommandInfo[] => {
      const extensionCommands: SlashCommandInfo[] = runner
        .getRegisteredCommands()
        .map((command) => ({
          name: command.invocationName,
          description: command.description,
          source: "extension",
          sourceInfo: command.sourceInfo,
        }));

      const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
        name: template.name,
        description: template.description,
        source: "prompt",
        sourceInfo: template.sourceInfo,
      }));

      const skills: SlashCommandInfo[] = this.sessionResourceLoader
        .getSkills()
        .skills.map((skill) => ({
          name: `skill:${skill.name}`,
          description: skill.description,
          source: "skill",
          sourceInfo: skill.sourceInfo,
        }));

      return [...extensionCommands, ...templates, ...skills];
    };

    runner.bindCoreAsync(
      {
        sendMessage: (message, options) => {
          this.sendCustomMessage(message, options).catch((err: unknown) => {
            runner.emitError({
              extensionPath: "<runtime>",
              event: "send_message",
              error: err instanceof Error ? err.message : String(err),
            });
          });
        },
        sendUserMessage: (content, options) => {
          this.sendUserMessage(content, options).catch((err: unknown) => {
            runner.emitError({
              extensionPath: "<runtime>",
              event: "send_user_message",
              error: err instanceof Error ? err.message : String(err),
            });
          });
        },
        // Retained third-party synchronous persistence adapters.
        appendEntry: (customType, data) => {
          this.sessionManager.appendCustomEntry(customType, data);
        },
        appendEntryAsync: (customType, data) =>
          this.sessionManager.appendCustomEntryAsync(customType, data),
        setSessionName: (name) => {
          this.setSessionName(name);
        },
        setSessionNameAsync: (name) => this.setSessionNameAsync(name),
        getSessionName: () => {
          return this.sessionManager.getSessionName();
        },
        setLabel: (entryId, label) => {
          this.sessionManager.appendLabelChange(entryId, label);
        },
        setLabelAsync: async (entryId, label) => {
          await this.sessionManager.appendLabelChangeAsync(entryId, label);
        },
        getActiveTools: () => this.getActiveToolNames(),
        getAllTools: () => this.getAllTools(),
        setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
        refreshTools: () => this.refreshToolRegistry(),
        getCommands,
        setModel: async (model) => {
          if (!this.sessionModelRegistry.hasConfiguredAuth(model)) {
            return false;
          }
          await this.setModel(model);
          return true;
        },
        getThinkingLevel: () => this.thinkingLevel,
        setThinkingLevel: (level) => this.setThinkingLevel(level),
      },
      {
        getModel: () => this.model,
        isIdle: () => !this.isStreaming,
        getSignal: () => this.agent.signal,
        abort: () => {
          if (this.extensionAbortHandler) {
            this.extensionAbortHandler();
            return;
          }
          void this.abort();
        },
        hasPendingMessages: () => this.pendingMessageCount > 0,
        shutdown: () => {
          this.extensionShutdownHandler?.();
        },
        getContextUsage: () => this.getContextUsage(),
        compact: (options) => {
          void (async () => {
            try {
              const result = await this.compact(options?.customInstructions);
              options?.onComplete?.(result);
            } catch (error) {
              const err = error instanceof Error ? error : new Error(String(error));
              options?.onError?.(err);
            }
          })();
        },
        getSystemPrompt: () => this.systemPrompt,
      },
      {
        registerProvider: (name, config) => {
          this.sessionModelRegistry.registerProvider(name, config);
          this.refreshCurrentModelFromRegistry();
        },
        unregisterProvider: (name) => {
          this.sessionModelRegistry.unregisterProvider(name);
          this.refreshCurrentModelFromRegistry();
        },
      },
    );
  }

  /** Replace a runtime-owned tool surface without restarting its active agent loop. */
  replaceCustomTools(customTools: ToolDefinition[], activeToolNames: string[]): void {
    this.customTools = customTools;
    this.allowedToolNames = new Set(activeToolNames);
    this.refreshToolRegistry(activeToolNames);
  }

  private refreshToolRegistry(activeToolNames = this.getActiveToolNames()): void {
    const allCustomTools = [
      ...this.currentExtensionRunner.getAllRegisteredTools(),
      ...this.customTools.map((definition) => ({
        definition,
        sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
      })),
    ].filter((tool) => this.allowedToolNames.has(tool.definition.name));
    this.toolDefinitions = new Map(allCustomTools.map((tool) => [tool.definition.name, tool]));
    this.toolRegistry = new Map(
      wrapRegisteredTools(allCustomTools, this.currentExtensionRunner).map((tool) => [
        tool.name,
        tool,
      ]),
    );
    this.setActiveToolsByName([...new Set([...activeToolNames, ...this.toolRegistry.keys()])]);
  }

  protected buildRuntime(options: {
    activeToolNames?: string[];
    flagValues?: Map<string, boolean | string>;
  }): void {
    const extensionsResult = this.sessionResourceLoader.getExtensions();
    if (options.flagValues) {
      for (const [name, value] of options.flagValues) {
        extensionsResult.runtime.flagValues.set(name, value);
      }
    }

    this.currentExtensionRunner = new ExtensionRunner(
      extensionsResult.extensions,
      extensionsResult.runtime,
      this.cwd,
      this.sessionManager,
      this.sessionModelRegistry,
    );
    if (this.extensionRunnerRef) {
      this.extensionRunnerRef.current = this.currentExtensionRunner;
    }
    this.bindExtensionCore(this.currentExtensionRunner);
    this.applyExtensionBindings(this.currentExtensionRunner);

    this.refreshToolRegistry(options.activeToolNames);
  }

  async reload(): Promise<void> {
    const previousFlagValues = this.currentExtensionRunner.getFlagValues();
    await emitSessionShutdownEvent(this.currentExtensionRunner, {
      type: "session_shutdown",
      reason: "reload",
    });
    await this.settingsManager.reload();
    this.agent.steeringMode = this.settingsManager.getSteeringMode();
    this.agent.followUpMode = this.settingsManager.getFollowUpMode();
    await this.sessionResourceLoader.reload();
    this.sessionModelRegistry.refresh();
    this.buildRuntime({
      activeToolNames: this.getActiveToolNames(),
      flagValues: previousFlagValues,
    });

    const hasBindings =
      this.extensionUIContext ||
      this.extensionCommandContextActions ||
      this.extensionShutdownHandler ||
      this.extensionErrorListener;
    if (hasBindings) {
      await this.currentExtensionRunner.emit({ type: "session_start", reason: "reload" });
      await this.extendResourcesFromExtensions("reload");
    }
  }
}
