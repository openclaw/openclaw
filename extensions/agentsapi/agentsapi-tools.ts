import {
  applyEmbeddedAttemptToolsAllow,
  buildAgentHookContextChannelFields,
  buildEmbeddedAttemptToolRunContext,
  collectMessagingMediaUrlsFromRecord,
  consumeAdjustedParamsForToolCall,
  createAgentToolResultMiddlewareRunner,
  embeddedAgentLog,
  extractMessagingToolSend,
  extractMessagingToolSendResult,
  extractMessagingToolSourceReplyPayload,
  extractToolErrorMessage,
  extractToolResultMediaArtifact,
  filterToolResultMediaUrls,
  finalizeAgentToolAvailability,
  finalizeToolTerminalPresentation,
  formatToolExecutionErrorMessage,
  getBeforeToolCallFailureDisposition,
  getPluginToolMeta,
  getPluginToolSideEffectOwnerKey,
  isAsyncStartedToolResult,
  isDeliveredMessageToolOnlySourceReplyResult,
  isDeliveredMessagingToolResult,
  isMessagingTool,
  isReplaySafeToolCall,
  isSubagentSessionKey,
  isToolResultError,
  normalizeAgentRuntimeTools,
  normalizeAcceptedSessionSpawnResult,
  projectRuntimeToolInputSchema,
  readAsyncStartedTaskIds,
  resolveAgentDir,
  resolveToolExecutionErrorKind,
  resolveToolResultFailureKind,
  runAgentHarnessAfterToolCallHook,
  sanitizeToolResult,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessAttemptResult,
  type AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  consumeTrustedToolNoStartError,
  runWithToolExecutionValidation,
} from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { normalizeOpenAIStrictCompatSchema } from "openclaw/plugin-sdk/provider-tools";
import { asOptionalRecord, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
  resolveLiveToolResultMaxChars,
  sliceToolResultTextToBudget,
} from "openclaw/plugin-sdk/text-utility-runtime";
import type { AgentsApiFunctionCall, AgentsApiFunctionDeclaration } from "./agentsapi-client.js";

type ToolDelivery = Pick<
  AgentHarnessAttemptResult,
  | "didSendViaMessagingTool"
  | "didDeliverSourceReplyViaMessageTool"
  | "sourceReplyDelivered"
  | "messagingToolSentTexts"
  | "messagingToolSentMediaUrls"
  | "messagingToolSentTargets"
  | "messagingToolSourceReplyPayloads"
  | "toolMediaUrls"
  | "toolAudioAsVoice"
  | "toolTrustedLocalMedia"
>;

type AgentsApiToolExecutionResult = (
  | { success: true; output: string }
  | { success: false; error: string }
) & { sourceReplyDelivered?: true; terminate?: true };

export type AgentsApiToolSurface = {
  declarations: AgentsApiFunctionDeclaration[];
  execute: (call: AgentsApiFunctionCall) => Promise<AgentsApiToolExecutionResult>;
  delivery: ToolDelivery;
  runtimeFacts: Pick<AgentHarnessAttemptResult, "acceptedSessionSpawns">;
  toolMetas: AgentHarnessAttemptResult["toolMetas"];
  readonly lastToolError: AgentHarnessAttemptResult["lastToolError"];
};

