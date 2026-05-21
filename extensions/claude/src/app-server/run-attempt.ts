/**
 * Drives a single Claude turn through @openclaw/claude-app-server.
 *
 * Lifecycle:
 *   1. Get/spawn the shared client (cheap; reused across turns).
 *   2. Build OpenClaw's full tool registry via createOpenClawCodingTools.
 *   3. Project tools into DynamicToolSpec[] and wire the server→client
 *      item/tool/call handler so Claude can call them.
 *   4. Look up or create the codex-shaped thread binding for params.sessionFile.
 *   5. Send turn/start with the dynamicTools, prompt, and configured options.
 *   6. Stream notifications, materialize them into EmbeddedRunAttemptResult
 *      fields, return when turn/completed arrives (or on abort/idle).
 *
 * Codex parity scope: minimum viable. We don't yet wire compact, side-question,
 * native-hook-relay, messaging-tool telemetry tracking, computer-use, or
 * plugin-thread-config — those layer on later.
 */

import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import {
  buildEmbeddedAttemptToolRunContext,
  embeddedAgentLog,
  resolveAgentDir,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { getSharedClaudeAppServerClient, type ClaudeAppServerClient } from "./client.js";
import { createClaudeDynamicToolBridge, type ClaudeDynamicToolBridge } from "./dynamic-tools.js";
import {
  readClaudeAppServerBinding,
  writeClaudeAppServerBinding,
  type ClaudeAppServerBinding,
} from "./thread-store.js";
import type {
  ApprovalPolicy,
  DynamicToolCallParams,
  JsonValue,
  SandboxPolicy,
  ThreadStartParams,
  ThreadStartResponse,
  Turn,
  TurnStartParams,
  UserInput,
} from "./types.js";

const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = "never";
const DEFAULT_SANDBOX: SandboxPolicy = { type: "dangerFullAccess" };
const DEFAULT_TURN_TIMEOUT_MS = 600_000;
const DEFAULT_TURN_IDLE_TIMEOUT_MS = 90_000;
const THREAD_NOT_FOUND_RE = /thread not found/i;

type AppServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxPolicy;
  turnTimeoutMs: number;
  turnIdleTimeoutMs: number;
};

type DynamicToolsConfig = {
  excludeNames: string[];
};

type ResolvedConfig = {
  appServer: AppServerConfig;
  dynamicTools: DynamicToolsConfig;
};

export type RunClaudeAppServerAttemptOptions = {
  pluginConfig?: unknown;
};

