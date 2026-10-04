import { createHash } from "node:crypto";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import {
  createAgentToolResultMiddlewareRunner,
  createCodexAppServerToolResultExtensionRunner,
  extractMessagingToolSend,
  extractMessagingToolSendResult,
  finalizeToolTerminalPresentation,
  formatToolExecutionErrorMessage,
  getBeforeToolCallFailureDisposition,
  embeddedAgentLog,
  getChannelAgentToolMeta,
  getPluginToolMeta,
  getPluginToolSideEffectOwnerKey,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  isDeliveredMessageToolOnlySourceReplyResult,
  isDeliveredMessagingToolResult,
  isDeliveredMessagingToolSendToCurrentSource,
  isReplaySafeToolCall,
  isToolResultError,
  isMessagingTool,
  projectPluginMessageDeliveryFact,
  readToolOperatorHint,
  resolveToolExecutionErrorKind,
  readEmbeddedMessageDeliveryFact,
  runAgentHarnessAfterToolCallHook,
  sanitizeToolResult,
  type AnyAgentTool,
  type MessagingToolSend,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  collectAgentHarnessMessagingMediaUrls,
  copyInternalToolResultState,
  createAgentHarnessToolExecutionBoundaryRegistry,
  extractMessagingToolSourceReplyPayload,
  getCoreTtsToolResultMediaUrls,
  normalizeAcceptedSessionSpawnResult,
  recordAgentHarnessToolResultTelemetry,
  runAgentHarnessToolInvocation,
  type AgentHarnessToolResultTelemetry,
  type AcceptedSessionSpawn,
  type AgentHarnessToolExecutionSnapshot,
} from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type { RemoteWorkspaceFileReader } from "openclaw/plugin-sdk/file-access-runtime";
import {
  type JsonSchemaObject,
  validateJsonSchemaValue,
} from "openclaw/plugin-sdk/json-schema-runtime";
import type { ImageContent } from "openclaw/plugin-sdk/llm";
import {
  asNonArrayRecord,
  asOptionalRecord,
  isRecord,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
  resolveLiveToolResultMaxChars,
} from "openclaw/plugin-sdk/text-utility-runtime";
import type { CodexDynamicToolsLoading } from "./config.js";
import { createCodexAutomationsToolsAllowResolver } from "./dynamic-tool-automations-allowlist.js";
import { finalizeCodexToolAvailability } from "./dynamic-tool-availability.js";
import {
  createCodexDynamicToolSpecs,
  projectCodexDynamicTools,
  type CodexDynamicToolSchemaQuarantine,
  type CodexToolDescriptor,
} from "./dynamic-tool-catalog.js";
import { convertToolContents, enforceWholeSkillResult } from "./dynamic-tool-content.js";
import {
  type CodexDynamicToolHookContextBase,
  projectCodexExecutableDynamicToolSurface,
} from "./dynamic-tool-executable-projection.js";
import {
  createFailedDynamicToolResponse,
  failedToolResult,
  type CodexDynamicToolRuntimeResponse,
} from "./dynamic-tool-response-state.js";
import { resolveCodexToolResultSourceReply } from "./dynamic-tool-source-reply.js";
import type { CodexDynamicToolCallParams, CodexDynamicToolSpec } from "./protocol.js";
import { flattenCodexDynamicToolFunctions } from "./protocol.js";
import {
  prepareCodexRemoteWorkspaceMessageMedia,
  resolveCodexMediaSourceUrls,
} from "./remote-workspace-media.js";
import { resolveCodexToolAbortTerminalReason } from "./tool-abort-terminal-reason.js";

type CodexDynamicToolHookContext = CodexDynamicToolHookContextBase & {
  remoteWorkspaceRoot?: string;
  remoteWorkspaceRequestTimeoutMs?: number;
  currentChannelProvider?: string;
  contextWindowTokens?: number;
  currentChannelId?: string;
  currentMessagingTarget?: string;
  currentMessageId?: string | number;
  currentThreadId?: string;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
  sourceReplyDeliveryMode?: EmbeddedRunAttemptParams["sourceReplyDeliveryMode"];
};

type CodexToolResultHookContext = Pick<
  CodexDynamicToolHookContext,
  "agentId" | "sessionId" | "sessionKey" | "runId" | "channelId"
