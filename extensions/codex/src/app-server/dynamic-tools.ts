/**
 * Bridges OpenClaw runtime tools into Codex app-server dynamic tool specs and
 * tool-call responses.
 */
import { createHash } from "node:crypto";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import {
  createAgentToolResultMiddlewareRunner,
  createCodexAppServerToolResultExtensionRunner,
  extractMessagingToolSend,
  extractMessagingToolSendResult,
  extractMessagingToolSourceReplyPayload,
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
  isToolWrappedWithBeforeToolCallHook,
  isToolResultError,
  isMessagingTool,
  projectPluginMessageDeliveryFact,
  readToolOperatorHint,
  resolveToolExecutionErrorKind,
  readEmbeddedMessageDeliveryFact,
  runAgentHarnessAfterToolCallHook,
  sanitizeToolResult,
  setBeforeToolCallDiagnosticsEnabled,
  type AnyAgentTool,
  type MessagingToolSend,
  type MessagingToolSourceReplyPayload,
  wrapToolWithBeforeToolCallHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  copyInternalToolResultState,
  createAgentHarnessToolExecutionBoundaryRegistry,
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
import {
  type JsonSchemaObject,
  validateJsonSchemaValue,
} from "openclaw/plugin-sdk/json-schema-runtime";
import type { ImageContent, TextContent } from "openclaw/plugin-sdk/llm";
import {
  asNonArrayRecord,
  asOptionalRecord,
  isRecord,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
  estimateToolResultTextChars,
  resolveLiveToolResultMaxChars,
  sliceToolResultTextToBudget,
  sliceUtf16Safe,
} from "openclaw/plugin-sdk/text-utility-runtime";
import type { CodexDynamicToolsLoading } from "./config.js";
import { createCodexAutomationsToolsAllowResolver } from "./dynamic-tool-automations-allowlist.js";
import { finalizeCodexToolAvailability } from "./dynamic-tool-availability.js";
import {
  createCodexDynamicToolSpecs,
  projectCodexDynamicTools,
  type ProjectedCodexDynamicTool as ProjectedTool,
  type CodexDynamicToolSchemaQuarantine,
  type CodexToolDescriptor,
} from "./dynamic-tool-catalog.js";
import {
  createFailedDynamicToolResponse,
  failedToolResult,
  type CodexDynamicToolRuntimeResponse,
} from "./dynamic-tool-response-state.js";
import { invalidInlineImageText, sanitizeInlineImageDataUrl } from "./image-payload-sanitizer.js";
import type {
  CodexDynamicToolCallOutputContentItem,
  CodexDynamicToolCallParams,
  CodexDynamicToolSpec,
} from "./protocol.js";
import { flattenCodexDynamicToolFunctions } from "./protocol.js";
import {
  collectCodexMessageMediaUrls,
  prepareCodexRemoteWorkspaceMessageMedia,
  resolveCodexMediaSourceUrls,
  type CodexRemoteWorkspaceFileReader,
} from "./remote-workspace-media.js";
import { resolveCodexToolAbortTerminalReason } from "./tool-abort-terminal-reason.js";

type CodexDynamicToolHookContext = NonNullable<
  Parameters<typeof wrapToolWithBeforeToolCallHook>[1]
> & {
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

type CodexToolResultHookContext = Omit<CodexDynamicToolHookContext, "config">;

type ProjectedCodexDynamicTool = ProjectedTool<AnyAgentTool>;

const MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERRORS = 4;
const MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERROR_CHARS = 160;
const CODEX_DYNAMIC_TOOL_VALIDATION_TRUNCATED_SUFFIX = " [detail truncated]";

function shouldValidateCodexDynamicToolInput(tool: AnyAgentTool): boolean {
  return getPluginToolMeta(tool)?.mcp?.operation !== "tool";
}

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
    typeof args.provider === "string" && args.provider.trim().length > 0
      ? true
      : typeof args.channel === "string" && args.channel.trim().length > 0;
  const provider = currentProvider?.trim();
  if (toolName !== "message" || hasProvider || !provider) {
    return args;
  }
  return { ...args, provider };
}

export type CodexConfirmedMediaDelivery = {
  sourceUrls: readonly string[];
} & ({ kind: "outbound"; target: MessagingToolSend } | { kind: "sourceReply" });

/** Runtime bridge returned to Codex app-server attempt code. */
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
  setRemoteWorkspaceFileReader?: (reader: CodexRemoteWorkspaceFileReader) => void;
  telemetry: AgentHarnessToolResultTelemetry & {
    didSendViaMessagingTool: boolean;
    didDeliverSourceReplyViaMessageTool: boolean;
    sourceReplyDelivered?: true;
    messagingToolSentTexts: string[];
    messagingToolSentMediaUrls: string[];
    messagingToolSentTargets: MessagingToolSend[];
    messagingToolSourceReplyPayloads: MessagingToolSourceReplyPayload[];
    confirmedMediaDeliveries: CodexConfirmedMediaDelivery[];
    toolMediaUrls: string[];
    toolAutoDeliveryMediaUrls: string[];
    coreTtsToolResults: object[];
    toolAudioAsVoice: boolean;
    successfulCronAdds?: number;
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

/**
 * Creates dynamic tool specs and a call handler that executes OpenClaw tools,
 * applies hooks/middleware, and records delivery/media telemetry.
 */
export function createCodexDynamicToolBridge(params: {
  tools: AnyAgentTool[];
  registeredTools?: readonly CodexToolDescriptor[];
  registeredSpecs?: readonly CodexDynamicToolSpec[];
  signal: AbortSignal;
  computerContextEpoch?: {
    value: number;
    frameToolCallId?: string;
    frameImageIdentity?: string;
  };
  hookContext?: CodexDynamicToolHookContext;
  loading?: CodexDynamicToolsLoading;
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
    });
  const resolveAutomationsToolsAllow = createCodexAutomationsToolsAllowResolver(specs);
  let readRemoteWorkspaceFile: CodexRemoteWorkspaceFileReader | undefined;
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
      const toolEntry = toolMap.get(call.tool);
      if (!toolEntry) {
        const executedArguments = asNonArrayRecord(call.arguments);
        const message = registeredToolNames.has(call.tool)
          ? `OpenClaw tool is not available for this turn: ${call.tool}`
          : `Unknown OpenClaw tool: ${call.tool}`;
        finalizeToolTerminalPresentation({
          toolCallId: call.callId,
          runId: toolResultHookContext.runId,
          result: failedToolResult(message),
          isError: true,
          observer: params.hookContext?.onToolOutcome,
          toolName: call.tool,
          toolCallOrdinal: options?.toolCallOrdinal,
        });
        notifyAgentToolResult(
          options?.onAgentToolResult,
          call.tool,
          failedToolResult(message),
          true,
        );
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
      const signal = composeAbortSignals(params.signal, options?.signal);
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
        shouldValidateArguments: () => shouldValidateCodexDynamicToolInput(tool),
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
          const result = await legacyExtensionRunner.applyToolResultExtensions({
            threadId: call.threadId,
            turnId: call.turnId,
            toolCallId: call.callId,
            toolName,
            args: structuredClone(executedArgsForPresentation),
            result: middlewareResult,
          });
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
            runId: toolResultHookContext.runId,
            agentId: toolResultHookContext.agentId,
            sessionId: toolResultHookContext.sessionId,
            sessionKey: toolResultHookContext.sessionKey,
            channelId: toolResultHookContext.channelId,
            startArgs: executedArgs,
            result,
            startedAt,
          });
          finalizeToolTerminalPresentation({
            toolCallId: call.callId,
            runId: toolResultHookContext.runId,
            result,
            isError: resultIsError,
            observer: params.hookContext?.onToolOutcome,
            toolName,
            toolCallOrdinal: options?.toolCallOrdinal,
          });
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
          const toolConfirmedSourceReply =
            params.hookContext?.sourceReplyDeliveryMode === "message_tool_only" &&
            toolName === "message" &&
            !resultIsError &&
            (rawResult.terminate === true || result.terminate === true);
          const confirmedSourceReply =
            params.hookContext?.sourceReplyDeliveryMode === "message_tool_only" &&
            toolName === "message" &&
            (toolConfirmedSourceReply || deliveredSourceReply);
          const sourceReplyFinal = confirmedSourceReply ? executedArgs.final !== false : undefined;
          const autoDeliveryTtsMediaUrls = getCoreTtsToolResultMediaUrls(rawResult);
          recordAgentHarnessToolResultTelemetry({
            extractSourceReplyPayload: extractMessagingToolSourceReplyPayload,
            collectMessagingMediaUrls: collectCodexMessageMediaUrls,
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
            sourceReplyFinal,
            trustedLocalMediaToolNames: pluginLocalMediaTrustByToolName.get(toolName),
          });
          if (deliveredSourceReply || toolConfirmedSourceReply) {
            telemetry.didDeliverSourceReplyViaMessageTool = true;
          }
          const continuesSourceReplyProgress = confirmedSourceReply && sourceReplyFinal === false;
          response.terminate =
            ((rawResult.terminate === true || result.terminate === true) &&
              !continuesSourceReplyProgress) ||
            // Yield is an explicit owner-level turn handoff, not termination
            // inferred from source-reply delivery, so finality does not mask it.
            isToolResultYield(rawResult) ||
            isToolResultYield(result) ||
            (confirmedSourceReply && sourceReplyFinal === true) ||
            undefined;
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
          finalizeToolTerminalPresentation({
            toolCallId: call.callId,
            runId: toolResultHookContext.runId,
            result: failedResult,
            isError: true,
            observer: params.hookContext?.onToolOutcome,
            toolName,
            toolCallOrdinal: options?.toolCallOrdinal,
          });
          notifyAgentToolResult(options?.onAgentToolResult, toolName, failedResult, true);
          void runAgentHarnessAfterToolCallHook({
            toolName,
            toolCallId: call.callId,
            runId: toolResultHookContext.runId,
            agentId: toolResultHookContext.agentId,
            sessionId: toolResultHookContext.sessionId,
            sessionKey: toolResultHookContext.sessionKey,
            channelId: toolResultHookContext.channelId,
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

function projectCodexExecutableDynamicToolSurface(
  tools: readonly AnyAgentTool[],
  hookContext: CodexDynamicToolHookContext | undefined,
): {
  tools: ProjectedCodexDynamicTool[];
  quarantinedTools: CodexDynamicToolSchemaQuarantine[];
} {
  const { tools: projectedTools, quarantinedTools } = projectCodexDynamicTools(tools);
  const wrappedTools: ProjectedCodexDynamicTool[] = [];
  for (const entry of projectedTools) {
    try {
      if (isToolWrappedWithBeforeToolCallHook(entry.tool)) {
        setBeforeToolCallDiagnosticsEnabled(entry.tool, false);
        wrappedTools.push(entry);
        continue;
      }
      wrappedTools.push({
        ...entry,
        tool: wrapToolWithBeforeToolCallHook(entry.tool, hookContext, {
          emitDiagnostics: false,
        }),
      });
    } catch {
      quarantinedTools.push({
        tool: entry.name,
        violations: [`${entry.name} could not be wrapped for before-tool-call hooks`],
      });
    }
  }
  return {
    tools: wrappedTools,
    quarantinedTools: dedupeQuarantinedDynamicTools(quarantinedTools),
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

function composeAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (activeSignals.length === 0) {
    return new AbortController().signal;
  }
  if (activeSignals.length === 1) {
    return expectDefined(activeSignals[0], "single active Codex abort signal");
  }
  return AbortSignal.any(activeSignals);
}
function isToolResultYield(result: AgentToolResult<unknown>): boolean {
  const details = result.details;
  if (!isRecord(details) || typeof details.status !== "string") {
    return false;
  }
  return details.status.trim().toLowerCase() === "yielded";
}
function isAsyncStartedToolResult(result: AgentToolResult<unknown>): boolean {
  const details = result.details;
  return isRecord(details) && details.async === true && details.status === "started";
}
function normalizeToolResultMaxChars(maxChars: number): number {
  return typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0
    ? Math.floor(maxChars)
    : DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS;
}
function sanitizeToolTextRuns(
  rawContent: Array<TextContent | ImageContent>,
): Array<TextContent | ImageContent> {
  const content: Array<TextContent | ImageContent> = [];
  for (let index = 0; index < rawContent.length;) {
    const item = rawContent[index]!;
    if (item.type !== "text") {
      content.push(item);
      index += 1;
      continue;
    }

    const textRun: TextContent[] = [];
    while (index < rawContent.length) {
      const next = rawContent[index]!;
      if (next.type !== "text") {
        break;
      }
      textRun.push(next);
      index += 1;
    }

    const sanitizedText = sanitizeToolResult(textRun.map((entry) => entry.text).join(""));
    let offset = 0;
    content.push(
      ...textRun.map((entry, runIndex) => {
        const targetEnd =
          runIndex === textRun.length - 1
            ? sanitizedText.length
            : Math.min(sanitizedText.length, offset + entry.text.length);
        const text = sliceUtf16Safe(sanitizedText, offset, targetEnd);
        const sanitized = Object.assign({}, entry, { text });
        offset += text.length;
        return sanitized;
      }),
    );
  }
  return content;
}
function convertToolContents(
  rawContent: Array<TextContent | ImageContent>,
  toolResultMaxChars = DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
): CodexDynamicToolCallOutputContentItem[] {
  // Adjacent text items form one model-visible stream, so sanitize each full run before
  // repartitioning and budgeting. Image blocks keep their bytes; the storage-oriented
  // whole-result branch of sanitizeToolResult would drop them.
  const content = sanitizeToolTextRuns(rawContent);
  const maxChars = normalizeToolResultMaxChars(toolResultMaxChars);
  const totalTextChars = content.reduce(
    (total, item) => total + (item.type === "text" ? item.text.length : 0),
    0,
  );
  const totalTextBudget = content.reduce(
    (total, item) => total + (item.type === "text" ? estimateToolResultTextChars(item.text) : 0),
    0,
  );
  if (totalTextBudget <= maxChars) {
    return content.flatMap(convertToolContent);
  }
  const noticeText = `...(OpenClaw truncated dynamic tool result: original ${totalTextChars} chars, weighted budget ${maxChars}; rerun with narrower args.)`;
  const notice = `\n${noticeText}`;
  const noticeChars = estimateToolResultTextChars(notice);
  const textBudget = Math.max(0, maxChars - noticeChars);
  let remainingTextBudget = textBudget;
  let appendedNotice = false;
  const output: CodexDynamicToolCallOutputContentItem[] = [];
  for (const item of content) {
    if (item.type !== "text") {
      output.push(...convertToolContent(item));
      continue;
    }
    if (appendedNotice) {
      continue;
    }
    if (noticeChars >= maxChars) {
      output.push({ type: "inputText", text: sliceToolResultTextToBudget(noticeText, maxChars) });
      appendedNotice = true;
      continue;
    }
    const text = sliceToolResultTextToBudget(item.text, remainingTextBudget);
    remainingTextBudget -= estimateToolResultTextChars(text);
    const shouldAppendNotice = remainingTextBudget <= 0 || text.length < item.text.length;
    if (shouldAppendNotice) {
      // The notice budget is reserved before slicing text, so the combined
      // result is already bounded without another boundary-sensitive cut.
      output.push({ type: "inputText", text: `${text.trimEnd()}${notice}` });
      appendedNotice = true;
    } else if (text.length > 0) {
      output.push({ type: "inputText", text });
    }
  }
  if (!appendedNotice) {
    output.push({ type: "inputText", text: sliceToolResultTextToBudget(noticeText, maxChars) });
  }
  return output;
}
function convertToolContent(
  content: TextContent | ImageContent,
): CodexDynamicToolCallOutputContentItem[] {
  if (content.type === "text") {
    return [{ type: "inputText", text: content.text }];
  }
  const imageUrl = sanitizeInlineImageDataUrl(`data:${content.mimeType};base64,${content.data}`);
  if (!imageUrl) {
    return [{ type: "inputText", text: invalidInlineImageText("codex dynamic tool") }];
  }
  return [
    {
      type: "inputImage",
      imageUrl,
    },
  ];
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
