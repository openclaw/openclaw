/**
 * Agent session SDK factory.
 *
 * Selects models, wires built-in/custom tools, loads resources, and creates AgentSession instances.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { clampThinkingLevel } from "@openclaw/ai/internal/runtime";
import { resolveThinkingDefaultForModel } from "../../auto-reply/thinking.js";
import { createSessionEntryWithTranscript } from "../../config/sessions/session-accessor.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withSessionMetadataPublication,
  withSessionTranscriptWriteAssertion,
  type SessionMetadataChange,
  type SessionMetadataCommit,
} from "../../config/sessions/transcript-write-context.js";
import { bindStreamLlmRuntime } from "../../llm/model-runtime-binding.js";
import type { Message, Model } from "../../llm/types.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { registerResolvedAgentDir } from "../agent-dir-registry.js";
import { sanitizeCompactionReplayMessages } from "../compaction-replay.js";
import { getAgentDirResolution } from "../config.js";
import { projectModelThinkingCompat } from "../model-catalog-lookup.js";
import {
  Agent,
  type AgentMessage,
  type AgentOptions,
  type AgentTool,
  type ThinkingLevel,
} from "../runtime/index.js";
import {
  setInternalBeforeToolBatch,
  type InternalBeforeToolBatchHook,
} from "../runtime/internal-hooks.js";
import type { AgentSessionConfig } from "./agent-session-types.js";
import { AgentSession, type AgentSessionWriteSettlementRunner } from "./agent-session.js";
import { formatNoModelsAvailableMessage } from "./auth-guidance.js";
import { AuthStorage } from "./auth-storage.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import type {
  ExtensionRunner,
  LoadExtensionsResult,
  SessionStartEvent,
  ToolDefinition,
} from "./extensions/index.js";
import { convertToLlm } from "./messages.js";
import { getModelRegistryRuntime } from "./model-registry-runtime.js";
import { ModelRegistry } from "./model-registry.js";
import { findInitialModel } from "./model-resolver.js";
import { DefaultResourceLoader, type ResourceLoader } from "./resource-loader.js";
import { sessionManagerReadInitialContext } from "./session-manager-current-turn.js";
import { SessionMetadataCommittedError } from "./session-manager-metadata-error.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { isInstallTelemetryEnabled } from "./telemetry.js";
import type { ToolName } from "./tools/index.js";

export interface CreateAgentSessionOptions {
  /** Working directory for project-local discovery. Default: process.cwd() */
  cwd?: string;
  /** Agent config directory. Defaults to the configured installation owner. */
  agentDir?: string;

  /** Auth storage for credentials. Default: canonical per-agent SQLite auth profiles. */
  authStorage?: AuthStorage;
  /** Model registry. Default: ModelRegistry.create(authStorage, agentDir/models.json) */
  modelRegistry?: ModelRegistry;

  /** Model to use. Default: from settings, else first available */
  model?: Model;
  /** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
  thinkingLevel?: ThinkingLevel;

  /**
   * Optional default tool suppression mode when no explicit allowlist is provided.
   *
   * - "all": start with no tools enabled
   * - "builtin": disable the default built-in tools (read, bash, edit, write)
   *   but keep extension/custom tools enabled
   */
  noTools?: "all" | "builtin";
  /**
   * Optional allowlist of tool names.
   *
   * When omitted, OpenClaw enables the default built-in tools (read, bash, edit, write)
   * and leaves extension/custom tools enabled unless `noTools` changes that default.
   * When provided, only the listed tool names are enabled.
   */
  tools?: string[];
  /** Custom tools to register (in addition to built-in tools). */
  customTools?: ToolDefinition[];
  /** Hydrate an authorized tool deferred out of the current provider-visible tool set. */
  resolveDeferredTool?: AgentOptions["resolveDeferredTool"];

  /** Resource loader. When omitted, DefaultResourceLoader is used. */
  resourceLoader?: ResourceLoader;

  /** Session manager. Defaults to a new SQLite-backed session for the selected agent. */
  sessionManager?: SessionManager;

  /** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
  settingsManager?: SettingsManager;
  /** Session start event metadata for extension runtime startup. */
  sessionStartEvent?: SessionStartEvent;
  /** Optional settlement boundary for session writes and write-capable extension hooks. */
  withSessionWriteSettlement?: AgentSessionWriteSettlementRunner;
}

type CreateAgentSessionInternalOptions = Pick<
  AgentSessionConfig,
  "cleanupProviderSessionResourcesOnDispose" | "contextOverflowRecoveryOwner"
