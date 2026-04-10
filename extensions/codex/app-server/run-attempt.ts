import fs from "node:fs/promises";
import {
  buildEmbeddedAttemptToolRunContext,
  clearActiveEmbeddedRun,
  createOpenClawCodingTools,
  embeddedAgentLog,
  isSubagentSessionKey,
  normalizeProviderToolSchemas,
  resolveAttemptSpawnWorkspaceDir,
  resolveModelAuthMode,
  resolveOpenClawAgentDir,
  resolveSandboxContext,
  resolveSessionAgentIds,
  resolveUserPath,
  setActiveEmbeddedRun,
  supportsModelTools,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness";
import { handleCodexAppServerApprovalRequest } from "./approval-bridge.js";
import {
  getSharedCodexAppServerClient,
  isCodexAppServerApprovalRequest,
  type CodexAppServerClient,
} from "./client.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import {
  isJsonObject,
  type CodexServerNotification,
  type CodexDynamicToolCallParams,
  type CodexThreadResumeResponse,
  type CodexThreadStartResponse,
  type CodexTurnStartResponse,
  type CodexUserInput,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import {
  clearCodexAppServerBinding,
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import { mirrorCodexAppServerTranscript } from "./transcript-mirror.js";

type CodexAppServerClientFactory = () => Promise<CodexAppServerClient>;

let clientFactory: CodexAppServerClientFactory = getSharedCodexAppServerClient;

export async function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  await fs.mkdir(resolvedWorkspace, { recursive: true });
  const sandboxSessionKey = params.sessionKey?.trim() || params.sessionId;
  const sandbox = await resolveSandboxContext({
    config: params.config,
    sessionKey: sandboxSessionKey,
    workspaceDir: resolvedWorkspace,
  });
  const effectiveWorkspace = sandbox?.enabled
    ? sandbox.workspaceAccess === "rw"
      ? resolvedWorkspace
      : sandbox.workspaceDir
    : resolvedWorkspace;
  await fs.mkdir(effectiveWorkspace, { recursive: true });

  const runAbortController = new AbortController();
  const abortFromUpstream = () => {
    runAbortController.abort(params.abortSignal?.reason ?? "upstream_abort");
  };
  if (params.abortSignal?.aborted) {
    abortFromUpstream();
  } else {
    params.abortSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  }

  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  let yieldDetected = false;
  const tools = await buildDynamicTools({
    params,
    resolvedWorkspace,
    effectiveWorkspace,
    sandboxSessionKey,
    sandbox,
    runAbortController,
    sessionAgentId,
    onYieldDetected: () => {
      yieldDetected = true;
    },
  });
  const toolBridge = createCodexDynamicToolBridge({
    tools,
    signal: runAbortController.signal,
  });
  const client = await clientFactory();
  const thread = await startOrResumeThread({
    client,
    params,
    cwd: effectiveWorkspace,
    dynamicTools: toolBridge.specs,
  });

  let projector: CodexAppServerEventProjector | undefined;
  let turnId: string | undefined;
  const pendingNotifications: CodexServerNotification[] = [];
  let completed = false;
  let timedOut = false;
  let resolveCompletion: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });

  const handleNotification = async (notification: CodexServerNotification) => {
    if (!projector || !turnId) {
      pendingNotifications.push(notification);
      return;
    }
    await projector.handleNotification(notification);
    if (
      notification.method === "turn/completed" &&
      isTurnNotification(notification.params, turnId)
    ) {
      completed = true;
      resolveCompletion?.();
    }
  };

  const notificationCleanup = client.addNotificationHandler(handleNotification);
  const requestCleanup = client.addRequestHandler(async (request) => {
    if (!turnId) {
      return undefined;
    }
    if (request.method !== "item/tool/call") {
      if (isCodexAppServerApprovalRequest(request.method)) {
        return handleApprovalRequest({
          method: request.method,
          params: request.params,
          paramsForRun: params,
          threadId: thread.threadId,
          turnId,
          signal: runAbortController.signal,
        });
      }
      return undefined;
    }
    const call = readDynamicToolCallParams(request.params);
    if (!call || call.threadId !== thread.threadId || call.turnId !== turnId) {
      return undefined;
    }
    return toolBridge.handleToolCall(call) as Promise<JsonValue>;
  });

  let turn: CodexTurnStartResponse;
  try {
    turn = await client.request<CodexTurnStartResponse>("turn/start", {
      threadId: thread.threadId,
      input: buildUserInput(params),
      cwd: effectiveWorkspace,
      approvalPolicy: resolveAppServerApprovalPolicy(),
      approvalsReviewer: resolveApprovalsReviewer(),
      model: params.modelId,
      effort: resolveReasoningEffort(params.thinkLevel),
    });
  } catch (error) {
    notificationCleanup();
    requestCleanup();
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    throw error;
  }
  turnId = turn.turn.id;
  projector = new CodexAppServerEventProjector(params, thread.threadId, turnId);
  for (const notification of pendingNotifications.splice(0)) {
    await handleNotification(notification);
  }
  const activeTurnId = turnId;
  const activeProjector = projector;

  const handle = {
    kind: "embedded" as const,
    queueMessage: async (text: string) => {
      await client.request("turn/steer", {
        threadId: thread.threadId,
        expectedTurnId: activeTurnId,
        input: [{ type: "text", text }],
      });
    },
    isStreaming: () => !completed,
    isCompacting: () => projector?.isCompacting() ?? false,
    cancel: () => runAbortController.abort("cancelled"),
    abort: () => runAbortController.abort("aborted"),
  };
  setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);

  const timeout = setTimeout(
    () => {
      timedOut = true;
      projector?.markTimedOut();
      runAbortController.abort("timeout");
    },
    Math.max(100, params.timeoutMs),
  );

  const abortListener = () => {
    void client.request("turn/interrupt", {
      threadId: thread.threadId,
      turnId: activeTurnId,
    });
    resolveCompletion?.();
  };
  runAbortController.signal.addEventListener("abort", abortListener, { once: true });
  if (runAbortController.signal.aborted) {
    abortListener();
  }

  try {
    await completion;
    const result = activeProjector.buildResult(toolBridge.telemetry, { yieldDetected });
    await mirrorTranscriptBestEffort({
      params,
      result,
      threadId: thread.threadId,
      turnId: activeTurnId,
    });
    return {
      ...result,
      timedOut,
      aborted: result.aborted || runAbortController.signal.aborted,
      promptError: timedOut ? "codex app-server attempt timed out" : result.promptError,
      promptErrorSource: timedOut ? "prompt" : result.promptErrorSource,
    };
  } finally {
    clearTimeout(timeout);
    notificationCleanup();
    requestCleanup();
    runAbortController.signal.removeEventListener("abort", abortListener);
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
  }
}

