// Claude Agent SDK runtime driver for OpenClaw.
//
// This replaces `runEmbeddedPiAgent()` when the active agent is
// configured with `agents.runtime.type === "claude-sdk"` (see the branch
// in `src/agents/command/attempt-execution.ts` and the unified dispatch
// in `src/agents/runtime-dispatch.ts`).
//
// CREDENTIALS: defaults to the user's Claude.ai Pro/Max subscription via
// their `claude login` session. To route through OpenClaw's auth-profile
// store (which may include API-key credentials — metered), set
// `agents.runtime.claudeSdk.credential: "profile"` in config. See
// `transport-middleware.ts`.
//
// SCOPE: Phase 2-extended. The adapter honors the RunEmbeddedPiAgentParams
// fields that have a reasonable mapping to SDK options (prompt, cwd,
// abort/timeout, model, extraSystemPrompt, toolsAllow, disableTools,
// thinkLevel → thinking tokens, core streaming callbacks). Fields that
// belong to pi-ai internals or OpenClaw-specific subsystems not yet
// bridged (streamParams, bootstrapContext variants, skillsSnapshot,
// clientTools, execOverrides, replyOperation, cleanupBundleMcpOnRunEnd,
// fastMode) are intentionally ignored; `warnIgnoredFields()` logs them
// when set to non-default values so users know rather than discovering
// silently.
//
// NATIVE TOOLS: OpenClaw's own tools (message, sessions.send, cron.add,
// plugin-contributed tools) ARE bridged into the SDK via a runtime
// TypeBox → Zod converter. See `native-tools-adapter.ts` and
// `typebox-to-zod.ts`. If the inventory build fails for any reason
// (policy resolution, plugin registry, etc.), this adapter falls back
// to built-in-only tools and logs the failure — the run still works for
// bash/read/edit/grep workflows instead of crashing the whole session.

