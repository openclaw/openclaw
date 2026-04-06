/**
 * Copilot SDK agent runner — drop-in replacement for `runEmbeddedPiAgent`.
 *
 * Accepts the same `RunEmbeddedPiAgentParams` and returns the same
 * `EmbeddedPiRunResult` so callers don't need to change.
 *
 * Internally delegates to the Copilot SDK (CopilotClient → CopilotSession)
 * instead of running pi-agent-core / pi-coding-agent in-process.
 */
import type { CopilotSession, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { createOpenClawTools } from "../openclaw-tools.js";
import { resolveGlobalLane, resolveSessionLane } from "../pi-embedded-runner/lanes.js";
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

// ── Session cache (LRU-bounded) ────────────────────────────────────────────

const MAX_CACHED_SESSIONS = 64;

type CachedSession = { copilotSessionId: string; lastUsed: number };

const _sessionCache = new Map<string, CachedSession>();

function getCachedSessionId(key: string): string | undefined {
  const entry = _sessionCache.get(key);
  if (entry) {
    entry.lastUsed = Date.now();
    return entry.copilotSessionId;
  }
  return undefined;
}

function setCachedSessionId(key: string, sessionId: string): void {
  _sessionCache.set(key, { copilotSessionId: sessionId, lastUsed: Date.now() });
  if (_sessionCache.size > MAX_CACHED_SESSIONS) {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [k, v] of _sessionCache) {
      if (v.lastUsed < oldestTime) {
        oldestTime = v.lastUsed;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      _sessionCache.delete(oldestKey);
    }
  }
}

function removeCachedSession(key: string): void {
  _sessionCache.delete(key);
}

// ── Main entry point ───────────────────────────────────────────────────────

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

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a reusable session config from run params. */
function buildSessionConfig(params: {
  model: string;
  workspaceDir: string;
  extraSystemPrompt?: string;
  tools: SessionConfig["tools"];
}): Omit<SessionConfig, "onPermissionRequest"> {
  return {
    streaming: true,
    model: params.model,
    workingDirectory: params.workspaceDir,
    ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
    ...(params.extraSystemPrompt
      ? {
          systemMessage: {
            mode: "append" as const,
            content: params.extraSystemPrompt,
          },
        }
      : {}),
  };
}

/**
 * Wire event listeners to a CopilotSession and return a promise that
 * resolves on session.idle or rejects on error/abort.
 */
function bindSessionListeners(
  copilotSession: CopilotSession,
  acc: ReturnType<typeof createRunAccumulator>,
  callbacks: RunCallbacks,
  abortSignal?: AbortSignal,
): { idlePromise: Promise<void>; cleanup: () => void } {
  let abortCleanup: (() => void) | undefined;

  const idlePromise = new Promise<void>((resolve, reject) => {
    const abortHandler = () => {
      acc.aborted = true;
      copilotSession.abort().catch(() => {});
      const err = new Error("Operation aborted");
      err.name = "AbortError";
      reject(err);
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        abortHandler();
        return;
      }
      abortSignal.addEventListener("abort", abortHandler, { once: true });
      abortCleanup = () => abortSignal.removeEventListener("abort", abortHandler);
    }

    copilotSession.on(async (event: SessionEvent) => {
      try {
        await handleSessionEvent(event, acc, callbacks);
      } catch {
        // Callback errors should not kill the session listener.
      }

      if (event.type === "session.idle") {
        abortCleanup?.();
        resolve();
      }
      if (event.type === "session.error") {
        abortCleanup?.();
        const data = event.data as Record<string, unknown>;
        const message = typeof data?.message === "string" ? data.message : "Copilot session error";
        reject(new Error(message));
      }
    });
  });

  return {
    idlePromise,
    cleanup: () => abortCleanup?.(),
  };
}

/** Wait for idle with optional timeout. On timeout, abort gracefully. */
async function waitWithTimeout(
  idlePromise: Promise<void>,
  timeoutMs: number,
  session: CopilotSession,
  acc: ReturnType<typeof createRunAccumulator>,
): Promise<void> {
  if (timeoutMs <= 0) {
    await idlePromise;
    return;
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    acc.timedOut = true;
    session.abort().catch(() => {});
  }, timeoutMs);

  try {
    await idlePromise;
  } catch (err) {
    // Timeout-triggered abort is not a fatal error — return partial results.
    if (timedOut) {
      return;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Inner implementation ───────────────────────────────────────────────────

async function runCopilotAgentInner(
  params: RunEmbeddedPiAgentParams,
): Promise<EmbeddedPiRunResult> {
  const started = Date.now();
  const model = params.model ?? "gpt-5.4";
  const provider = "copilot";
  const cacheKey = params.sessionKey ?? params.sessionId;

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

  const sessionCfg = buildSessionConfig({
    model,
    workspaceDir: params.workspaceDir,
    extraSystemPrompt: params.extraSystemPrompt,
    tools: sdkTools,
  });

  // ── Obtain session (create or resume, with expiry recovery) ──

  const obtainSession = async (): Promise<CopilotSession> => {
    const cachedSessionId = getCachedSessionId(cacheKey);
    try {
      if (cachedSessionId) {
        return await resumeCopilotSession({
          sessionId: cachedSessionId,
          model,
          streaming: true,
        });
      }
      const s = await createCopilotSession(sessionCfg);
      setCachedSessionId(cacheKey, s.sessionId);
      return s;
    } catch (err) {
      if (cachedSessionId && isSessionExpired(err)) {
        removeCachedSession(cacheKey);
        const s = await createCopilotSession(sessionCfg);
        setCachedSessionId(cacheKey, s.sessionId);
        return s;
      }
      throw err;
    }
  };

  let session = await obtainSession();

  // ── Accumulator + listeners ──

  const acc = createRunAccumulator({
    sessionId: session.sessionId,
    model,
    provider,
  });

  let { idlePromise, cleanup } = bindSessionListeners(session, acc, callbacks, params.abortSignal);

  // ── Send prompt (with mid-send reconnect) ──

  try {
    await session.send({ prompt: params.prompt });
  } catch (err) {
    if (isSessionExpired(err)) {
      cleanup();
      removeCachedSession(cacheKey);
      session = await createCopilotSession(sessionCfg);
      setCachedSessionId(cacheKey, session.sessionId);
      acc.sessionId = session.sessionId;

      // Rebind listeners to the fresh session.
      const fresh = bindSessionListeners(session, acc, callbacks, params.abortSignal);
      idlePromise = fresh.idlePromise;
      cleanup = fresh.cleanup;

      await session.send({ prompt: params.prompt });
    } else {
      throw err;
    }
  }

  // ── Wait for completion ──

  await waitWithTimeout(idlePromise, params.timeoutMs, session, acc);
  cleanup();

  return buildRunResult(acc, Date.now() - started);
}
