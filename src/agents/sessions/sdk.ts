/** Assembles an agent session from the run owner's selected model and prepared resources. */
import { clampThinkingLevel } from "@openclaw/ai/internal/runtime";
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
import { sanitizeCompactionReplayMessages } from "../compaction-replay.js";
import { resolveProviderRequestPolicy } from "../provider-attribution.js";
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
import { AgentSession } from "./agent-session.js";
import type { ExtensionRunner } from "./extensions/index.js";
import { convertToLlm } from "./messages.js";
import { getModelRegistryRuntime } from "./model-registry-runtime.js";
import { sessionManagerReadInitialContext } from "./session-manager-current-turn.js";
import { SessionMetadataCommittedError } from "./session-manager-metadata-error.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";
import type { SettingsManager } from "./settings-manager.js";
import { isInstallTelemetryEnabled } from "./telemetry.js";

export interface CreateAgentSessionOptions extends Omit<
  AgentSessionConfig,
  "agent" | "cwd" | "extensionRunnerRef" | "allowedToolNames"
> {
  beforeToolBatch?: InternalBeforeToolBatchHook;
  /** Execution directory; defaults to the prepared session's directory. */
  cwd?: string;

  /** Model already selected by the run owner. */
  model: Model;
  /** Admitted thinking level, clamped to the selected model capabilities. */
  thinkingLevel: ThinkingLevel;

  /** Runtime-owned allowlist; extensions cannot expand it. */
  tools: string[];
  /** Hydrate an authorized tool deferred out of the current provider-visible tool set. */
  resolveDeferredTool?: AgentOptions["resolveDeferredTool"];
}

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
  // SDK-backed session streams do not all consult the attribution policy, so forward its
  // documented header set as caller headers. Hidden (spec-only) attribution stays with the
  // transports that verify it. Like the transport-side policy, this ignores install telemetry.
  const { attributionHeaders, allowsHiddenAttribution } = resolveProviderRequestPolicy({
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
  });
  if (attributionHeaders && !allowsHiddenAttribution) {
    return attributionHeaders;
  }

  if (!isInstallTelemetryEnabled(settingsManager)) {
    return undefined;
  }

  const baseUrl = model.baseUrl ?? "";

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

export async function createAgentSession(
  options: CreateAgentSessionOptions,
): Promise<{ session: AgentSession }> {
  const { modelRegistry, settingsManager, sessionManager } = options;
  const cwd = options.cwd ?? sessionManager.getCwd();

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

  const existingSession = await sessionManager[sessionManagerReadInitialContext]();
  assertInitialSessionCurrent();
  const hasExistingSession = existingSession.messages.length > 0;
  const hasThinkingEntry = sessionManager
    .getBranch()
    .some((entry) => entry.type === "thinking_level_change");

  const model = options.model;
  const thinkingLevel = clampThinkingLevel(model, options.thinkingLevel) as ThinkingLevel;

  const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
    const converted = convertToLlm(messages);
    // Check setting dynamically so mid-session changes take effect
    if (!settingsManager.getBlockImages()) {
      return converted;
    }
    return converted.map((msg) => {
      if (msg.role !== "user" && msg.role !== "toolResult") {
        return msg;
      }
      const content = msg.content;
      if (!Array.isArray(content) || !content.some((c) => c.type === "image")) {
        return msg;
      }
      const filteredContent = content
        .map((c) =>
          c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
        )
        .filter((c, i, arr) => {
          const previous = arr.at(i - 1);
          return !(
            c.type === "text" &&
            c.text === "Image reading is disabled." &&
            i > 0 &&
            previous?.type === "text" &&
            previous.text === "Image reading is disabled."
          );
        });
      return Object.assign({}, msg, { content: filteredContent });
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
      systemPrompt: options.systemPrompt,
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
    onPayload: async (payload) => {
      const runner = extensionRunnerRef.current;
      if (!runner?.hasHandlers("before_provider_request")) {
        return payload;
      }
      return await runWithSessionWriteSettlement(
        async () => await runner.emitBeforeProviderRequest(payload),
      );
    },
    onResponse: async (response) => {
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
  setInternalBeforeToolBatch(agent, options.beforeToolBatch);
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
  const initializeMetadata = () => {
    // Prepared history needs no write permit when its initial metadata already exists.
    // Otherwise restoration waits behind unrelated writes, including reclamation.
    if (hasExistingSession && hasThinkingEntry) {
      return Promise.resolve();
    }
    return withSessionManagerWrite(sessionManager, async () => {
      assertInitialSessionCurrent();
      if (!hasExistingSession) {
        await appendInitialMetadata(
          { type: "model_change", provider: model.provider, modelId: model.id },
          () => sessionManager.appendModelChange(model.provider, model.id),
        );
        assertInitialSessionCurrent();
      }
      await appendInitialMetadata({ type: "thinking_level_change", thinkingLevel }, () =>
        sessionManager.appendThinkingLevelChange(thinkingLevel),
      );
      if (hasExistingSession) {
        assertInitialSessionCurrent();
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
    ...options,
    agent,
    cwd,
    allowedToolNames: options.tools,
    extensionRunnerRef,
  });
  return { session };
}