import type { EmbeddedPiRunResult } from "../pi-embedded.js";
import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";
import type { AgentRuntimeClaudeSdkConfig } from "../../config/types.agents.js";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type {
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import {
  resolveSdkCredential,
  rotateOnAuthFailure,
} from "./transport-middleware.js";
import { openSessionMirror } from "./session-mirror.js";
import { ensureAuthProfileStore } from "../auth-profiles.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { buildOpenClawMcpServer } from "./native-tools-adapter.js";
import { createOpenClawCodingTools } from "../pi-tools.js";
import { buildSdkHooks } from "./hooks-adapter.js";
import { loadWorkspaceHookEntries } from "../../hooks/workspace.js";
import { importFileModule, resolveFunctionModuleExport } from "../../hooks/module-loader.js";
import type { HookEntry } from "../../hooks/types.js";

const log = createSubsystemLogger("agents/claude-sdk");

export type RunClaudeSdkAgentOptions = RunEmbeddedPiAgentParams;

/**
 * Pull the claude-sdk runtime config for the active agent, if present.
 */
function resolveClaudeSdkRuntimeConfig(
  params: RunEmbeddedPiAgentParams,
): AgentRuntimeClaudeSdkConfig | undefined {
  const list = params.config?.agents?.list;
  if (!Array.isArray(list)) {
    return undefined;
  }
  const agentEntry = list.find((entry) => entry.id === params.agentId);
  const runtime = agentEntry?.runtime;
  if (!runtime || runtime.type !== "claude-sdk") {
    return undefined;
  }
  return runtime.claudeSdk;
}

/**
 * Map OpenClaw's `thinkLevel` enum to an SDK `maxThinkingTokens` budget.
 * The numbers here mirror pi-ai's conventional budgets (see
 * `src/auto-reply/thinking.ts` for the original mapping). "off" disables
 * thinking entirely; "adaptive" leaves the SDK default in place.
 */
function mapThinkBudget(level: RunEmbeddedPiAgentParams["thinkLevel"]): number | undefined {
  switch (level) {
    case "off":
      return 0;
    case "minimal":
      return 1024;
    case "low":
      return 2048;
    case "medium":
      return 8192;
    case "high":
      return 16384;
    case "xhigh":
      return 32768;
    case "adaptive":
    case undefined:
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Warn on RunEmbeddedPiAgentParams fields that the claude-sdk adapter
 * does NOT currently honor, when set to a non-default value. Running the
 * check once per run prevents silent drops from looking like adapter
 * bugs later.
 */
/**
 * Build the SDK hooks record for this run from OpenClaw's workspace
 * hook entries. Returns `undefined` when there are no entries — so the
 * caller can skip setting `hooks` on the SDK options entirely.
 *
 * Handler invocation resolves the hook module lazily (per-call) and
 * calls its exported function with the SDK hook input + entry metadata.
 * Handlers that throw are swallowed with a warning so one flaky hook
 * can't kill the run. A stricter policy can land later.
 */
async function buildNativeSdkHooks(
  params: RunEmbeddedPiAgentParams,
): Promise<Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined> {
  let entries: HookEntry[];
  try {
    entries = loadWorkspaceHookEntries(params.workspaceDir, {
      config: params.config,
    });
  } catch (err) {
    log.warn(
      `[claude-sdk hooks] failed to load workspace hook entries for runId=${params.runId}: ` +
        (err as Error).message,
    );
    return undefined;
  }
  if (entries.length === 0) {
    return undefined;
  }
  const record = buildSdkHooks({
    entries,
    invoke: async ({ entry, input }): Promise<HookJSONOutput | undefined> => {
      try {
        const mod = await importFileModule({ modulePath: entry.hook.handlerPath });
        const handler = resolveFunctionModuleExport<(args: unknown) => unknown>({
          mod,
          exportName: entry.metadata?.export,
          fallbackExportNames: ["default"],
        });
        if (!handler) {
          log.warn(
            `[claude-sdk hooks] hook "${entry.hook.name}" has no invokable handler export`,
          );
          return { continue: true };
        }
        const result = await handler({
          event: input.hook_event_name,
          sdkInput: input,
          hook: entry.hook,
        });
        // If the handler returns a well-shaped HookJSONOutput, forward
        // it; otherwise default to continue.
        if (result && typeof result === "object" && "continue" in result) {
          return result as HookJSONOutput;
        }
        return { continue: true };
      } catch (err) {
        log.warn(
          `[claude-sdk hooks] hook "${entry.hook.name}" handler threw: ` +
            (err as Error).message,
        );
        return { continue: true };
      }
    },
    warn: (msg) => log.warn(msg),
  });
  return Object.keys(record).length > 0 ? record : undefined;
}

/**
 * Build OpenClaw's native tool inventory and wrap it as a
 * `McpServerConfig` record suitable for `options.mcpServers`. Returns
 * `undefined` when there are no tools to expose (e.g., disableTools).
 *
 * Errors are caught by the caller; this function is allowed to throw
 * if the inventory build fails.
 */
async function buildNativeMcpServers(
  params: RunEmbeddedPiAgentParams,
): Promise<Record<string, McpServerConfig> | undefined> {
  if (params.disableTools) {
    return undefined;
  }
  const tools = createOpenClawCodingTools({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runId: params.runId,
    trigger: params.trigger,
    memoryFlushWritePath: params.memoryFlushWritePath,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    config: params.config,
    abortSignal: params.abortSignal,
    messageProvider: params.messageProvider,
    agentAccountId: params.agentAccountId,
    messageTo: params.messageTo,
    messageThreadId: params.messageThreadId,
    currentChannelId: params.currentChannelId,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    spawnedBy: params.spawnedBy,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    senderIsOwner: params.senderIsOwner,
    replyToMode: params.replyToMode,
    hasRepliedRef: params.hasRepliedRef,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
    requireExplicitMessageTarget: params.requireExplicitMessageTarget,
    disableMessageTool: params.disableMessageTool,
  });
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }
  const { config, name } = await buildOpenClawMcpServer({
    tools,
    runId: params.runId,
  });
  return { [name]: config };
}

function warnIgnoredFields(params: RunEmbeddedPiAgentParams): void {
  const ignored: string[] = [];
  if (params.streamParams) {
    ignored.push("streamParams");
  }
  if (params.skillsSnapshot) {
    ignored.push("skillsSnapshot");
  }
  if (params.clientTools && params.clientTools.length > 0) {
    ignored.push("clientTools");
  }
  if (params.execOverrides) {
    ignored.push("execOverrides");
  }
  if (params.bashElevated) {
    ignored.push("bashElevated");
  }
  if (params.bootstrapContextMode) {
    ignored.push("bootstrapContextMode");
  }
  if (params.replyOperation) {
    ignored.push("replyOperation");
  }
  if (params.cleanupBundleMcpOnRunEnd) {
    ignored.push("cleanupBundleMcpOnRunEnd");
  }
  if (params.fastMode) {
    ignored.push("fastMode");
  }
  if (params.blockReplyChunking) {
    ignored.push("blockReplyChunking");
  }
  // memoryFlushWritePath is passed through to createOpenClawCodingTools() by
  // buildNativeMcpServers, so tools that consume it DO receive it. Only the
  // post-run memory-flush semantics (handled by the calling layer, not this
  // adapter) are unsupported — warning there would be confusing, so we don't.
  if (params.inputProvenance) {
    ignored.push("inputProvenance");
  }
  if (params.internalEvents && params.internalEvents.length > 0) {
    ignored.push("internalEvents");
  }
  if (ignored.length > 0) {
    log.warn(
      `[claude-sdk] run with agentId=${params.agentId ?? "<none>"} runId=${params.runId} ` +
        `ignored ${ignored.length} param field(s) not yet supported by the SDK adapter: ` +
        ignored.join(", "),
    );
  }
}

/**
 * Drive the Claude Agent SDK for a single run.
 */
export async function runClaudeSdkAgent(
  params: RunClaudeSdkAgentOptions,
): Promise<EmbeddedPiRunResult> {
  const startedAt = Date.now();

  warnIgnoredFields(params);

  // Dynamic import so the SDK is not pulled into callers that stay on
  // the legacy runtime (AGENTS.md dynamic-import guardrail).
  const sdk = await import("@anthropic-ai/claude-agent-sdk");

  const runtimeConfig = resolveClaudeSdkRuntimeConfig(params);
  const store = ensureAuthProfileStore(params.agentDir);

  const credential = await resolveSdkCredential({
    cfg: params.config,
    store,
    runtimeConfig,
    pinnedProfileId: params.authProfileId,
    agentDir: params.agentDir,
  });

  // Merge process env with the credential env (credential vars win).
  const mergedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") {
      mergedEnv[k] = v;
    }
  }
  for (const [k, v] of Object.entries(credential.env)) {
    mergedEnv[k] = v;
  }

  // Compose an abort controller that fires on either the upstream abort
  // signal OR the timeout, so `timeoutMs` stops being silently ignored.
  // The listener is named so it can be removed in the cleanup block —
  // otherwise a session-scoped upstream signal keeps a closure reference
  // to this abortController for its whole lifetime.
  const abortController = new AbortController();
  const upstream = params.abortSignal;
  const onUpstreamAbort = upstream
    ? () => abortController.abort(upstream.reason)
    : undefined;
  if (upstream?.aborted) {
    abortController.abort(upstream.reason);
  } else if (upstream && onUpstreamAbort) {
    upstream.addEventListener("abort", onUpstreamAbort);
  }
  let timeoutHandle: NodeJS.Timeout | undefined;
  if (params.timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      abortController.abort(new Error(`claude-sdk run exceeded timeoutMs=${params.timeoutMs}`));
    }, params.timeoutMs);
  }
  const mirror = openSessionMirror({
    primaryPath: params.sessionFile,
    sdkSessionId: params.sessionId,
  });

  const releaseResources = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
    if (upstream && onUpstreamAbort) {
      upstream.removeEventListener("abort", onUpstreamAbort);
    }
    mirror.close();
  };

  // Emit an AssistantMessageStart event on the first assistant SDK message,
  // then honor onAgentEvent / onPartialReply for subsequent chunks.
  let assistantStartEmitted = false;
  const collectedText: string[] = [];
  let stopReason = "completed";
  let aborted = false;

  const effectiveModel = runtimeConfig?.model ?? params.model ?? "";
  const thinkBudget = mapThinkBudget(params.thinkLevel);
  const maxTurns = runtimeConfig?.maxTurns;

  // Extra system prompt: append, don't replace. SDK systemPrompt accepts
  // `{ type: "preset", preset: "claude_code", append: string }`.
  const systemPromptOption = params.extraSystemPrompt
    ? ({
        type: "preset" as const,
        preset: "claude_code" as const,
        append: params.extraSystemPrompt,
      })
    : undefined;

  // disableTools wins over toolsAllow (matches pi-embedded semantics).
  const toolsOption = params.disableTools
    ? ([] as string[])
    : (params.toolsAllow && params.toolsAllow.length > 0 ? params.toolsAllow : undefined);

  const onAgentEvent = params.onAgentEvent;
  const onPartialReply = params.onPartialReply;
  const onAssistantMessageStart = params.onAssistantMessageStart;

  // Build OpenClaw's native tool inventory and expose it to the SDK via
  // an in-process MCP server. Failure is survivable: if policy
  // resolution or tool assembly throws, we log and fall through to
  // built-in-only tools rather than crashing the run.
  const nativeMcpServers = await buildNativeMcpServers(params).catch((err) => {
    log.warn(
      `[claude-sdk] native tool inventory build failed for runId=${params.runId}: ` +
        `${(err as Error).message}; falling back to SDK built-in tools only`,
    );
    return undefined;
  });

  // Load OpenClaw's workspace hook entries and translate them into SDK
  // `hooks` matchers. Same survival policy as tools: a hook-loading
  // failure logs but doesn't kill the run.
  const sdkHooks = await buildNativeSdkHooks(params).catch((err) => {
    log.warn(
      `[claude-sdk] hook inventory build failed for runId=${params.runId}: ` +
        `${(err as Error).message}; hooks will not fire for this run`,
    );
    return undefined;
  });

  try {
    const query = sdk.query({
      prompt: params.prompt,
      options: {
        abortController,
        cwd: params.workspaceDir,
        env: mergedEnv,
        model: effectiveModel || undefined,
        maxTurns,
        systemPrompt: systemPromptOption,
        ...(toolsOption !== undefined ? { tools: toolsOption } : {}),
        ...(thinkBudget !== undefined ? { maxThinkingTokens: thinkBudget } : {}),
        ...(nativeMcpServers ? { mcpServers: nativeMcpServers } : {}),
        ...(sdkHooks ? { hooks: sdkHooks } : {}),
      },
    });

    for await (const message of query) {
      mirror.writeSdkMessage(message);
      const m = message as unknown as {
        type?: string;
        message?: { content?: unknown };
        stop_reason?: string;
      };

      if (m.type === "assistant" || m.type === "partial_assistant") {
        if (!assistantStartEmitted && onAssistantMessageStart) {
          assistantStartEmitted = true;
          try {
            await onAssistantMessageStart();
          } catch (cbErr) {
            log.warn(`onAssistantMessageStart threw: ${(cbErr as Error).message}`);
          }
        }
      }

      if (m.type === "assistant" && Array.isArray(m.message?.content)) {
        const chunkText: string[] = [];
        for (const rawBlock of m.message.content) {
          if (!rawBlock || typeof rawBlock !== "object") {
            continue;
          }
          const block = rawBlock as { type?: string; text?: string };
          if (block.type === "text" && typeof block.text === "string") {
            collectedText.push(block.text);
            chunkText.push(block.text);
          }
        }
        if (chunkText.length > 0 && onPartialReply) {
          try {
            await onPartialReply({ text: chunkText.join("\n") });
          } catch (cbErr) {
            log.warn(`onPartialReply threw: ${(cbErr as Error).message}`);
          }
        }
      }

      if (m.type === "result" && typeof m.stop_reason === "string") {
        stopReason = m.stop_reason;
      }

      if (onAgentEvent && typeof m.type === "string") {
        // Surface the raw SDK message type as an agent event. Downstream
        // consumers (CLI progress, gateway event stream) can filter by
        // `stream` name if they need to; the rich data is in the JSONL
        // mirror so we keep the event payload minimal.
        try {
          onAgentEvent({
            stream: `claude-sdk:${m.type}`,
            data: { runId: params.runId, agentId: params.agentId ?? null },
          });
        } catch (cbErr) {
          log.warn(`onAgentEvent threw: ${(cbErr as Error).message}`);
        }
      }
    }
  } catch (err) {
    aborted = abortController.signal.aborted;
    // Wrap rotation bookkeeping in try/finally so a failure inside
    // `rotateOnAuthFailure` (e.g., auth-store lock contention) doesn't
    // leave `timeoutHandle` firing or the session-mirror write stream
    // open for the process lifetime.
    try {
      if (credential.profileId) {
        await rotateOnAuthFailure({
          store,
          profileId: credential.profileId,
          error: err,
          agentDir: params.agentDir,
          runId: params.runId,
        });
      }
    } finally {
      releaseResources();
    }
    throw err;
  }

  releaseResources();

  const finalText = collectedText.join("\n").trim();
  const result: EmbeddedPiRunResult = {
    payloads: finalText ? [{ text: finalText }] : undefined,
    meta: {
      durationMs: Date.now() - startedAt,
      aborted: aborted || undefined,
      stopReason,
      finalAssistantVisibleText: finalText || undefined,
      agentMeta: {
        sessionId: params.sessionId,
        provider: "anthropic",
        model: effectiveModel,
      },
    },
  };
  return result;
}