export async function runClaudeAppServerAttempt(
  params: EmbeddedRunAttemptParams,
  options: RunClaudeAppServerAttemptOptions,
): Promise<EmbeddedRunAttemptResult> {
  const result = emptyResult(params);
  const cfg = resolveConfig(options.pluginConfig);
  const client = getSharedClaudeAppServerClient({
    command: cfg.appServer.command,
    args: cfg.appServer.args,
    env: cfg.appServer.env,
  });
  await client.start();

  const ac = new AbortController();
  const onExternalAbort = () => ac.abort();
  params.abortSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const turnDeadline = setTimeout(() => ac.abort(), cfg.appServer.turnTimeoutMs);
  turnDeadline.unref?.();

  let unregisterServerRequest: (() => void) | undefined;

  try {
    // 1. Materialize OpenClaw's tool registry for this turn.
    const tools = await buildTools(params);

    // 2. Project to DynamicToolSpec[] + register the server→client tool-call bridge.
    const bridge = createClaudeDynamicToolBridge({
      tools,
      signal: ac.signal,
      excludeNames: cfg.dynamicTools.excludeNames,
    });
    unregisterServerRequest = registerToolCallHandler(client, bridge);

    // 3. Ensure thread binding for this session.
    const threadId = await ensureThread(client, params, cfg, bridge);

    // 4. Run the turn. This is where the actual SDK invocation happens
    //    server-side and we collect the streaming notifications.
    const accumulated = await runTurn(client, params, threadId, cfg, ac);

    // 5. Populate result.
    result.assistantTexts = accumulated.assistantTexts;
    result.toolMetas = accumulated.toolMetas;
    // accumulated.reasoning is collected for diagnostics but not surfaced
    // via replayMetadata (codex's EmbeddedRunReplayMetadata is strictly typed).
    result.itemLifecycle = {
      startedCount: accumulated.itemCount,
      completedCount: accumulated.itemCount,
      activeCount: 0,
    };
    const hasText = result.assistantTexts.length > 0;
    const hasTools = result.toolMetas.length > 0;
    const hasReasoning = Boolean(accumulated.reasoning);
    if (!hasText && hasTools) {
      result.agentHarnessResultClassification = "planning-only";
    } else if (!hasText && hasReasoning) {
      result.agentHarnessResultClassification = "reasoning-only";
    } else if (!hasText && !hasTools && !hasReasoning) {
      result.agentHarnessResultClassification = "empty";
    }
    return result;
  } catch (err) {
    const externalAbort = params.abortSignal?.aborted ?? false;
    const idle = err instanceof IdleTimeoutError;
    const aborted = ac.signal.aborted || idle;
    result.aborted = aborted;
    result.externalAbort = externalAbort;
    result.timedOut = aborted && !externalAbort;
    result.idleTimedOut = idle;
    result.promptError = err instanceof Error ? err : new Error(String(err));
    result.promptErrorSource = "prompt";
    embeddedAgentLog.warn("claude-app-server: runAttempt failed", {
      sessionId: params.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  } finally {
    clearTimeout(turnDeadline);
    params.abortSignal?.removeEventListener("abort", onExternalAbort);
    unregisterServerRequest?.();
  }
}

// ─── Tool materialization ───────────────────────────────────────────────────

async function buildTools(params: EmbeddedRunAttemptParams) {
  const agentDir =
    params.agentDir ?? resolveAgentDir(params.config ?? {}, params.agentId ?? "default");
  const tools = createOpenClawCodingTools({
    ...buildEmbeddedAttemptToolRunContext(params),
    agentDir,
    workspaceDir: params.workspaceDir,
    sessionId: params.sessionId,
    runId: params.runId,
    config: params.config,
    authProfileStore: params.toolAuthProfileStore ?? params.authProfileStore,
    abortSignal: params.abortSignal,
    modelProvider: params.model.provider,
    modelId: params.modelId,
    modelApi: params.model.api,
    modelContextWindowTokens: params.model.contextWindow,
    modelHasVision: params.model.input?.includes("image") ?? false,
    currentChannelId: params.currentChannelId,
    senderId: params.senderId ?? undefined,
    senderName: params.senderName ?? undefined,
    senderUsername: params.senderUsername ?? undefined,
    senderE164: params.senderE164 ?? undefined,
    senderIsOwner: params.senderIsOwner,
    messageProvider: params.messageChannel ?? params.messageProvider,
    messageTo: params.messageTo,
    messageThreadId: params.messageThreadId,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
  });
  return tools;
}

// ─── Server-request handler registration ────────────────────────────────────

function registerToolCallHandler(
  client: ClaudeAppServerClient,
  bridge: ClaudeDynamicToolBridge,
): () => void {
  return client.onServerRequest(async (req) => {
    if (req.method !== "item/tool/call") return undefined;
    const call = req.params as DynamicToolCallParams | undefined;
    if (!call || typeof call.tool !== "string") return undefined;
    const response = await bridge.handleToolCall(call);
    return response as unknown as JsonValue;
  });
}

// ─── Thread continuity ──────────────────────────────────────────────────────

async function ensureThread(
  client: ClaudeAppServerClient,
  params: EmbeddedRunAttemptParams,
  cfg: ResolvedConfig,
  bridge: ClaudeDynamicToolBridge,
): Promise<string> {
  const sessionFile = params.sessionFile;
  const existing = sessionFile ? await readClaudeAppServerBinding(sessionFile) : null;
  if (existing && existing.approvalPolicy === cfg.appServer.approvalPolicy) {
    try {
      await client.request("thread/resume", { threadId: existing.threadId });
      return existing.threadId;
    } catch (err) {
      if (!isThreadNotFound(err)) throw err;
      embeddedAgentLog.warn("claude-app-server: thread not found on resume; starting fresh", {
        sessionFile,
        threadId: existing.threadId,
      });
    }
  } else if (existing) {
    embeddedAgentLog.info("claude-app-server: approvalPolicy changed; starting fresh thread", {
      sessionFile,
      previous: existing.approvalPolicy,
      next: cfg.appServer.approvalPolicy,
    });
  }

  const startParams: ThreadStartParams = {
    cwd: params.workspaceDir ?? process.cwd(),
    model: params.modelId,
    modelProvider: "anthropic",
    approvalPolicy: cfg.appServer.approvalPolicy,
    approvalsReviewer: "user",
    sandbox: cfg.appServer.sandbox,
    dynamicTools: bridge.specs,
  };
  const response = await client.request<ThreadStartResponse>("thread/start", startParams);
  const threadId = response.thread?.id;
  if (typeof threadId !== "string" || !threadId) {
    throw new Error(`thread/start returned invalid thread.id: ${JSON.stringify(threadId)}`);
  }
  if (sessionFile) {
    const binding: Omit<ClaudeAppServerBinding, "schemaVersion" | "createdAt" | "updatedAt"> = {
      threadId,
      cwd: startParams.cwd!,
      model: params.modelId,
      modelProvider: "anthropic",
      approvalPolicy: cfg.appServer.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: cfg.appServer.sandbox,
    };
    await writeClaudeAppServerBinding(sessionFile, binding);
  }
  return threadId;
}

function isThreadNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { message?: unknown; data?: unknown };
  if (typeof e.message === "string" && THREAD_NOT_FOUND_RE.test(e.message)) return true;
  if (e.data && typeof e.data === "object" && !Array.isArray(e.data)) {
    const m = (e.data as { message?: unknown }).message;
    if (typeof m === "string" && THREAD_NOT_FOUND_RE.test(m)) return true;
  }
  return false;
}

// ─── Turn execution ─────────────────────────────────────────────────────────

class IdleTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdleTimeoutError";
  }
}