> & { beforeToolBatch?: InternalBeforeToolBatchHook };

/** Result from createAgentSession */
interface CreateAgentSessionResult {
  /** The created session */
  session: AgentSession;
  /** Extensions result (for UI context setup in interactive mode) */
  extensionsResult: LoadExtensionsResult;
  /** Warning if session was restored with a different model than saved */
  modelFallbackMessage?: string;
}

// Helper Functions

function createSessionPrepareNextTurnWithContext(
  getAgent: () => Agent,
): NonNullable<AgentOptions["prepareNextTurnWithContext"]> {
  let activeRunMessages: AgentMessage[] | undefined;
  let effectiveModel: Model | undefined;
  let effectiveThinkingLevel: ThinkingLevel | undefined;
  let lastSessionModel: Model | undefined;
  let lastSessionThinkingLevel: ThinkingLevel | undefined;
  let lastSessionPrompt: string | undefined;
  let lastSessionTools: AgentTool[] = [];
  const sameTools = (left: AgentTool[], right: AgentTool[]) =>
    left.length === right.length && left.every((tool, index) => tool === right[index]);

  return async (turn, signal) => {
    const agent = getAgent();
    const firstTurnInRun = activeRunMessages !== turn.newMessages;
    if (firstTurnInRun) {
      activeRunMessages = turn.newMessages;
      effectiveModel = agent.state.model;
      effectiveThinkingLevel = agent.state.thinkingLevel;
    }

    const previousSnapshot = await agent.prepareNextTurn?.(signal);
    const sessionPrompt = agent.state.systemPrompt;
    const sessionTools = agent.state.tools;
    const sessionModelChanged = firstTurnInRun || agent.state.model !== lastSessionModel;
    const sessionThinkingChanged =
      firstTurnInRun || agent.state.thinkingLevel !== lastSessionThinkingLevel;
    const sessionPromptChanged = firstTurnInRun || sessionPrompt !== lastSessionPrompt;
    const sessionToolsChanged = firstTurnInRun || !sameTools(sessionTools, lastSessionTools);

    // Loop-only hook updates persist for the run; fresh session state wins only after it changes.
    effectiveModel =
      previousSnapshot?.model ?? (sessionModelChanged ? agent.state.model : effectiveModel);
    effectiveThinkingLevel =
      previousSnapshot?.thinkingLevel ??
      (sessionThinkingChanged ? agent.state.thinkingLevel : effectiveThinkingLevel);

    lastSessionModel = agent.state.model;
    lastSessionThinkingLevel = agent.state.thinkingLevel;
    lastSessionPrompt = sessionPrompt;
    lastSessionTools = sessionTools.slice();

    const nextContext = previousSnapshot?.context
      ? { ...previousSnapshot.context }
      : {
          ...turn.context,
          systemPrompt: sessionPromptChanged ? sessionPrompt : turn.context.systemPrompt,
          tools: sessionToolsChanged ? sessionTools.slice() : turn.context.tools?.slice(),
        };

    return {
      ...previousSnapshot,
      context: nextContext,
      model: effectiveModel,
      thinkingLevel: effectiveThinkingLevel,
    };
  };
}

