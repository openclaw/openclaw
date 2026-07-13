import { isTranscriptOnlyOpenClawAssistantMessage } from "../../../shared/transcript-only-openclaw-assistant.js";
import type { AgentMessage } from "../../runtime/index.js";
/**
 * Handles sessions-yield interruption, persistence, and artifact cleanup.
 */
import { isRunnerAbortError } from "../abort.js";
import { log } from "../logger.js";
import { resolveEmbeddedAbortSettleTimeoutMs } from "./attempt.abort-settle-timeout.js";

const SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE = "openclaw.sessions_yield_interrupt";
const SESSIONS_YIELD_CONTEXT_CUSTOM_TYPE = "openclaw.sessions_yield";

const SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS = resolveEmbeddedAbortSettleTimeoutMs();
// Hard cap for the post-timeout settle wait. After the soft timeout we keep
// waiting for the session file lock to release so the next turn does not hit a
// stale lock, but must never block the next turn forever if the settle itself
// stalls (e.g. a hung fs operation). Derived from the soft timeout so the
// test-fast override applies to both.
const SESSIONS_YIELD_ABORT_SETTLE_HARD_TIMEOUT_MS = SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS * 5;

// Persist a hidden context reminder so the next turn knows why the runner stopped.
function buildSessionsYieldContextMessage(message: string): string {
  return `${message}\n\n[Context: The previous turn ended intentionally via sessions_yield while waiting for a follow-up event.]`;
}

export async function waitForSessionsYieldAbortSettle(params: {
  settlePromise: Promise<void> | null;
  runId: string;
  sessionId: string;
}): Promise<void> {
  if (!params.settlePromise) {
    return;
  }

  let timeout: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    params.settlePromise
      .then(() => "settled" as const)
      .catch((err: unknown) => {
        log.warn(
          `sessions_yield abort settle failed: runId=${params.runId} sessionId=${params.sessionId} err=${String(err)}`,
        );
        return "errored" as const;
      }),
    new Promise<"timed_out">((resolve) => {
      timeout = setTimeout(() => resolve("timed_out"), SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS);
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  if (outcome === "timed_out") {
    log.warn(
      `sessions_yield abort settle timed out: runId=${params.runId} sessionId=${params.sessionId} timeoutMs=${SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS}`,
    );
    // Continue waiting (bounded) for the settle to complete so the session file
    // lock is released before the next turn starts. Without this the lock stays
    // held and the next turn fails with "file lock stale", causing model
    // fallback and visible error messages in the delivery channel.
    let hardTimeout: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      params.settlePromise.then(() => true).catch(() => true),
      new Promise<boolean>((resolve) => {
        hardTimeout = setTimeout(() => resolve(false), SESSIONS_YIELD_ABORT_SETTLE_HARD_TIMEOUT_MS);
      }),
    ]);
    if (hardTimeout) {
      clearTimeout(hardTimeout);
    }
    if (!settled) {
      log.warn(
        `sessions_yield abort settle hard-timeout: runId=${params.runId} sessionId=${params.sessionId} hardTimeoutMs=${SESSIONS_YIELD_ABORT_SETTLE_HARD_TIMEOUT_MS} — proceeding without confirmed lock release`,
      );
    }
  }
}

// Return a synthetic aborted response so agent runtime unwinds without a real provider call.
export function createYieldAbortedResponse(model: {
  api?: string;
  provider?: string;
  id?: string;
}): {
  [Symbol.asyncIterator]: () => AsyncGenerator<never, void, unknown>;
  result: () => Promise<{
    role: "assistant";
    content: Array<{ type: "text"; text: string }>;
    stopReason: "aborted";
    api: string;
    provider: string;
    model: string;
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
    };
    timestamp: number;
  }>;
} {
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "" }],
    stopReason: "aborted" as const,
    api: model.api ?? "",
    provider: model.provider ?? "",
    model: model.id ?? "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    timestamp: Date.now(),
  };
  return {
    async *[Symbol.asyncIterator]() {},
    result: async () => message,
  };
}

// sessions_yield ends the turn as a clean handoff, not an interruption.
// turnHandoff:true tells agent-core to skip <turn_aborted> guidance
// (packages/agent-core/src/turn-interruption.ts); code keys the runner's
// own yield checks in attempt.ts and attempt-stream.ts.
export const SESSIONS_YIELD_ABORT_REASON = { code: "sessions_yield", turnHandoff: true } as const;