>;

const MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERRORS = 4;
const MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERROR_CHARS = 160;
const CODEX_DYNAMIC_TOOL_VALIDATION_TRUNCATED_SUFFIX = " [detail truncated]";

function assertCodexDynamicToolInputMatchesSchema(params: {
  toolName: string;
  schema: JsonSchemaObject;
  value: unknown;
}): void {
  const validation = validateJsonSchemaValue({
    schema: params.schema,
    cacheKey: `codex-dynamic-tool-input:${params.toolName}:${JSON.stringify(params.schema)}`,
    value: params.value,
  });
  if (validation.ok) {
    return;
  }
  const visibleErrors = validation.errors.slice(0, MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERRORS);
  const details = visibleErrors
    .map((error) => {
      if (error.text.length <= MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERROR_CHARS) {
        return error.text;
      }
      return `${error.text.slice(
        0,
        MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERROR_CHARS -
          CODEX_DYNAMIC_TOOL_VALIDATION_TRUNCATED_SUFFIX.length,
      )}${CODEX_DYNAMIC_TOOL_VALIDATION_TRUNCATED_SUFFIX}`;
    })
    .join("; ");
  const omitted = validation.errors.length - visibleErrors.length;
  const omittedSuffix = omitted > 0 ? `; ${omitted} more violation(s) omitted` : "";
  throw new Error(`Invalid arguments for tool "${params.toolName}": ${details}${omittedSuffix}.`);
}

function applyCurrentMessageProvider(
  toolName: string,
  args: Record<string, unknown>,
  currentProvider: string | undefined,
): Record<string, unknown> {
  const hasProvider =
    (typeof args.provider === "string" && args.provider.trim().length > 0) ||
    (typeof args.channel === "string" && args.channel.trim().length > 0);
  const provider = currentProvider?.trim();
  if (toolName !== "message" || hasProvider || !provider) {
    return args;
  }
  return { ...args, provider };
}

export type CodexDynamicToolBridge = {
  /** Final executable tools after schema projection and hook-wrapper quarantine. */
  availableTools: AnyAgentTool[];
  availableSpecs: CodexDynamicToolSpec[];
  specs: CodexDynamicToolSpec[];
  resultContentSourceForTool: (toolName: string) => AnyAgentTool["resultContentSource"];
  sideEffectOwnerKeyForTool: (toolName: string) => string | undefined;
  handleToolCall: (
    params: CodexDynamicToolCallParams,
    options?: {
      signal?: AbortSignal;
      onAgentToolResult?: EmbeddedRunAttemptParams["onAgentToolResult"];
      toolCallOrdinal?: number;
      retainExecutionSnapshot?: boolean;
    },
  ) => Promise<CodexDynamicToolRuntimeResponse>;
  /** Consume exact boundary evidence retained while post-execution processing is incomplete. */
  consumeToolExecutionSnapshot?: (
    toolCallId: string,
  ) => AgentHarnessToolExecutionSnapshot | undefined;
  /** Bind the authenticated app-server client once remote thread startup completes. */
  setRemoteWorkspaceFileReader?: (reader: RemoteWorkspaceFileReader) => void;
  telemetry: AgentHarnessToolResultTelemetry & {
    didDeliverSourceReplyViaMessageTool: boolean;
    sourceReplyDelivered?: true;
    acceptedSessionSpawns: AcceptedSessionSpawn[];
    quarantinedTools: CodexDynamicToolSchemaQuarantine[];
  };
};

function computerFrameImageIdentity(
  content: AgentToolResult<unknown>["content"] | undefined,
): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const images = content.filter((block): block is ImageContent => block.type === "image");
  if (images.length !== 1) {
    return undefined;
  }
  const image = expectDefined(images[0], "single Codex computer frame image");
  return createHash("sha256")
    .update(JSON.stringify([image.mimeType, image.data]))
    .digest("hex");
}

function invalidateComputerFrame(contextEpoch: {
  value: number;
  frameToolCallId?: string;
  frameImageIdentity?: string;
}): void {
  contextEpoch.value += 1;
  delete contextEpoch.frameToolCallId;
  delete contextEpoch.frameImageIdentity;
}

