import { basename, dirname } from "node:path";
import { isResponsesOutputLimitToolCallError } from "@openclaw/ai/diagnostics";
import { isContextOverflow } from "@openclaw/ai/internal/runtime";
import type { AssistantMessage } from "../../llm/types.js";
import { isRetryableAssistantError } from "../../llm/utils/retry.js";
import { sleep } from "../../utils/sleep.js";
import { classifyRateLimitWindow } from "../failover/retry-evidence.js";
import { AgentSessionCompaction } from "./agent-session-compaction.js";
import type { AgentSessionConfig, ExtensionBindings } from "./agent-session-types.js";
import { ExtensionRunner, type ToolDefinition } from "./extensions/index.js";
import { emitSessionShutdownEvent } from "./extensions/runner.js";
import type { ResourceExtensionPaths } from "./resource-loader.js";
import type { SlashCommandInfo } from "./slash-commands.js";
import { createSyntheticSourceInfo } from "./source-info.js";
import { wrapToolDefinition } from "./tools/tool-definition-wrapper.js";

function describeCommands<T extends Pick<SlashCommandInfo, "description" | "sourceInfo">>(
  commands: readonly T[],
  source: SlashCommandInfo["source"],
  name: (command: T) => string,
): SlashCommandInfo[] {
  return commands.map((command) => ({
    name: name(command),
    description: command.description,
    source,
    sourceInfo: command.sourceInfo,
  }));
}

export * from "./agent-session-types.js";

/**
 * Core abstraction for agent lifecycle and session management.
 *
 * Shared by interactive, print, and RPC modes. Mode-specific I/O stays above
 * this class while the feature layers below own session behavior.
 */
export class AgentSession extends AgentSessionCompaction {
  constructor(config: AgentSessionConfig) {
    super(config);
    this.unsubscribeAgent = this.agent.subscribe(this.handleAgentEvent);
    this.installAgentToolHooks();
    this.buildRuntime({
      activeToolNames: [...this.allowedToolNames],
    });
  }

  get extensionRunner(): ExtensionRunner {
    return this.currentExtensionRunner;
  }

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
    await this.currentExtensionRunner.emit({ type: "session_start", reason: "startup" });
    await this.extendResourcesFromExtensions("startup");
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
    const reportSendError = (event: string, err: unknown) => {
      runner.emitError({
        extensionPath: "<runtime>",
        event,
        error: err instanceof Error ? err.message : String(err),
      });
    };
    const getCommands = (): SlashCommandInfo[] => [
      ...describeCommands(
        runner.getRegisteredCommands(),
        "extension",
        (command) => command.invocationName,
      ),
      ...describeCommands(this.promptTemplates, "prompt", (template) => template.name),
      ...describeCommands(
        this.sessionResourceLoader.getSkills().skills,
        "skill",
        (skill) => `skill:${skill.name}`,
      ),
    ];

    runner.bindCoreAsync(
      {
        sendMessage: (message, options) => {
          this.sendCustomMessage(message, options).catch((err: unknown) =>
            reportSendError("send_message", err),
          );
        },
        sendUserMessage: (content, options) => {
          this.sendUserMessage(content, options).catch((err: unknown) =>
            reportSendError("send_user_message", err),
          );
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
    const runner = this.currentExtensionRunner;
    const wrappedTools = allCustomTools.map((tool) =>
      wrapToolDefinition(tool.definition, () => runner.createContext()),
    );
    this.toolRegistry = new Map(wrappedTools.map((tool) => [tool.name, tool]));
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
    this.agent.steeringMode = this.settingsManager.getSteeringMode();
    this.agent.followUpMode = this.settingsManager.getFollowUpMode();
    await this.sessionResourceLoader.reload();
    await this.sessionModelRegistry.refreshAsync();
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

  /**
   * Check if an error is retryable (overloaded, rate limit, server errors).
   * Context overflow errors are NOT retryable (handled by compaction instead).
   */
  protected isRetryableError(message: AssistantMessage): boolean {
    if (message.stopReason !== "error" || !message.errorMessage) {
      return false;
    }

    const contextWindow = this.model?.contextWindow ?? 0;
    if (isContextOverflow(message, contextWindow)) {
      return false;
    }

    return isResponsesOutputLimitToolCallError(message) || isRetryableAssistantError(message);
  }

  /**
   * Prepare a retryable error for continuation with exponential backoff.
   * @returns true if the caller should continue the agent, false otherwise
   */
  protected async prepareRetry(message: AssistantMessage): Promise<boolean> {
    const settings = this.settingsManager.getRetrySettings();
    if (!settings.enabled) {
      return false;
    }

    this.retryCount++;

    if (this.retryCount > settings.maxRetries) {
      // Preserve the completed attempt count so post-run handling can emit the final failure.
      this.retryCount--;
      return false;
    }

    const backoffDelayMs = settings.baseDelayMs * 2 ** (this.retryCount - 1);
    const rateLimitWindow = classifyRateLimitWindow(message.errorMessage);
    const retryAfterDelayMs =
      rateLimitWindow.kind === "short" && rateLimitWindow.retryAfterSeconds !== undefined
        ? Math.ceil(rateLimitWindow.retryAfterSeconds * 1000)
        : 0;
    const delayMs = Math.max(backoffDelayMs, retryAfterDelayMs);

    this.emit({ type: "auto_retry_start" });

    this.retryAbortController = new AbortController();
    try {
      await sleep(delayMs, this.retryAbortController.signal);
    } catch {
      // Aborted during sleep - emit end event so UI can clean up
      this.retryCount = 0;
      this.emit({ type: "auto_retry_end" });
      return false;
    } finally {
      this.retryAbortController = undefined;
    }

    return true;
  }

  /** Cancel an in-progress retry. */
  abortRetry(): void {
    this.retryAbortController?.abort();
  }
}