/** Gateway functions retain host authority; shell and file tools stay in the hosted VM. */
export function buildAgentsApiToolSurface(
  params: AgentHarnessAttemptParamsV2,
  signal: AbortSignal,
  assertCurrent: () => void,
  registerCleanup: (cleanup: (reason: string) => Promise<void>) => void,
): AgentsApiToolSurface {
  assertCurrent();
  const agentId = params.agentId;
  if (!agentId) {
    throw new Error("Agents API tool construction requires a resolved agent ID");
  }
  const forceMessageTool =
    params.disableMessageTool !== true &&
    (params.forceMessageTool === true || params.sourceReplyDeliveryMode === "message_tool_only");
  const runContext = buildEmbeddedAttemptToolRunContext({ ...params, forceMessageTool });
  const policySessionKey = params.sandboxSessionKey ?? params.sessionKey;
  const cwd = params.cwd ?? params.workspaceDir;
  const channelId = buildAgentHookContextChannelFields({
    ...params,
    sessionKey: policySessionKey,
  }).channelId;
  const createToolSurface = params.hostCapabilities.createToolSurface;
  if (!createToolSurface) {
    throw new Error("Agents API tool construction requires a current host capability");
  }
  const constructed = params.disableTools
    ? []
    : createToolSurface(
        {
          ...runContext,
          agentId,
          policyAgentId: params.sandboxAgentId ?? agentId,
          sessionKey: policySessionKey,
          runSessionKey: params.sessionKey !== policySessionKey ? params.sessionKey : undefined,
          sessionId: params.sessionId,
          runId: params.runId,
          config: params.config,
          agentDir: params.agentDir ?? resolveAgentDir(params.config ?? {}, agentId),
          workspaceDir: params.workspaceDir,
          cwd,
          spawnWorkspaceDir: params.workspaceDir,
          preparedModelRuntime: params.preparedModelRuntime,
          skillsSnapshot: params.skillsSnapshot,
          authProfileStore: params.toolAuthProfileStore ?? params.authProfileStore,
          messageProvider: params.messageChannel ?? params.messageProvider,
          messageChannel: params.messageChannel,
          toolPolicyMessageProvider: params.messageProvider ?? params.messageChannel,
          channelContext: params.channelContext,
          hookChannelId: channelId,
          inboundEventKind: params.currentInboundEventKind,
          requireExplicitMessageTarget:
            params.requireExplicitMessageTarget ??
            (params.sessionKey !== undefined && isSubagentSessionKey(params.sessionKey)),
          disableMessageTool: params.disableMessageTool,
          forceMessageTool,
          ...(params.onToolResult
            ? {
                questionPrompt: {
                  send: params.onToolResult,
                  messageChannel: params.messageChannel,
                },
              }
            : {}),
          inputProvenance: params.inputProvenance,
          trustedInternalHandoff: params.trustedInternalHandoff,
          delegationCapability: params.delegationCapability,
          allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
          githubPublicationAvailable: params.githubPublicationAvailable,
          abortSignal: signal,
          onToolOutcome: params.onToolOutcome,
          isTurnTainted: params.isTurnTainted,
          allocateToolOutcomeOrdinal: params.allocateToolOutcomeOrdinal,
          registerRunCleanup: registerCleanup,
          oneShotCliRun: params.oneShotCliRun,
          modelProvider: params.model.provider,
          modelId: params.modelId,
          modelApi: params.model.api,
          modelCompat: params.model.compat,
          modelContextWindowTokens: params.contextTokenBudget ?? params.model.contextWindow,
          modelHasVision: false,
          includeToolSearchControls: false,
          toolConstructionPlan: {
            includeBaseCodingTools: false,
            includeShellTools: false,
            includeChannelTools: false,
            includeOpenClawTools: true,
            includePluginTools: true,
          },
        },
        { cwd },
      );
  const tools = applyEmbeddedAttemptToolsAllow(
    // Native turns cannot claim requester yields; image generation is outside this prototype.
    constructed.filter((tool) => tool.name !== "image_generate" && tool.name !== "sessions_yield"),
    runContext.runtimeToolAllowlist,
    { toolMeta: getPluginToolMeta },
  );
  const normalized = normalizeAgentRuntimeTools({
    tools,
    runtimePlan: params.runtimePlan,
    provider: params.provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    modelId: params.modelId,
    modelApi: params.model.api,
    model: params.model,
    allowProviderRuntimePluginLoad: false,
  });
  finalizeAgentToolAvailability(normalized);
  const entries = normalized
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((tool) => {
      const projection = projectRuntimeToolInputSchema(
        normalizeOpenAIStrictCompatSchema(tool.parameters) ?? tool.parameters,
        `${tool.name}.parameters`,
      );
      if (projection.violations.length || !isRecord(projection.schema)) {
        throw new Error(`Agents API tool has an unsupported input schema: ${tool.name}`);
      }
      return {
        tool,
        schema: projection.schema,
        validationCacheKey: `agentsapi-tool-input:${tool.name}:${JSON.stringify(projection.schema)}`,
      };
    });
  const toolMap = new Map(entries.map((entry) => [entry.tool.name, entry]));
  const declarations: AgentsApiFunctionDeclaration[] = entries.map(({ tool, schema }) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: schema,
  }));
  const middleware = createAgentToolResultMiddlewareRunner({
    runtime: "agentsapi",
    agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runId: params.runId,
  });
  const delivery: ToolDelivery = {
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSourceReplyPayloads: [],
    toolMediaUrls: [],
  };
  const toolMetas: AgentsApiToolSurface["toolMetas"] = [];
  const runtimeFacts: AgentsApiToolSurface["runtimeFacts"] = { acceptedSessionSpawns: [] };
  let lastToolError: AgentsApiToolSurface["lastToolError"];
  const contextTokens = params.contextTokenBudget ?? params.model.contextWindow;
  const maxChars =
    typeof contextTokens === "number" && Number.isFinite(contextTokens) && contextTokens > 0
      ? resolveLiveToolResultMaxChars({ contextWindowTokens: contextTokens })
      : DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS;

  return {
    declarations,
    delivery,
    runtimeFacts,
    toolMetas,
    get lastToolError() {
      return lastToolError;
    },
    execute: async (call) => {
      assertCurrent();
      signal.throwIfAborted();
      const entry = toolMap.get(call.name);
      const startedAt = Date.now();
      let executedArgs = isRecord(call.arguments) ? call.arguments : {};
      let rawResult: Awaited<ReturnType<AnyAgentTool["execute"]>> | undefined;
      let executionDispatched = false;
      let executionPrevented = false;
      let terminalObserved = false;
      let resultObserved = false;
      let afterHookDispatched = false;
      let replaySafe = false;
      let asyncStarted = false;
      let asyncTaskIds: ReturnType<typeof readAsyncStartedTaskIds> = {};
      let sourceReplyDelivered = false;
      let terminate = false;
      const captureArguments = () => {
        const adjusted = consumeAdjustedParamsForToolCall(call.call_id, params.runId);
        if (isRecord(adjusted)) {
          executedArgs = adjusted;
        }
      };
      const observeTerminal = (result: unknown, outcome: "success" | "failure", error?: string) => {
        if (terminalObserved) {
          return;
        }
        terminalObserved = true;
        captureArguments();
        const ownerKey = entry ? getPluginToolSideEffectOwnerKey(entry.tool) : undefined;
        const pluginMeta = entry ? getPluginToolMeta(entry.tool) : undefined;
        const resolution = params.observeToolTerminal?.({
          toolCallId: call.call_id,
          toolName: call.name,
          arguments: executedArgs,
          result,
          outcome,
          executionStarted: executionDispatched && !executionPrevented,
          replaySafe:
            !asyncStarted &&
            (!pluginMeta || pluginMeta.replaySafe === true) &&
            isReplaySafeToolCall(call.name, executedArgs),
          ...(ownerKey ? { ownerMutation: { ownerKey } } : {}),
          ...(error ? { failure: { error } } : {}),
        });
        if (resolution) {
          lastToolError = resolution.lastToolError;
          if (resolution.executedArguments) {
            executedArgs = resolution.executedArguments;
          }
          replaySafe = ["not_started", "read_completed", "failed_no_effect"].includes(
            resolution.effectReceipt.state,
          );
        }
      };
      const finishPresentation = (
        result: Awaited<ReturnType<AnyAgentTool["execute"]>>,
        isError: boolean,
      ) => {
        if (resultObserved) {
          return;
        }
        resultObserved = true;
        toolMetas.push({
          toolName: call.name,
          toolCallId: call.call_id,
          isError,
          replaySafe,
          ...(asyncStarted ? { asyncStarted: true, ...asyncTaskIds } : {}),
          ...(terminate ? { terminate: true } : {}),
        });
        try {
          params.onAgentToolResult?.({
            toolName: call.name,
            result: sanitizeToolResult(result),
            isError,
          });
        } catch (error) {
          embeddedAgentLog.warn(
            `Agents API tool result observer failed: ${formatToolExecutionErrorMessage(error, "Unknown error")}`,
          );
        }
        try {
          finalizeToolTerminalPresentation({
            toolCallId: call.call_id,
            runId: params.runId,
            toolName: call.name,
            result,
            isError,
            observer: params.onToolOutcome,
          });
        } catch (error) {
          embeddedAgentLog.warn(
            `Agents API tool presentation observer failed: ${formatToolExecutionErrorMessage(error, "Unknown error")}`,
          );
        }
      };
      const dispatchAfterHook = (result?: unknown, error?: string) => {
        if (afterHookDispatched) {
          return;
        }
        afterHookDispatched = true;
        void runAgentHarnessAfterToolCallHook({
          runId: params.runId,
          agentId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          channelId,
          toolName: call.name,
          toolCallId: call.call_id,
          startArgs: executedArgs,
          ...(result !== undefined ? { result } : {}),
          ...(error ? { error } : {}),
          startedAt,
        }).catch((failure: unknown) => {
          embeddedAgentLog.warn(
            `Agents API after-tool hook failed: ${formatToolExecutionErrorMessage(failure, "Unknown error")}`,
          );
        });
      };
      try {
        if (!entry) {
          throw new Error(`OpenClaw tool is not available for this turn: ${call.name}`);
        }
        const { tool } = entry;
        const args = tool.prepareArguments
          ? Reflect.apply(tool.prepareArguments, tool, [call.arguments])
          : call.arguments;
        if (!isRecord(args)) {
          throw new Error(`Arguments for OpenClaw tool ${call.name} must be an object`);
        }
        executedArgs = args;
        await params.onToolStreamBoundary?.();
        assertCurrent();
        signal.throwIfAborted();
        const messagingContext = {
          config: params.config,
          currentChannelId: params.currentChannelId,
          currentMessagingTarget: params.currentMessagingTarget,
          currentThreadId: params.currentThreadTs,
          currentMessageId: params.currentMessageId,
          replyToMode: params.replyToMode,
          hasRepliedRef: params.hasRepliedRef ? { value: params.hasRepliedRef.value } : undefined,
        };
        const execute = () => {
          assertCurrent();
          signal.throwIfAborted();
          executionDispatched = true;
          return tool.execute(call.call_id, args, signal);
        };
        const raw =
          getPluginToolMeta(tool)?.mcp?.operation === "tool"
            ? await execute()
            : await runWithToolExecutionValidation(
                call.call_id,
                (value) => {
                  assertCurrent();
                  signal.throwIfAborted();
                  const validation = validateJsonSchemaValue({
                    schema: entry.schema,
                    cacheKey: entry.validationCacheKey,
                    value,
                  });
                  if (!validation.ok) {
                    throw new Error(
                      `Invalid arguments for OpenClaw tool ${call.name}: ${validation.errors
                        .slice(0, 4)
                        .map((error) => error.text)
                        .join("; ")}`,
                    );
                  }
                },
                execute,
              );
        rawResult = raw;
        captureArguments();
        const rawFailure = resolveToolResultFailureKind(raw);
        const rawIsError = isToolResultError(raw);
        asyncStarted = !rawIsError && isAsyncStartedToolResult(raw);
        asyncTaskIds = asyncStarted ? readAsyncStartedTaskIds(raw) : {};
        const acceptedSpawn =
          call.name === "sessions_spawn" && !rawIsError
            ? normalizeAcceptedSessionSpawnResult(raw)
            : null;
        if (acceptedSpawn) {
          runtimeFacts.acceptedSessionSpawns?.push(acceptedSpawn);
        }
        sourceReplyDelivered =
          call.name === "message" &&
          asOptionalRecord(asOptionalRecord(raw.details)?.messageDelivery)?.sourceReplyDelivered ===
            true;
        const sourceRouteDelivered = isDeliveredMessageToolOnlySourceReplyResult({
          sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
          toolName: call.name,
          args: executedArgs,
          result: raw,
          isError: rawIsError,
        });
        terminate =
          sourceReplyDelivered ||
          (raw.terminate === true && !(sourceRouteDelivered && executedArgs.final === false));
        if (sourceReplyDelivered) {
          delivery.sourceReplyDelivered = true;
        }
        if (sourceRouteDelivered || sourceReplyDelivered) {
          delivery.didDeliverSourceReplyViaMessageTool = true;
        }
        recordDelivery(
          tool,
          executedArgs,
          raw,
          params,
          messagingContext,
          delivery,
          signal,
          sourceRouteDelivered ? executedArgs.final !== false : undefined,
        );
        // Presentation failures cannot downgrade a completed host mutation's receipt.
        observeTerminal(
          raw,
          rawIsError ? "failure" : "success",
          rawIsError ? extractToolErrorMessage(raw) : undefined,
        );
        const presented = await middleware.applyToolResultMiddleware({
          turnId: call.turn_id,
          toolCallId: call.call_id,
          toolName: call.name,
          args: structuredClone(executedArgs),
          cwd,
          isError: rawIsError,
          result: raw,
        });
        const isError = rawIsError || isToolResultError(presented);
        const finalFailure = resolveToolResultFailureKind(presented);
        const observed =
          rawFailure && rawFailure !== finalFailure
            ? {
                ...presented,
                details: { ...asOptionalRecord(presented.details), status: rawFailure },
              }
            : presented;
        finishPresentation(observed, isError);
        assertCurrent();
        signal.throwIfAborted();
        dispatchAfterHook(presented);
        const text = serializeToolText(presented.content, maxChars);
        return {
          ...(isError
            ? { success: false as const, error: text }
            : { success: true as const, output: text }),
          ...(sourceReplyDelivered ? { sourceReplyDelivered: true as const } : {}),
          ...(terminate ? { terminate: true as const } : {}),
        };
      } catch (error) {
        executionPrevented ||= consumeTrustedToolNoStartError(error);
        const message = sanitizeToolResult(
          formatToolExecutionErrorMessage(error, "OpenClaw tool failed"),
        );
        const disposition =
          getBeforeToolCallFailureDisposition(error) ??
          (signal.aborted ? "cancelled" : resolveToolExecutionErrorKind(error));
        const failed = {
          content: [{ type: "text" as const, text: message }],
          details: { status: disposition, error: message },
        };
        observeTerminal(rawResult ?? error, "failure", message);
        finishPresentation(failed, true);
        signal.throwIfAborted();
        assertCurrent();
        dispatchAfterHook(undefined, message);
        return {
          success: false,
          error: sliceToolResultTextToBudget(message, maxChars),
          ...(sourceReplyDelivered ? { sourceReplyDelivered: true } : {}),
          ...(terminate ? { terminate: true } : {}),
        };
      }
    },
  };
}