type DynamicToolBuildParams = {
  params: EmbeddedRunAttemptParams;
  resolvedWorkspace: string;
  effectiveWorkspace: string;
  sandboxSessionKey: string;
  sandbox: Awaited<ReturnType<typeof resolveSandboxContext>>;
  runAbortController: AbortController;
  sessionAgentId: string | undefined;
  onYieldDetected: () => void;
};

async function buildDynamicTools(input: DynamicToolBuildParams) {
  const { params } = input;
  if (params.disableTools || !supportsModelTools(params.model)) {
    return [];
  }
  const modelHasVision = params.model.input?.includes("image") ?? false;
  const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
  const allTools = createOpenClawCodingTools({
    agentId: input.sessionAgentId,
    ...buildEmbeddedAttemptToolRunContext(params),
    exec: {
      ...params.execOverrides,
      elevated: params.bashElevated,
    },
    sandbox: input.sandbox,
    messageProvider: params.messageChannel ?? params.messageProvider,
    agentAccountId: params.agentAccountId,
    messageTo: params.messageTo,
    messageThreadId: params.messageThreadId,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    spawnedBy: params.spawnedBy,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    senderIsOwner: params.senderIsOwner,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
    sessionKey: input.sandboxSessionKey,
    sessionId: params.sessionId,
    runId: params.runId,
    agentDir,
    workspaceDir: input.effectiveWorkspace,
    spawnWorkspaceDir: resolveAttemptSpawnWorkspaceDir({
      sandbox: input.sandbox,
      resolvedWorkspace: input.resolvedWorkspace,
    }),
    config: params.config,
    abortSignal: input.runAbortController.signal,
    modelProvider: params.model.provider,
    modelId: params.modelId,
    modelCompat: params.model.compat,
    modelApi: params.model.api,
    modelContextWindowTokens: params.model.contextWindow,
    modelAuthMode: resolveModelAuthMode(params.model.provider, params.config),
    currentChannelId: params.currentChannelId,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    replyToMode: params.replyToMode,
    hasRepliedRef: params.hasRepliedRef,
    modelHasVision,
    requireExplicitMessageTarget:
      params.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey),
    disableMessageTool: params.disableMessageTool,
    onYield: (message) => {
      input.onYieldDetected();
      params.onAgentEvent?.({
        stream: "codex_app_server.tool",
        data: { name: "sessions_yield", message },
      });
      input.runAbortController.abort("sessions_yield");
    },
  });
  const filteredTools =
    params.toolsAllow && params.toolsAllow.length > 0
      ? allTools.filter((tool) => params.toolsAllow?.includes(tool.name))
      : allTools;
  return normalizeProviderToolSchemas({
    tools: filteredTools,
    provider: params.provider,
    config: params.config,
    workspaceDir: input.effectiveWorkspace,
    env: process.env,
    modelId: params.modelId,
    modelApi: params.model.api,
    model: params.model,
  });
}