type Accumulator = {
  assistantTexts: string[];
  toolMetas: Array<{ toolName: string; meta?: string }>;
  reasoning: string;
  itemCount: number;
};

async function runTurn(
  client: ClaudeAppServerClient,
  params: EmbeddedRunAttemptParams,
  threadId: string,
  cfg: ResolvedConfig,
  ac: AbortController,
): Promise<Accumulator> {
  const turnParams: TurnStartParams = {
    threadId,
    input: buildInput(params),
    cwd: params.workspaceDir,
    model: params.modelId,
  };
  const startResp = await client.request<{ turn: Turn }>("turn/start", turnParams, ac.signal);
  const turnId = startResp.turn.id;
  const acc: Accumulator = { assistantTexts: [], toolMetas: [], reasoning: "", itemCount: 0 };
  const textParts: string[] = [];
  const reasoningParts: string[] = [];

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => {};
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      ac.signal.removeEventListener("abort", onAbort);
      unsubscribe();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      client.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      reject(new Error("Turn aborted"));
    };
    ac.signal.addEventListener("abort", onAbort, { once: true });

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        client.request("turn/interrupt", { threadId, turnId }).catch(() => {});
        reject(new IdleTimeoutError(`Claude turn idle for ${cfg.appServer.turnIdleTimeoutMs}ms`));
      }, cfg.appServer.turnIdleTimeoutMs);
      idleTimer.unref?.();
    };

    unsubscribe = client.onNotification((notif) => {
      const p = notif.params as Record<string, unknown> | undefined;
      if (!p) return;
      const ntid = typeof p.turnId === "string" ? p.turnId : undefined;
      const turnObj = p.turn as { id?: string } | undefined;
      const matches =
        (ntid && ntid === turnId) ||
        (turnObj && typeof turnObj.id === "string" && turnObj.id === turnId);
      if (!matches) return;
      resetIdleTimer();

      switch (notif.method) {
        case "item/started":
        case "item/completed": {
          const item = p.item as Record<string, unknown> | undefined;
          if (!item) return;
          if (notif.method === "item/completed") acc.itemCount += 1;
          if (notif.method === "item/started") {
            if (item.type === "dynamicToolCall" || item.type === "toolCall") {
              const toolName =
                typeof item.name === "string"
                  ? item.name
                  : typeof item.tool === "string"
                    ? item.tool
                    : "unknown";
              acc.toolMetas.push({ toolName });
            }
          }
          break;
        }
        case "item/agentMessage/delta": {
          if (typeof p.delta === "string") textParts.push(p.delta);
          break;
        }
        case "item/reasoning/delta": {
          if (typeof p.delta === "string") reasoningParts.push(p.delta);
          break;
        }
        case "turn/error": {
          if (settled) return;
          settled = true;
          cleanup();
          const err = p.error as { message?: string } | undefined;
          reject(new Error(`Claude turn error: ${err?.message ?? "turn/error"}`));
          break;
        }
        case "turn/completed": {
          if (settled) return;
          settled = true;
          cleanup();
          const turn = p.turn as Turn | undefined;
          if (turn?.status === "failed") {
            reject(new Error(`Claude turn failed: ${turn.error?.message ?? "unknown"}`));
          } else {
            // Pick up any item text we didn't see via deltas.
            if (turn?.items) {
              for (const item of turn.items) {
                if (
                  item.type === "agentMessage" &&
                  textParts.length === 0 &&
                  typeof item.text === "string"
                ) {
                  textParts.push(item.text);
                }
              }
            }
            resolve();
          }
          break;
        }
      }
    });
    resetIdleTimer();
  });

  if (textParts.length > 0) acc.assistantTexts = [textParts.join("")];
  if (reasoningParts.length > 0) acc.reasoning = reasoningParts.join("");
  return acc;
}