export function createCodexDynamicToolBridge(params: {
  tools: AnyAgentTool[];
  registeredTools?: readonly CodexToolDescriptor[];
  registeredFallbackTools?: AnyAgentTool[];
  registeredSpecs?: readonly CodexDynamicToolSpec[];
  signal: AbortSignal;
  computerContextEpoch?: {
    value: number;
    frameToolCallId?: string;
    frameImageIdentity?: string;
  };
  hookContext?: CodexDynamicToolHookContext;
  loading?: CodexDynamicToolsLoading;
  functionToolsOnly?: boolean;
  directToolNames?: Iterable<string>;
}): CodexDynamicToolBridge {
  const toolResultHookContext = toToolResultHookContext(params.hookContext);
  const contextWindowTokens = params.hookContext?.contextWindowTokens;
  const toolResultMaxChars =
    typeof contextWindowTokens === "number" &&
    Number.isFinite(contextWindowTokens) &&
    contextWindowTokens > 0
      ? Math.max(1, resolveLiveToolResultMaxChars({ contextWindowTokens }))
      : DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS;
  const availableProjection = projectCodexExecutableDynamicToolSurface(
    params.tools,
    params.hookContext,
  );
  const registeredProjection = params.registeredTools
    ? projectCodexDynamicTools(params.registeredTools)
    : availableProjection;
  // Supervised thread declarations are native-owned and fingerprinted. Narrow
  // executors below, but never rewrite the catalog checked by thread-lifecycle-run.
  const inheritedSpecs = params.registeredSpecs
    ? structuredClone([...params.registeredSpecs])
    : undefined;
  const inheritedNames = inheritedSpecs
    ? new Set(flattenCodexDynamicToolFunctions(inheritedSpecs).map((tool) => tool.name))
    : undefined;
  const registrationNames =
    inheritedNames ?? new Set(registeredProjection.tools.map((entry) => entry.name));
  const finalized = finalizeCodexToolAvailability(
    availableProjection.tools.filter((entry) => registrationNames.has(entry.name)),
  );
  const availableTools = finalized.tools;
  const registeredFallbackProjection = projectCodexExecutableDynamicToolSurface(
    params.registeredFallbackTools ?? [],
    params.hookContext,
  );
  const registeredFallbackTools = registeredFallbackProjection.tools.filter(
    (entry) => registrationNames.has(entry.name) && !finalized.preparedNames.has(entry.name),
  );
  const pluginLocalMediaTrustByToolName = new Map<string, ReadonlySet<string>>();
  for (const { name, tool } of availableTools) {
    const pluginMeta = getPluginToolMeta(tool);
    if (pluginMeta) {
      // Bind path trust to the concrete plugin tool so core-name collisions fail closed.
      pluginLocalMediaTrustByToolName.set(
        name,
        new Set(pluginMeta.trustedLocalMedia === true ? [name] : []),
      );
    }
  }
  availableProjection.quarantinedTools.push(...finalized.quarantinedTools);
  const toolMap = new Map(availableTools.map((entry) => [entry.name, entry]));
  const executionToolMap = new Map([
    ...registeredFallbackTools.map((entry) => [entry.name, entry] as const),
    ...toolMap,
  ]);
  const quarantinedAvailableToolNames = new Set(
    availableProjection.quarantinedTools.map((tool) => tool.tool),
  );
  const registeredSpecTools = (params.registeredTools ? registeredProjection.tools : availableTools)
    .filter((entry) => !quarantinedAvailableToolNames.has(entry.name))
    .map((entry) =>
      finalized.preparedNames.has(entry.name) ? (toolMap.get(entry.name) ?? entry) : entry,
    );
  const registeredToolNames =
    inheritedNames ?? new Set(registeredSpecTools.map((entry) => entry.name));
  const quarantinedTools = dedupeQuarantinedDynamicTools([
    ...availableProjection.quarantinedTools,
    ...registeredFallbackProjection.quarantinedTools,
    ...registeredProjection.quarantinedTools,
  ]);
  reportQuarantinedDynamicTools({
    tools: quarantinedTools,
    availableToolCount: availableTools.length,
    registeredToolCount: registeredSpecTools.length,
    hookContext: params.hookContext,
  });
  const telemetry: CodexDynamicToolBridge["telemetry"] = {
    didSendViaMessagingTool: false,
    didDeliverSourceReplyViaMessageTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSourceReplyPayloads: [],
    confirmedMediaDeliveries: [],
    toolMediaUrls: [],
    toolAutoDeliveryMediaUrls: [],
    coreTtsToolResults: [],
    toolAudioAsVoice: false,
    acceptedSessionSpawns: [],
    quarantinedTools,
  };
  const middlewareRunner = createAgentToolResultMiddlewareRunner({
    runtime: "codex",
    ...toolResultHookContext,
  });
  const isReplaySafeToolInstance = (tool: AnyAgentTool): boolean => {
    const pluginMeta = getPluginToolMeta(tool);
    if (pluginMeta) {
      return pluginMeta.replaySafe === true;
    }
    return getChannelAgentToolMeta(tool as never) === undefined;
  };
  const legacyExtensionRunner =
    createCodexAppServerToolResultExtensionRunner(toolResultHookContext);
  const executionBoundaries = createAgentHarnessToolExecutionBoundaryRegistry();
  const directToolNames = params.directToolNames;
  const specs =
    inheritedSpecs ??
    createCodexDynamicToolSpecs({
      entries: registeredSpecTools,
      loading: params.loading ?? "searchable",
      directToolNames,
      functionToolsOnly: params.functionToolsOnly,
    });
  const resolveAutomationsToolsAllow = createCodexAutomationsToolsAllowResolver(specs);
  let readRemoteWorkspaceFile: RemoteWorkspaceFileReader | undefined;
  return {
    availableTools: availableTools.map((entry) => entry.tool),
    availableSpecs: inheritedSpecs
      ? inheritedSpecs.flatMap<CodexDynamicToolSpec>((spec) => {
          if (spec.type === "function") {
            return toolMap.has(spec.name) ? [spec] : [];
          }
          const tools = spec.tools.filter((tool) => toolMap.has(tool.name));
          return tools.length ? [{ ...spec, tools }] : [];
        })
      : createCodexDynamicToolSpecs({
          entries: availableTools,
          loading: params.loading ?? "searchable",
          directToolNames,
          functionToolsOnly: params.functionToolsOnly,
        }),
    specs,
    resultContentSourceForTool: (toolName) => toolMap.get(toolName)?.tool.resultContentSource,
    sideEffectOwnerKeyForTool: (toolName) => {
      const tool = toolMap.get(toolName)?.tool;
      return tool ? getPluginToolSideEffectOwnerKey(tool) : undefined;
    },
    telemetry,
    setRemoteWorkspaceFileReader: (reader) => {
      readRemoteWorkspaceFile = reader;
    },
    consumeToolExecutionSnapshot: executionBoundaries.consume,
    handleToolCall: async (call, options) => {
      const presentTerminal = (
        toolName: string,
        result: AgentToolResult<unknown>,
        isError: boolean,
      ) =>
        finalizeToolTerminalPresentation({
          toolCallId: call.callId,
          runId: toolResultHookContext.runId,
          result,
          isError,
          observer: params.hookContext?.onToolOutcome,
          toolName,
          toolCallOrdinal: options?.toolCallOrdinal,
        });
      const toolEntry = executionToolMap.get(call.tool);
      if (!toolEntry) {
        const executedArguments = asNonArrayRecord(call.arguments);
        const message = registeredToolNames.has(call.tool)
          ? `OpenClaw tool is not available for this turn: ${call.tool}`
          : `Unknown OpenClaw tool: ${call.tool}`;
        const result = failedToolResult(message);
        presentTerminal(call.tool, result, true);
        notifyAgentToolResult(options?.onAgentToolResult, call.tool, result, true);
        return createFailedDynamicToolResponse(message, {
          executedArguments,
          executionStarted: false,
        });
      }
      const { tool, name: toolName } = toolEntry;
      const rawArguments =
        toolName === "automations" ? resolveAutomationsToolsAllow(call.arguments) : call.arguments;
      const args = asNonArrayRecord(rawArguments);
      const invocationStartedAt = Date.now();
      const signal = options?.signal
        ? AbortSignal.any([params.signal, options.signal])
        : params.signal;
      let preparedMessageMedia:
        | Awaited<ReturnType<typeof prepareCodexRemoteWorkspaceMessageMedia>>
        | undefined;
      let messagingContext: Parameters<typeof extractMessagingToolSend>[2];
      let messagingFacts: {
        messagingDelivered: boolean;
        mediaDeliveryConfirmed: boolean;
        confirmedMessagingTarget: MessagingToolSend | undefined;
        deliveredSourceReply: boolean;
      };
      let executedArgsForPresentation = args;
      let rawIsErrorForPresentation = false;
      let telemetryRawResultForPresentation: unknown;
      let presentationIsError = false;
      return runAgentHarnessToolInvocation({
        tool,
        call: {
          toolCallId: call.callId,
          toolName,
          arguments: rawArguments,
          threadId: call.threadId,
          turnId: call.turnId,
        },
        runId: toolResultHookContext.runId,
        startedAt: invocationStartedAt,
        signal,
        boundaries: executionBoundaries,
        retainExecutionSnapshot: options?.retainExecutionSnapshot,
        initialArguments: args,
        prepareArguments: (toolArgs, nativeArgumentsPrepared) => {
          const toolArgsRecord = nativeArgumentsPrepared ? toolArgs : args;
          if (toolName === "message" && isRecord(toolArgsRecord)) {
            return prepareCodexRemoteWorkspaceMessageMedia({
              args: toolArgsRecord,
              localWorkspaceRoot: params.hookContext?.workspaceDir,
              remoteWorkspaceRoot: params.hookContext?.remoteWorkspaceRoot,
              readRemoteFile: readRemoteWorkspaceFile,
              timeoutMs: params.hookContext?.remoteWorkspaceRequestTimeoutMs,
              signal,
            }).then((prepared) => {
              preparedMessageMedia = prepared;
              return prepared.args;
            });
          }
          return toolArgsRecord;
        },
        beforeExecute: () => {
          messagingContext = {
            config: params.hookContext?.config,
            currentChannelId: params.hookContext?.currentChannelId,
            currentMessagingTarget: params.hookContext?.currentMessagingTarget,
            currentThreadId: params.hookContext?.currentThreadId,
            replyToMode: params.hookContext?.replyToMode,
            hasRepliedRef: params.hookContext?.hasRepliedRef
              ? { value: params.hookContext.hasRepliedRef.value }
              : undefined,
          };
        },
        shouldValidateArguments: () => getPluginToolMeta(tool)?.mcp?.operation !== "tool",
        validateArguments: (value) =>
          assertCodexDynamicToolInputMatchesSchema({
            toolName,
            schema: toolEntry.inputSchema,
            value,
          }),
        beforeSnapshotResult: ({ rawResult, rawIsError, executedArguments: executedArgs }) => {
          executedArgsForPresentation = executedArgs;
          rawIsErrorForPresentation = rawIsError;
          const messageDelivery = readEmbeddedMessageDeliveryFact(
            asOptionalRecord(asOptionalRecord(rawResult)?.details)?.messageDelivery,
          );
          const messagingDelivered =
            isMessagingTool(toolName) &&
            (messageDelivery
              ? messageDelivery.status === "settled" &&
                (!rawIsError || messageDelivery.partialDelivery)
              : isDeliveredMessagingToolResult({
                  toolName,
                  args: executedArgs,
                  result: rawResult,
                  isError: rawIsError,
                }));
          const mediaDelivery = messagingDelivered
            ? (messageDelivery ?? projectPluginMessageDeliveryFact(rawResult))
            : undefined;
          const mediaDeliveryConfirmed =
            messagingDelivered &&
            !rawIsError &&
            executedArgs.dryRun !== true &&
            mediaDelivery?.status === "settled" &&
            !mediaDelivery.partialDelivery;
          const messagingTelemetryArgs = applyCurrentMessageProvider(
            toolName,
            executedArgs,
            params.hookContext?.currentChannelProvider,
          );
          const messagingTarget = isMessagingTool(toolName)
            ? extractMessagingToolSend(toolName, messagingTelemetryArgs, messagingContext)
            : undefined;
          const confirmedMessagingTarget =
            messagingDelivered && messagingTarget
              ? extractMessagingToolSendResult(messagingTarget, rawResult)
              : messagingTarget;
          const deliveredSourceReply =
            messagingDelivered &&
            isDeliveredMessageToolOnlySourceReplyResult({
              sourceReplyDeliveryMode: params.hookContext?.sourceReplyDeliveryMode,
              toolName,
              args: executedArgs,
              result: rawResult,
              isError: rawIsError,
              deliveryConfirmed: true,
              allowExplicitSourceRoute: isDeliveredMessagingToolSendToCurrentSource({
                send: confirmedMessagingTarget,
                config: params.hookContext?.config,
                currentProvider: params.hookContext?.currentChannelProvider,
                currentAccountId: params.hookContext?.turnSourceAccountId,
                currentChannelId: params.hookContext?.currentChannelId,
                currentMessagingTarget: params.hookContext?.currentMessagingTarget,
                currentThreadId: params.hookContext?.currentThreadId,
                sessionKey: params.hookContext?.sessionKey,
                deliveredPayload: rawResult,
              }),
            });
          // Delivery is committed before result middleware; presentation changes
          // cannot erase the source owner's confirmation or infer a new one.
          if (toolName === "message" && messageDelivery?.sourceReplyDelivered) {
            telemetry.sourceReplyDelivered = true;
          }
          messagingFacts = {
            messagingDelivered,
            mediaDeliveryConfirmed,
            confirmedMessagingTarget,
            deliveredSourceReply,
          };
        },
        snapshotResult: (rawResult) => {
          telemetryRawResultForPresentation = sanitizeToolResult(rawResult);
          return telemetryRawResultForPresentation;
        },
        applyMiddleware: async (event) => {
          const middlewareResult = await middlewareRunner.applyToolResultMiddleware({
            threadId: call.threadId,
            turnId: call.turnId,
            toolCallId: call.callId,
            toolName,
            args: event.args,
            isError: rawIsErrorForPresentation,
            result: event.result,
          });
          const extendedResult = await legacyExtensionRunner.applyToolResultExtensions({
            threadId: call.threadId,
            turnId: call.turnId,
            toolCallId: call.callId,
            toolName,
            args: structuredClone(executedArgsForPresentation),
            result: middlewareResult,
          });
          const result = enforceWholeSkillResult(toolName, extendedResult, toolResultMaxChars);
          presentationIsError = rawIsErrorForPresentation || isToolResultError(result);
          // A successful spawn is durable before presentation middleware can rewrite details.
          const acceptedSessionSpawn =
            toolName === "sessions_spawn" && !rawIsErrorForPresentation
              ? normalizeAcceptedSessionSpawnResult(telemetryRawResultForPresentation)
              : null;
          if (acceptedSessionSpawn) {
            telemetry.acceptedSessionSpawns.push(acceptedSessionSpawn);
          }
          return result;
        },
        onResult: ({
          boundary: executionBoundary,
          startedAt,
          executedArguments: executedArgs,
          rawResult,
          rawResultSnapshot: telemetryRawResult,
          result,
          observerResult,
          failureKind: resultFailureKind,
        }) => {
          const resultIsError = presentationIsError;
          const {
            messagingDelivered,
            mediaDeliveryConfirmed,
            confirmedMessagingTarget,
            deliveredSourceReply,
          } = messagingFacts;
          notifyAgentToolResult(
            options?.onAgentToolResult,
            toolName,
            observerResult,
            resultIsError,
          );
          void runAgentHarnessAfterToolCallHook({
            toolName,
            toolCallId: call.callId,
            ...toolResultHookContext,
            startArgs: executedArgs,
            result,
            startedAt,
          });
          presentTerminal(toolName, result, resultIsError);
          const terminalType =
            resultFailureKind === "blocked"
              ? "blocked"
              : resultIsError || resultFailureKind
                ? "error"
                : "completed";
          const contentItems = convertToolContents(result.content, toolResultMaxChars);
          const deliveredFrameImages = contentItems.filter((item) => item.type === "inputImage");
          const finalFrameImageIdentity = computerFrameImageIdentity(result.content);
          if (
            toolName === "computer" &&
            params.computerContextEpoch?.frameToolCallId === call.callId &&
            (deliveredFrameImages.length !== 1 ||
              finalFrameImageIdentity === undefined ||
              finalFrameImageIdentity !== params.computerContextEpoch.frameImageIdentity)
          ) {
            // Middleware may replace screenshots; retain coordinates only for exact frame bytes.
            invalidateComputerFrame(params.computerContextEpoch);
          }
          const response: CodexDynamicToolRuntimeResponse = {
            contentItems,
            success: !resultIsError,
            diagnosticTerminalType: terminalType,
            diagnosticTerminalReason:
              resultFailureKind === "blocked" ? undefined : resultFailureKind,
            transcriptDetails: asOptionalRecord(sanitizeToolResult(result))?.details,
          };
          const sourceReply = resolveCodexToolResultSourceReply({
            sourceReplyDeliveryMode: params.hookContext?.sourceReplyDeliveryMode,
            canDeliverSourceReply: toolEntry.tool.canDeliverSourceReply,
            toolName,
            call,
            resultIsError,
            rawResult,
            result,
            deliveredSourceReply,
            executedArgs,
            runId: toolResultHookContext.runId,
            payloads: telemetry.messagingToolSourceReplyPayloads,
          });
          const autoDeliveryTtsMediaUrls = getCoreTtsToolResultMediaUrls(rawResult);
          recordAgentHarnessToolResultTelemetry({
            extractSourceReplyPayload: extractMessagingToolSourceReplyPayload,
            collectMessagingMediaUrls: collectAgentHarnessMessagingMediaUrls,
            resolveMessagingMediaSourceUrls: (mediaUrls) =>
              resolveCodexMediaSourceUrls(mediaUrls, preparedMessageMedia?.sourcePathsByStagedPath),
            toolName,
            args: executedArgs,
            result,
            mediaTrustResult: telemetryRawResult,
            telemetry,
            signal,
            isError: resultIsError,
            messagingDelivered,
            mediaDeliveryConfirmed,
            autoDeliveryTtsMediaUrls,
            coreTtsToolResult: autoDeliveryTtsMediaUrls?.length ? rawResult : undefined,
            messagingTarget: confirmedMessagingTarget,
            sourceReplyFinal: sourceReply.final,
            trustedLocalMediaToolNames: pluginLocalMediaTrustByToolName.get(toolName),
          });
          if (deliveredSourceReply || sourceReply.toolConfirmed) {
            telemetry.didDeliverSourceReplyViaMessageTool = true;
          }
          response.terminate = sourceReply.terminate;
          const asyncStarted =
            isAsyncStartedToolResult(rawResult) || isAsyncStartedToolResult(result);
          response.asyncStarted = asyncStarted || undefined;
          const replaySafe =
            executionBoundary.executionPrevented ||
            (!asyncStarted &&
              isReplaySafeToolInstance(toolEntry.tool) &&
              isReplaySafeToolCall(toolName, executedArgs));
          copyInternalToolResultState(rawResult, response);
          response.executedArguments = executedArgs;
          response.executionStarted = executionBoundary.executionStarted;
          response.replaySafe = replaySafe;
          response.sideEffectEvidence = !replaySafe || undefined;
          return response;
        },
        onError: ({
          error,
          boundary: executionBoundary,
          executedArguments: executedArgs,
          startedAt,
        }) => {
          if (
            toolName === "computer" &&
            params.computerContextEpoch?.frameToolCallId === call.callId
          ) {
            // Post-processing can fail after arming; retain only frames Codex received.
            invalidateComputerFrame(params.computerContextEpoch);
          }
          const beforeToolCallDisposition = getBeforeToolCallFailureDisposition(error);
          const executionDisposition =
            beforeToolCallDisposition ??
            (signal.aborted
              ? resolveCodexToolAbortTerminalReason(signal)
              : resolveToolExecutionErrorKind(error));
          const errorMessage = formatToolExecutionErrorMessage(
            error,
            "OpenClaw dynamic tool call failed.",
          );
          const operatorHint = readToolOperatorHint(error);
          if (operatorHint) {
            embeddedAgentLog.error(`[tools] ${toolName} failed: ${errorMessage} ${operatorHint}`);
          }
          executionBoundary.consumeBlocked();
          const failedResult = failedToolResult(errorMessage, executionDisposition);
          presentTerminal(toolName, failedResult, true);
          notifyAgentToolResult(options?.onAgentToolResult, toolName, failedResult, true);
          void runAgentHarnessAfterToolCallHook({
            toolName,
            toolCallId: call.callId,
            ...toolResultHookContext,
            startArgs: executedArgs,
            error: errorMessage,
            startedAt,
          });
          const replaySafe =
            !executionBoundary.didStartExecution ||
            executionBoundary.executionPrevented ||
            (isReplaySafeToolInstance(toolEntry.tool) &&
              isReplaySafeToolCall(toolName, executedArgs));
          return {
            contentItems: [{ type: "inputText", text: errorMessage }],
            success: false,
            diagnosticTerminalType: executionDisposition === "blocked" ? "blocked" : "error",
            diagnosticTerminalReason:
              executionDisposition === "blocked" ? undefined : executionDisposition,
            executedArguments: executedArgs,
            executionStarted: executionBoundary.executionStarted,
            replaySafe,
            sideEffectEvidence: (executionBoundary.didStartExecution && !replaySafe) || undefined,
          };
        },
      });
    },
  };
}