async function startOrResumeThread(params: {
  client: CodexAppServerClient;
  params: EmbeddedRunAttemptParams;
  cwd: string;
  dynamicTools: JsonValue[];
}): Promise<CodexAppServerThreadBinding> {
  const dynamicToolsFingerprint = fingerprintDynamicTools(params.dynamicTools);
  const binding = await readCodexAppServerBinding(params.params.sessionFile);
  if (binding?.threadId) {
    if (binding.dynamicToolsFingerprint !== dynamicToolsFingerprint) {
      embeddedAgentLog.debug(
        "codex app-server dynamic tool catalog changed; starting a new thread",
        {
          threadId: binding.threadId,
        },
      );
      await clearCodexAppServerBinding(params.params.sessionFile);
    } else {
      try {
        const response = await params.client.request<CodexThreadResumeResponse>("thread/resume", {
          threadId: binding.threadId,
        });
        await writeCodexAppServerBinding(params.params.sessionFile, {
          threadId: response.thread.id,
          cwd: params.cwd,
          model: params.params.modelId,
          modelProvider: response.modelProvider ?? normalizeModelProvider(params.params.provider),
          dynamicToolsFingerprint,
          createdAt: binding.createdAt,
        });
        return {
          ...binding,
          threadId: response.thread.id,
          cwd: params.cwd,
          model: params.params.modelId,
          modelProvider: response.modelProvider ?? normalizeModelProvider(params.params.provider),
          dynamicToolsFingerprint,
        };
      } catch (error) {
        embeddedAgentLog.warn("codex app-server thread resume failed; starting a new thread", {
          error,
        });
        await clearCodexAppServerBinding(params.params.sessionFile);
      }
    }
  }

  const response = await params.client.request<CodexThreadStartResponse>("thread/start", {
    model: params.params.modelId,
    modelProvider: normalizeModelProvider(params.params.provider),
    cwd: params.cwd,
    approvalPolicy: resolveAppServerApprovalPolicy(),
    approvalsReviewer: resolveApprovalsReviewer(),
    sandbox: resolveAppServerSandbox(),
    serviceName: "OpenClaw",
    developerInstructions: buildDeveloperInstructions(params.params),
    dynamicTools: params.dynamicTools,
    experimentalRawEvents: true,
    persistExtendedHistory: true,
  });
  const createdAt = new Date().toISOString();
  await writeCodexAppServerBinding(params.params.sessionFile, {
    threadId: response.thread.id,
    cwd: params.cwd,
    model: response.model ?? params.params.modelId,
    modelProvider: response.modelProvider ?? normalizeModelProvider(params.params.provider),
    dynamicToolsFingerprint,
    createdAt,
  });
  return {
    schemaVersion: 1,
    threadId: response.thread.id,
    sessionFile: params.params.sessionFile,
    cwd: params.cwd,
    model: response.model ?? params.params.modelId,
    modelProvider: response.modelProvider ?? normalizeModelProvider(params.params.provider),
    dynamicToolsFingerprint,
    createdAt,
    updatedAt: createdAt,
  };
}

function fingerprintDynamicTools(dynamicTools: JsonValue[]): string {
  return JSON.stringify(dynamicTools.map(stabilizeJsonValue));
}

function stabilizeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(stabilizeJsonValue);
  }
  if (!isJsonObject(value)) {
    return value;
  }
  const stable: JsonObject = {};
  for (const [key, child] of Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    stable[key] = stabilizeJsonValue(child);
  }
  return stable;
}

