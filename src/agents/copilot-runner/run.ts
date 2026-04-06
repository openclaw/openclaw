/**
 * Copilot SDK agent runner — drop-in replacement for `runEmbeddedPiAgent`.
 *
 * Accepts the same `RunEmbeddedPiAgentParams` and returns the same
 * `EmbeddedPiRunResult` so callers don't need to change.
 *
 * Internally delegates to the Copilot SDK (CopilotClient → CopilotSession)
 * instead of running pi-agent-core / pi-coding-agent in-process.
 */
import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { createOpenClawTools } from "../openclaw-tools.js";
import { resolveSessionLane, resolveGlobalLane } from "../pi-embedded-runner/lanes.js";
import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";
import type { EmbeddedPiRunResult } from "../pi-embedded-runner/types.js";
import { createCopilotSession, isSessionExpired, resumeCopilotSession } from "./client.js";
import {
  buildRunResult,
  createRunAccumulator,
  handleSessionEvent,
  type RunCallbacks,
} from "./events.js";
import { bridgeTools } from "./tool-bridge.js";

// ── Session cache ──────────────────────────────────────────────────────────

/** Map of sessionKey → Copilot sessionId for resumption across runs. */
const _sessionCache = new Map<string, string>();

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Run an agent turn using the Copilot SDK.
 *
 * Same signature as `runEmbeddedPiAgent` so it's a drop-in replacement.
 */
export async function runCopilotAgent(
  params: RunEmbeddedPiAgentParams,
): Promise<EmbeddedPiRunResult> {
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueSession =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(sessionLane, task, opts));
  const enqueueGlobal =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(globalLane, task, opts));

  const throwIfAborted = () => {
    if (!params.abortSignal?.aborted) {
      return;
    }
    const reason = params.abortSignal.reason;
    if (reason instanceof Error) {
      throw reason;
    }
    const err =
      reason !== undefined
        ? new Error("Operation aborted", { cause: reason })
        : new Error("Operation aborted");
    err.name = "AbortError";
    throw err;
  };

  throwIfAborted();

  return enqueueSession(() => {
    throwIfAborted();
    return enqueueGlobal(async () => {
      throwIfAborted();
      return runCopilotAgentInner(params);
    });
  });
}

// ── Inner implementation ───────────────────────────────────────────────────

async function runCopilotAgentInner(
  params: RunEmbeddedPiAgentParams,
): Promise<EmbeddedPiRunResult> {
  const started = Date.now();
  const model = params.model ?? "gpt-5.4";
  const provider = "copilot";
  const cacheKey = params.sessionKey ?? params.sessionId;

  // Wire up callbacks from params → RunCallbacks.
  const callbacks: RunCallbacks = {
    onPartialReply: params.onPartialReply,
    onAssistantMessageStart: params.onAssistantMessageStart,
    onBlockReply: params.onBlockReply,
    onBlockReplyFlush: params.onBlockReplyFlush,
    onReasoningStream: params.onReasoningStream,
    onReasoningEnd: params.onReasoningEnd,
    onToolResult: params.onToolResult
      ? (payload) => params.onToolResult!({ text: payload?.text })
      : undefined,
    onAgentEvent: params.onAgentEvent,
  };

  // ── Resolve OpenClaw custom tools ──

  const openclawTools = params.disableTools
    ? []
    : createOpenClawTools({
        agentSessionKey: params.sessionKey,
        agentAccountId: params.agentAccountId,
        agentTo: params.messageTo,
        agentThreadId: params.messageThreadId,
        config: params.config,
        workspaceDir: params.workspaceDir,
        currentChannelId: params.currentChannelId,
        currentThreadTs: params.currentThreadTs,
        currentMessageId: params.currentMessageId,
        replyToMode: params.replyToMode,
        hasRepliedRef: params.hasRepliedRef,
        requireExplicitMessageTarget: params.requireExplicitMessageTarget,
        disableMessageTool: params.disableMessageTool,
        senderIsOwner: params.senderIsOwner,
        disablePluginTools: false,
        sessionId: params.sessionId,
      });
  const sdkTools = bridgeTools(openclawTools);

  // ── Obtain or create a CopilotSession ──

  let session: CopilotSession;
  const cachedSessionId = _sessionCache.get(cacheKey);

  try {
    if (cachedSessionId) {
      session = await resumeCopilotSession({
        sessionId: cachedSessionId,
        model,
        streaming: true,
      });
    } else {
      session = await createCopilotSession({
        model,
        streaming: true,
        workingDirectory: params.workspaceDir,
        tools: sdkTools.length > 0 ? sdkTools : undefined,
        systemMessage: params.extraSystemPrompt
          ? {
              mode: "append" as const,
              content: params.extraSystemPrompt,
            }
          : undefined,
      });
      _sessionCache.set(cacheKey, session.sessionId);
    }
  } catch (err) {
    if (cachedSessionId && isSessionExpired(err)) {
      // Session evicted by CLI — create a fresh one.
      _sessionCache.delete(cacheKey);
      session = await createCopilotSession({
        model,
        streaming: true,
        workingDirectory: params.workspaceDir,
        tools: sdkTools.length > 0 ? sdkTools : undefined,
      });
      _sessionCache.set(cacheKey, session.sessionId);
    } else {
      throw err;
    }
  }

  // ── Set up event accumulator ──

  const acc = createRunAccumulator({
    sessionId: session.sessionId,
    model,
    provider,
  });

  // ── Listen to events ──

  const idlePromise = new Promise<void>((resolve, reject) => {
    const abortHandler = () => {
      session.abort().catch(() => {});
      reject(new Error("Operation aborted"));
    };

    if (params.abortSignal) {
      if (params.abortSignal.aborted) {
        abortHandler();
        return;
      }
      params.abortSignal.addEventListener("abort", abortHandler, { once: true });
    }

    session.on(async (event: SessionEvent) => {
      try {
        await handleSessionEvent(event, acc, callbacks);
      } catch {
        // Callback errors should not kill the session listener.
      }

      if (event.type === "session.idle") {
        params.abortSignal?.removeEventListener("abort", abortHandler);
        resolve();
      }
      if (event.type === "session.error") {
        params.abortSignal?.removeEventListener("abort", abortHandler);
        reject(
          new Error(
            typeof (event.data as Record<string, unknown>)?.message === "string"
              ? ((event.data as Record<string, unknown>).message as string)
              : "Copilot session error",
          ),
        );
      }
    });
  });

  // ── Send prompt ──

  const sendPromise = (async () => {
    try {
      await session.send({ prompt: params.prompt });
    } catch (err) {
      // If the session expired mid-send, try once more with a fresh session.
      if (isSessionExpired(err)) {
        _sessionCache.delete(cacheKey);
        const fresh = await createCopilotSession({
          model,
          streaming: true,
          workingDirectory: params.workspaceDir,
          tools: sdkTools.length > 0 ? sdkTools : undefined,
        });
        _sessionCache.set(cacheKey, fresh.sessionId);
        acc.sessionId = fresh.sessionId;
        await fresh.send({ prompt: params.prompt });
      } else {
        throw err;
      }
    }
  })();

  // ── Wait for completion ──

  // Apply timeout if configured.
  const timeout = params.timeoutMs;
  if (timeout > 0) {
    const timer = setTimeout(() => {
      session.abort().catch(() => {});
    }, timeout);

    try {
      await Promise.race([idlePromise, sendPromise.then(() => idlePromise)]);
    } finally {
      clearTimeout(timer);
    }
  } else {
    await Promise.all([sendPromise, idlePromise]);
  }

  return buildRunResult(acc, Date.now() - started);
}