/** True when a runner abort error was raised by the sessions_yield handoff. */
export function isSessionsYieldAbortError(err: unknown): boolean {
  return isRunnerAbortError(err) && err instanceof Error && isSessionsYieldAbortReason(err.cause);
}

export function isSessionsYieldAbortReason(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { code?: unknown }).code === "sessions_yield"
  );
}

// Queue a hidden steering message so agent runtime injects it before the next
// LLM call once the current assistant turn finishes executing its tool calls.
export function queueSessionsYieldInterruptMessage(activeSession: {
  agent: { steer: (message: AgentMessage) => void };
}) {
  activeSession.agent.steer({
    role: "custom",
    customType: SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE,
    content: "[sessions_yield interrupt]",
    display: false,
    details: { source: "sessions_yield" },
    timestamp: Date.now(),
  });
}

// Append the caller-provided yield payload as a hidden session message once the run is idle.
export async function persistSessionsYieldContextMessage(
  activeSession: {
    sendCustomMessage: (
      message: {
        customType: string;
        content: string;
        display: boolean;
        details?: Record<string, unknown>;
      },
      options?: { triggerTurn?: boolean },
    ) => Promise<void>;
  },
  message: string,
) {
  await activeSession.sendCustomMessage(
    {
      customType: SESSIONS_YIELD_CONTEXT_CUSTOM_TYPE,
      content: buildSessionsYieldContextMessage(message),
      display: false,
      details: { source: "sessions_yield", message },
    },
    { triggerTurn: false },
  );
}

// Remove the synthetic yield interrupt + aborted assistant entry from the live transcript.
export function stripSessionsYieldArtifacts(activeSession: {
  messages: AgentMessage[];
  agent: { state: { messages: AgentMessage[] } };
  sessionManager?: unknown;
}) {
  const strippedMessages = activeSession.messages.slice();
  while (strippedMessages.length > 0) {
    const last = strippedMessages.at(-1) as
      | AgentMessage
      | { role?: string; customType?: string; stopReason?: string };
    if (last?.role === "assistant" && "stopReason" in last && last.stopReason === "aborted") {
      strippedMessages.pop();
      continue;
    }
    if (
      last?.role === "custom" &&
      "customType" in last &&
      last.customType === SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE
    ) {
      strippedMessages.pop();
      continue;
    }
    // Also strip the sessions_yield context marker. When a new incoming message
    // aborts an active sessions_yield, this marker remains in the session. If a
    // subagent completion announce then re-runs the agent to deliver the result,
    // the agent sees the context message, responds via sessions_yield again, and
    // the announce system rejects it as "did not produce a visible reply".
    if (
      last?.role === "custom" &&
      "customType" in last &&
      last.customType === SESSIONS_YIELD_CONTEXT_CUSTOM_TYPE
    ) {
      strippedMessages.pop();
      continue;
    }
    break;
  }
  if (strippedMessages.length !== activeSession.messages.length) {
    activeSession.agent.state.messages = strippedMessages;
  }

  const sessionManager = activeSession.sessionManager as
    | {
        removeTrailingEntries?: (
          predicate: (entry: {
            type?: string;
            message?: {
              role?: string;
              stopReason?: string;
              provider?: string;
              model?: string;
            };
            customType?: string;
          }) => boolean,
          options?: {
            preserveTrailing?: (entry: {
              type?: string;
              message?: {
                role?: string;
                provider?: string;
                model?: string;
              };
            }) => boolean;
          },
        ) => number;
      }
    | undefined;
  if (typeof sessionManager?.removeTrailingEntries !== "function") {
    return;
  }

  sessionManager.removeTrailingEntries(
    (entry) => {
      const isYieldAbortAssistant =
        entry.type === "message" &&
        entry.message?.role === "assistant" &&
        entry.message?.stopReason === "aborted";
      const isYieldInterruptMessage =
        entry.type === "custom_message" &&
        entry.customType === SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE;
      const isYieldContextMessage =
        entry.type === "custom_message" && entry.customType === SESSIONS_YIELD_CONTEXT_CUSTOM_TYPE;
      return isYieldAbortAssistant || isYieldInterruptMessage || isYieldContextMessage;
    },
    {
      preserveTrailing: (entry) =>
        entry.type === "custom" ||
        entry.type === "label" ||
        entry.type === "session_info" ||
        (entry.type === "message" && isTranscriptOnlyOpenClawAssistantMessage(entry.message)),
    },
  );
}