function recordDelivery(
  tool: AnyAgentTool,
  args: Record<string, unknown>,
  raw: Awaited<ReturnType<AnyAgentTool["execute"]>>,
  params: AgentHarnessAttemptParamsV2,
  messagingContext: Parameters<typeof extractMessagingToolSend>[2],
  delivery: ToolDelivery,
  signal: AbortSignal,
  sourceReplyFinal?: boolean,
): void {
  if (
    isMessagingTool(tool.name) &&
    isDeliveredMessagingToolResult({ toolName: tool.name, args, result: raw })
  ) {
    delivery.didSendViaMessagingTool = true;
    const payload = extractMessagingToolSourceReplyPayload(raw);
    if (payload) {
      delivery.messagingToolSourceReplyPayloads?.push({
        ...payload,
        sourceReplyFinal: args.final !== false,
      });
    } else {
      const routedArgs = {
        provider: params.messageChannel ?? params.messageProvider,
        ...args,
      };
      const pending = extractMessagingToolSend(tool.name, routedArgs, messagingContext);
      const text = ["message", "text", "content", "body"]
        .map((key) => args[key])
        .find((value): value is string => typeof value === "string" && value.trim().length > 0);
      const mediaUrls = collectMessagingMediaUrlsFromRecord(args);
      if (pending) {
        const confirmed = extractMessagingToolSendResult(pending, raw);
        delivery.messagingToolSentTargets.push({
          ...confirmed,
          ...(text ? { text } : {}),
          ...(mediaUrls.length ? { mediaUrls } : {}),
          ...(sourceReplyFinal !== undefined ? { sourceReplyFinal } : {}),
        });
      }
      if (text) {
        delivery.messagingToolSentTexts.push(text);
      }
      delivery.messagingToolSentMediaUrls.push(...mediaUrls);
    }
  }
  if (signal.aborted || isToolResultError(raw)) {
    return;
  }
  const media = extractToolResultMediaArtifact(raw);
  if (!media) {
    return;
  }
  const pluginMeta = getPluginToolMeta(tool);
  const trustedTools = pluginMeta
    ? new Set(pluginMeta.trustedLocalMedia === true ? [tool.name] : [])
    : undefined;
  // A plugin named after a core tool cannot inherit that core owner's media trust.
  const mediaToolName = pluginMeta && pluginMeta.trustedLocalMedia !== true ? undefined : tool.name;
  const urls = filterToolResultMediaUrls(mediaToolName, media.mediaUrls, raw, trustedTools);
  delivery.toolMediaUrls = [...new Set([...(delivery.toolMediaUrls ?? []), ...urls])];
  if (media.audioAsVoice) {
    delivery.toolAudioAsVoice = true;
  }
  if (
    media.trustedLocalMedia &&
    (!pluginMeta || pluginMeta.trustedLocalMedia === true) &&
    urls.length
  ) {
    delivery.toolTrustedLocalMedia = true;
  }
}

function serializeToolText(
  content: Awaited<ReturnType<AnyAgentTool["execute"]>>["content"],
  maxChars: number,
): string {
  let text = "";
  for (const block of content) {
    if (text.length >= maxChars) {
      break;
    }
    const next =
      block.type === "text"
        ? sanitizeToolResult(block.text)
        : "[Image result omitted from Agents API function output]";
    text += `${text ? "\n" : ""}${sliceToolResultTextToBudget(next, maxChars - text.length)}`;
  }
  return sliceToolResultTextToBudget(text || "Tool completed with no text output.", maxChars);
}