/** Applies the exact schema and hook-wrapper projection used by the executable Codex bridge. */
export function projectCodexExecutableDynamicTools(params: {
  tools: readonly AnyAgentTool[];
  hookContext?: CodexDynamicToolHookContext;
}): {
  availableTools: AnyAgentTool[];
  quarantinedTools: CodexDynamicToolSchemaQuarantine[];
} {
  const projected = projectCodexExecutableDynamicToolSurface(params.tools, params.hookContext);
  const finalized = finalizeCodexToolAvailability(projected.tools);
  return {
    availableTools: finalized.tools.map((entry) => entry.tool),
    quarantinedTools: [...projected.quarantinedTools, ...finalized.quarantinedTools],
  };
}

function notifyAgentToolResult(
  observer: EmbeddedRunAttemptParams["onAgentToolResult"] | undefined,
  toolName: string,
  result: unknown,
  isError: boolean,
) {
  try {
    observer?.({
      toolName,
      result: sanitizeToolResult(result),
      isError,
    });
  } catch (error) {
    const message = formatToolExecutionErrorMessage(error, "Unknown error");
    embeddedAgentLog.warn(`onAgentToolResult handler failed: tool=${toolName} error=${message}`);
  }
}

function reportQuarantinedDynamicTools(params: {
  tools: readonly CodexDynamicToolSchemaQuarantine[];
  availableToolCount: number;
  registeredToolCount: number;
  hookContext?: CodexDynamicToolHookContext;
}): void {
  if (params.tools.length === 0) {
    return;
  }
  embeddedAgentLog.warn(
    `codex app-server quarantined ${params.tools.length} unsupported dynamic tool ${params.tools.length === 1 ? "definition" : "definitions"}: ${params.tools.map((tool) => tool.tool).join(", ")}; retained ${params.availableToolCount} available and ${params.registeredToolCount} registered tools`,
    {
      tools: params.tools.map(({ tool, violations }) => ({ tool, violations })),
      availableToolCount: params.availableToolCount,
      registeredToolCount: params.registeredToolCount,
    },
  );
  for (const tool of params.tools) {
    emitTrustedDiagnosticEvent({
      type: "tool.execution.blocked",
      agentId: params.hookContext?.agentId,
      runId: params.hookContext?.runId,
      sessionId: params.hookContext?.sessionId,
      sessionKey: params.hookContext?.sessionKey,
      toolName: tool.tool,
      deniedReason: "unsupported_tool_schema",
      reason: tool.violations.join(", "),
    });
  }
}

function dedupeQuarantinedDynamicTools(
  tools: readonly CodexDynamicToolSchemaQuarantine[],
): CodexDynamicToolSchemaQuarantine[] {
  return [
    ...new Map(
      tools.map((tool) => [
        tool.tool,
        {
          tool: tool.tool,
          violations: tool.violations,
        },
      ]),
    ).values(),
  ];
}
function toToolResultHookContext(
  ctx: CodexDynamicToolHookContext | undefined,
): CodexToolResultHookContext {
  const { agentId, sessionId, sessionKey, runId, channelId } = ctx ?? {};
  return {
    ...(agentId && { agentId }),
    ...(sessionId && { sessionId }),
    ...(sessionKey && { sessionKey }),
    ...(runId && { runId }),
    ...(channelId && { channelId }),
  };
}

function isAsyncStartedToolResult(result: AgentToolResult<unknown>): boolean {
  const details = result.details;
  return isRecord(details) && details.async === true && details.status === "started";
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