function buildDeveloperInstructions(params: EmbeddedRunAttemptParams): string {
  const sections = [
    "You are running inside OpenClaw. Use OpenClaw dynamic tools for messaging, cron, sessions, and host actions when available.",
    "Preserve the user's existing channel/session context. If sending a channel reply, use the OpenClaw messaging tool instead of describing that you would reply.",
    params.extraSystemPrompt,
    params.skillsSnapshot?.prompt,
  ];
  return sections.filter((section) => typeof section === "string" && section.trim()).join("\n\n");
}

function buildUserInput(params: EmbeddedRunAttemptParams): CodexUserInput[] {
  return [
    { type: "text", text: params.prompt },
    ...(params.images ?? []).map(
      (image): CodexUserInput => ({
        type: "image",
        url: `data:${image.mimeType};base64,${image.data}`,
      }),
    ),
  ];
}

function normalizeModelProvider(provider: string): string {
  return provider === "codex" || provider === "openai-codex" ? "openai" : provider;
}

function resolveAppServerApprovalPolicy(): "never" | "on-request" | "on-failure" | "untrusted" {
  const raw = process.env.OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY?.trim();
  if (raw === "on-request" || raw === "on-failure" || raw === "untrusted") {
    return raw;
  }
  return "never";
}

function resolveAppServerSandbox(): "read-only" | "workspace-write" | "danger-full-access" {
  const raw = process.env.OPENCLAW_CODEX_APP_SERVER_SANDBOX?.trim();
  if (raw === "read-only" || raw === "danger-full-access") {
    return raw;
  }
  return "workspace-write";
}

function resolveApprovalsReviewer(): "user" | "guardian_subagent" {
  return process.env.OPENCLAW_CODEX_APP_SERVER_GUARDIAN === "1" ? "guardian_subagent" : "user";
}

function resolveReasoningEffort(
  thinkLevel: EmbeddedRunAttemptParams["thinkLevel"],
): "minimal" | "low" | "medium" | "high" | "xhigh" | null {
  if (
    thinkLevel === "minimal" ||
    thinkLevel === "low" ||
    thinkLevel === "medium" ||
    thinkLevel === "high" ||
    thinkLevel === "xhigh"
  ) {
    return thinkLevel;
  }
  return null;
}

function readDynamicToolCallParams(
  value: JsonValue | undefined,
): CodexDynamicToolCallParams | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const threadId = readString(value, "threadId");
  const turnId = readString(value, "turnId");
  const callId = readString(value, "callId");
  const tool = readString(value, "tool");
  if (!threadId || !turnId || !callId || !tool) {
    return undefined;
  }
  return {
    threadId,
    turnId,
    callId,
    tool,
    arguments: value.arguments,
  };
}

function isTurnNotification(value: JsonValue | undefined, turnId: string): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  const directTurnId = readString(value, "turnId");
  if (directTurnId === turnId) {
    return true;
  }
  const turn = isJsonObject(value.turn) ? value.turn : undefined;
  return readString(turn ?? {}, "id") === turnId;
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

async function mirrorTranscriptBestEffort(params: {
  params: EmbeddedRunAttemptParams;
  result: EmbeddedRunAttemptResult;
  threadId: string;
  turnId: string;
}): Promise<void> {
  try {
    await mirrorCodexAppServerTranscript({
      sessionFile: params.params.sessionFile,
      sessionKey: params.params.sessionKey,
      messages: params.result.messagesSnapshot,
      idempotencyScope: `codex-app-server:${params.threadId}:${params.turnId}`,
    });
  } catch (error) {
    embeddedAgentLog.warn("failed to mirror codex app-server transcript", { error });
  }
}

function handleApprovalRequest(params: {
  method: string;
  params: JsonValue | undefined;
  paramsForRun: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  signal?: AbortSignal;
}): Promise<JsonValue | undefined> {
  return handleCodexAppServerApprovalRequest({
    method: params.method,
    requestParams: params.params,
    paramsForRun: params.paramsForRun,
    threadId: params.threadId,
    turnId: params.turnId,
    signal: params.signal,
  });
}

export const __testing = {
  setCodexAppServerClientFactoryForTests(factory: CodexAppServerClientFactory): void {
    clientFactory = factory;
  },
  resetCodexAppServerClientFactoryForTests(): void {
    clientFactory = getSharedCodexAppServerClient;
  },
} as const;