function getAttributionHeaders(
  model: Model,
  settingsManager: SettingsManager,
): Record<string, string> | undefined {
  if (!isInstallTelemetryEnabled(settingsManager)) {
    return undefined;
  }

  const baseUrl = (model as { baseUrl?: string }).baseUrl ?? "";

  if (model.provider === "openrouter" || baseUrl.includes("openrouter.ai")) {
    return {
      "HTTP-Referer": "https://openclaw.ai",
      "X-OpenRouter-Title": "OpenClaw",
      "X-OpenRouter-Categories": "cli-agent",
    };
  }

  if (
    model.provider === "cloudflare-workers-ai" ||
    model.provider === "cloudflare-ai-gateway" ||
    baseUrl.includes("api.cloudflare.com") ||
    baseUrl.includes("gateway.ai.cloudflare.com")
  ) {
    return {
      "User-Agent": "openclaw",
    };
  }

  return undefined;
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model from the configured registry
 * const model = ModelRegistry.create(AuthStorage.load()).find('anthropic', 'claude-opus-4-5');
 * const { session } = await createAgentSession({
 *   model,
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(
  options: CreateAgentSessionOptions = {},
): Promise<CreateAgentSessionResult> {
  return await createAgentSessionImpl(options);
}

/** Internal factory for temporary embedded sessions that do not own durable provider resources. */
export async function createAgentSessionForEmbeddedRunner(
  options: CreateAgentSessionOptions,
  internalOptions: CreateAgentSessionInternalOptions,
): Promise<CreateAgentSessionResult> {
  return await createAgentSessionImpl(options, internalOptions, false);
}

async function createAgentSessionImpl(
  options: CreateAgentSessionOptions,
  internalOptions: CreateAgentSessionInternalOptions = {},
  cleanupProviderSessionResourcesOnDispose = true,
): Promise<CreateAgentSessionResult> {
  const cwd = options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd();
  const install = getAgentDirResolution(options.agentDir);
  const { dir: agentDir } = install.directory;
  if (options.agentDir === undefined && install.directory.owner) {
    registerResolvedAgentDir({ agentId: install.directory.owner, agentDir, env: install.env });
  }
  let resourceLoader = options.resourceLoader;

  // Use provided or create AuthStorage and ModelRegistry
  const config = options.authStorage && options.modelRegistry ? undefined : install.config;
  const authStorage = options.authStorage ?? AuthStorage.forAgent(agentDir, config);
  const modelRegistry =
    options.modelRegistry ??
    ModelRegistry.create(authStorage, join(agentDir, "models.json"), { config, workspaceDir: cwd });

  const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
  const sessionManager =
    options.sessionManager ?? (await createDefaultSdkSessionManager(cwd, install));

  const initialTarget = sessionManager.getSessionTarget();
  const initialSessionId = sessionManager.getSessionId();
  const assertInitialSessionCurrent = () => {
    const current = sessionManager.getSessionTarget();
    if (
      sessionManager.getSessionId() !== initialSessionId ||
      !sameSessionTranscriptTargetBinding(initialTarget, current)
    ) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
  };

  if (!resourceLoader) {
    resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
    await resourceLoader.reload();
    assertInitialSessionCurrent();
    modelRegistry.refresh();
  }

  // Check if session has existing data to restore
  const existingSession = await sessionManager[sessionManagerReadInitialContext]();
  assertInitialSessionCurrent();
  const hasExistingSession = existingSession.messages.length > 0;
  const hasThinkingEntry = sessionManager
    .getBranch()
    .some((entry) => entry.type === "thinking_level_change");

  let model = options.model;
  let modelFallbackMessage: string | undefined;

  // If session has data, try to restore model from it
  if (!model && hasExistingSession && existingSession.model) {
    const restoredModel = modelRegistry.find(
      existingSession.model.provider,
      existingSession.model.modelId,
    );
    if (restoredModel && modelRegistry.hasConfiguredAuth(restoredModel)) {
      model = restoredModel;
    }
    if (!model) {
      modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
    }
  }

  // If still no model, use findInitialModel (checks settings default, then provider defaults)
  if (!model) {
    const result = await findInitialModel({
      scopedModels: [],
      isContinuing: hasExistingSession,
      defaultProvider: settingsManager.getDefaultProvider(),
      defaultModelId: settingsManager.getDefaultModel(),
      defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
      modelRegistry,
    });
    model = result.model;
    if (!model) {
      modelFallbackMessage = formatNoModelsAvailableMessage();
    } else if (modelFallbackMessage) {
      modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
    }
  }

  let thinkingLevel = options.thinkingLevel;

  // Use "off" when a provider explicitly opts out of thinking (e.g. Ollama). Non-off
  // provider defaults (high, low, adaptive) fall back to DEFAULT_THINKING_LEVEL to avoid
  // silent cost changes for DeepSeek, OpenRouter, xAI, and other providers.
  const modelThinkingProvider = model?.api === "ollama" ? "ollama" : model?.provider;
  const modelThinkingCompat = model ? projectModelThinkingCompat(model.compat) : undefined;
  const resolvedProviderDefault =
    model && modelThinkingProvider
      ? resolveThinkingDefaultForModel({
          provider: modelThinkingProvider,
          model: model.id,
          catalog: [
            {
              provider: modelThinkingProvider,
              id: model.id,
              api: model.api,
              reasoning: model.reasoning,
              ...(model.params ? { params: model.params } : {}),
              ...(modelThinkingCompat ? { compat: modelThinkingCompat } : {}),
            },
          ],
        })
      : undefined;
  const modelThinkingDefault: ThinkingLevel =
    resolvedProviderDefault === "off" ? "off" : DEFAULT_THINKING_LEVEL;

  // If session has data, restore thinking level from it
  if (thinkingLevel === undefined && hasExistingSession) {
    thinkingLevel = hasThinkingEntry
      ? (existingSession.thinkingLevel as ThinkingLevel)
      : (settingsManager.getDefaultThinkingLevel() ?? modelThinkingDefault);
  }

  // Fall back to settings default
  if (thinkingLevel === undefined) {
    thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? modelThinkingDefault;
  }

  // Clamp to model capabilities
  if (!model) {
    thinkingLevel = "off";
  } else {
    thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
  }

  const defaultActiveToolNames: ToolName[] = ["read", "bash", "edit", "write"];
  const customToolNames = options.customTools?.map((tool) => tool.name) ?? [];
  const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
  const disableBuiltInTools = !options.tools && options.noTools === "builtin";
  const initialActiveToolNames: string[] = options.tools
    ? [...options.tools]
    : options.noTools === "all"
      ? []
      : options.noTools === "builtin"
        ? customToolNames
        : defaultActiveToolNames;

  // Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
  const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
    const converted = convertToLlm(messages);
    // Check setting dynamically so mid-session changes take effect
    if (!settingsManager.getBlockImages()) {
      return converted;
    }
    // Filter out ImageContent from all messages, replacing with text placeholder
    return converted.map((msg) => {
      if (msg.role === "user" || msg.role === "toolResult") {
        const content = msg.content;
        if (Array.isArray(content)) {
          const hasImages = content.some((c) => c.type === "image");
          if (hasImages) {
            const filteredContent = content
              .map((c) =>
                c.type === "image"
                  ? { type: "text" as const, text: "Image reading is disabled." }
                  : c,
              )
              .filter((c, i, arr) => {
                const previous = arr.at(i - 1);
                // Dedupe consecutive "Image reading is disabled." texts
                return !(
                  c.type === "text" &&
                  c.text === "Image reading is disabled." &&
                  i > 0 &&
                  previous?.type === "text" &&
                  previous.text === "Image reading is disabled."
                );
              });
            return Object.assign({}, msg, { content: filteredContent });
          }
        }
      }
      return msg;
    });
  };

  const extensionRunnerRef: { current?: ExtensionRunner } = {};
  const runWithSessionWriteSettlement = async <T>(run: () => Promise<T> | T): Promise<T> =>
    options.withSessionWriteSettlement
      ? await options.withSessionWriteSettlement(run)
      : await run();

  assertInitialSessionCurrent();
  const modelRegistryRuntime = getModelRegistryRuntime(modelRegistry);
  const agent: Agent = new Agent({
    initialState: {
      systemPrompt: "",
      model,
      thinkingLevel,
      tools: [],
    },
    convertToLlm: convertToLlmWithBlockImages,
    streamFn: async (modelResult, context, optionsLocal) => {
      const auth = await modelRegistry.getApiKeyAndHeaders(modelResult);
      if (!auth.ok) {
        throw new Error(auth.error);
      }
      // Isolated session streams bypass the process-default stream facade.
      await import("../ai-transport-runtime-host.js");
      optionsLocal?.signal?.throwIfAborted();
      const providerRetrySettings = settingsManager.getProviderRetrySettings();
      const attributionHeaders = getAttributionHeaders(modelResult, settingsManager);
      return modelRegistryRuntime.llmRuntime.streamSimple(modelResult, context, {
        ...optionsLocal,
        apiKey: auth.apiKey,
        timeoutMs: optionsLocal?.timeoutMs ?? providerRetrySettings.timeoutMs,
        maxRetryDelayMs: optionsLocal?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
        headers:
          attributionHeaders || auth.headers || optionsLocal?.headers
            ? { ...attributionHeaders, ...auth.headers, ...optionsLocal?.headers }
            : undefined,
      });
    },
    onPayload: async (payload, modelValue) => {
      void modelValue;
      const runner = extensionRunnerRef.current;
      if (!runner?.hasHandlers("before_provider_request")) {
        return payload;
      }
      return await runWithSessionWriteSettlement(
        async () => await runner.emitBeforeProviderRequest(payload),
      );
    },
    onResponse: async (response, modelLocal) => {
      void modelLocal;
      const runner = extensionRunnerRef.current;
      if (!runner?.hasHandlers("after_provider_response")) {
        return;
      }
      await runWithSessionWriteSettlement(
        async () =>
          await runner.emit({
            type: "after_provider_response",
            status: response.status,
            headers: response.headers,
          }),
      );
    },
    sessionId: initialSessionId,
    transformContext: async (messages) => {
      const runner = extensionRunnerRef.current;
      if (!runner) {
        return messages;
      }
      return runner.emitContext(messages);
    },
    resolveDeferredTool: options.resolveDeferredTool,
    prepareNextTurnWithContext: createSessionPrepareNextTurnWithContext(() => agent),
    steeringMode: settingsManager.getSteeringMode(),
    followUpMode: settingsManager.getFollowUpMode(),
    transport: settingsManager.getTransport(),
    thinkingBudgets: settingsManager.getThinkingBudgets(),
    maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
  });
  setInternalBeforeToolBatch(agent, internalOptions.beforeToolBatch);
  if (agent.streamFn) {
    bindStreamLlmRuntime(agent.streamFn, modelRegistryRuntime.llmRuntime);
  }

  let metadataCommit: SessionMetadataCommit | undefined;
  const appendInitialMetadata = (change: SessionMetadataChange, append: () => Promise<string>) =>
    withSessionMetadataPublication(
      sessionManager,
      change,
      (commit) => {
        metadataCommit = commit;
      },
      append,
    );
  const appendInitialThinking = () =>
    appendInitialMetadata({ type: "thinking_level_change", thinkingLevel }, () =>
      sessionManager.appendThinkingLevelChange(thinkingLevel),
    );
  const initializeMetadata = () => {
    // Prepared history needs no write permit when its initial metadata already exists.
    // Otherwise restoration waits behind unrelated writes, including reclamation.
    if (hasExistingSession && hasThinkingEntry) {
      return Promise.resolve();
    }
    return withSessionManagerWrite(sessionManager, async () => {
      assertInitialSessionCurrent();
      if (hasExistingSession) {
        await appendInitialThinking();
        assertInitialSessionCurrent();
      } else {
        // Persist initial settings before exposing the new session to callers.
        if (model) {
          await appendInitialMetadata(
            { type: "model_change", provider: model.provider, modelId: model.id },
            () => sessionManager.appendModelChange(model.provider, model.id),
          );
          assertInitialSessionCurrent();
        }
        await appendInitialThinking();
      }
    });
  };
  try {
    await (initialTarget
      ? withSessionTranscriptWriteAssertion(
          initialTarget,
          assertInitialSessionCurrent,
          initializeMetadata,
        )
      : initializeMetadata());
    // Cleanup can yield after the last append, before this factory exposes its session.
    assertInitialSessionCurrent();
    if (hasExistingSession) {
      agent.state.messages = sanitizeCompactionReplayMessages(existingSession.messages);
    }
  } catch (cause) {
    if (cause instanceof SessionMetadataCommittedError || !metadataCommit) {
      throw cause;
    }
    throw new SessionMetadataCommittedError(
      metadataCommit.entry,
      metadataCommit.version,
      cause,
      metadataCommit.target,
    );
  }

  const session = new AgentSession({
    agent,
    sessionManager,
    settingsManager,
    cwd,
    resourceLoader,
    customTools: options.customTools,
    modelRegistry,
    initialActiveToolNames,
    allowedToolNames,
    disableBuiltInTools,
    extensionRunnerRef,
    sessionStartEvent: options.sessionStartEvent,
    withSessionWriteSettlement: options.withSessionWriteSettlement,
    contextOverflowRecoveryOwner: internalOptions.contextOverflowRecoveryOwner,
    cleanupProviderSessionResourcesOnDispose,
  });
  const extensionsResult = resourceLoader.getExtensions();

  return {
    session,
    extensionsResult,
    modelFallbackMessage,
  };
}

async function createDefaultSdkSessionManager(
  cwd: string,
  install: ReturnType<typeof getAgentDirResolution>,
): Promise<SessionManager> {
  const { dir: agentDir, owner: agentId } = install.directory;
  if (!agentId) {
    throw new Error(
      "Select an agent owner or provide a sessionManager before creating an SDK session.",
    );
  }
  const sessionId = randomUUID();
  const target = {
    agentId,
    sessionId,
    sessionKey: `agent:${agentId}:sdk:${sessionId}`,
    storePath: join(agentDir, "openclaw-agent.sqlite"),
    env: install.env,
  };
  openOpenClawAgentDatabase({ agentId, env: install.env, path: target.storePath });
  const created = await createSessionEntryWithTranscript(
    target,
    () => ({
      ok: true,
      entry: { sessionId, updatedAt: Date.now() },
    }),
    { cwd },
  );
  if (!created.ok) {
    throw new Error(`Failed to initialize SDK session transcript: ${created.error}`);
  }
  return SessionManager.open(target, cwd);
}