function buildInput(params: EmbeddedRunAttemptParams): UserInput[] {
  const blocks: UserInput[] = [{ type: "text", text: params.prompt }];
  if (params.images && params.images.length > 0) {
    for (const img of params.images) {
      const url = `data:${img.mimeType};base64,${img.data}`;
      blocks.push({ type: "image", url });
    }
  }
  return blocks;
}

// ─── Config resolution ──────────────────────────────────────────────────────

function resolveConfig(raw: unknown): ResolvedConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  const appServer = (cfg.appServer ?? {}) as Record<string, unknown>;
  const dynamicTools = (cfg.dynamicTools ?? {}) as Record<string, unknown>;
  return {
    appServer: {
      command: typeof appServer.command === "string" ? appServer.command : undefined,
      args: Array.isArray(appServer.args) ? (appServer.args as string[]) : undefined,
      env:
        appServer.env && typeof appServer.env === "object" && !Array.isArray(appServer.env)
          ? (appServer.env as Record<string, string>)
          : undefined,
      approvalPolicy: normalizeApprovalPolicy(appServer.approvalPolicy),
      sandbox: normalizeSandbox(appServer.sandbox),
      turnTimeoutMs:
        typeof appServer.turnTimeoutMs === "number"
          ? appServer.turnTimeoutMs
          : DEFAULT_TURN_TIMEOUT_MS,
      turnIdleTimeoutMs:
        typeof appServer.turnIdleTimeoutMs === "number"
          ? appServer.turnIdleTimeoutMs
          : DEFAULT_TURN_IDLE_TIMEOUT_MS,
    },
    dynamicTools: {
      excludeNames: Array.isArray(dynamicTools.exclude)
        ? (dynamicTools.exclude as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
    },
  };
}

function normalizeApprovalPolicy(raw: unknown): ApprovalPolicy {
  if (raw === "never" || raw === "untrusted" || raw === "on-failure" || raw === "on-request")
    return raw;
  return DEFAULT_APPROVAL_POLICY;
}

function normalizeSandbox(raw: unknown): SandboxPolicy {
  if (typeof raw === "string") {
    // Codex-shaped sandbox strings — map to discriminated.
    if (raw === "read-only") return { type: "readOnly" };
    if (raw === "workspace-write") return { type: "workspaceWrite" };
    if (raw === "danger-full-access") return { type: "dangerFullAccess" };
  }
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    typeof (raw as { type?: unknown }).type === "string"
  ) {
    return raw as SandboxPolicy;
  }
  return DEFAULT_SANDBOX;
}

// ─── Result construction ────────────────────────────────────────────────────

function emptyResult(params: EmbeddedRunAttemptParams): EmbeddedRunAttemptResult {
  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    promptError: null,
    promptErrorSource: null,
    sessionIdUsed: params.sessionId,
    sessionFileUsed: params.sessionFile,
    assistantTexts: [],
    messagesSnapshot: [],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    agentHarnessId: "claude-app-server",
  };
}
