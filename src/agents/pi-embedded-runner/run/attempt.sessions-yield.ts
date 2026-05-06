import type { AgentMessage } from "../../agent-core-contract.js";
import { removeSessionManagerTailEntries } from "../../transcript/session-manager-tail.js";
import { log } from "../logger.js";

const SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE = "openclaw.sessions_yield_interrupt";
const SESSIONS_YIELD_CONTEXT_CUSTOM_TYPE = "openclaw.sessions_yield";
const SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS = process.env.OPENCLAW_TEST_FAST === "1" ? 250 : 2_000;

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
      .catch((err) => {
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
  }
}

// Return a synthetic aborted response so pi-agent-core unwinds without a real provider call.
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

// Queue a hidden steering message so pi-agent-core injects it before the next
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
    break;
  }
  if (strippedMessages.length !== activeSession.messages.length) {
    activeSession.agent.state.messages = strippedMessages;
  }

  removeSessionManagerTailEntries(
    activeSession.sessionManager,
    (entry) => {
      const message = entry.message as { role?: string; stopReason?: string } | undefined;
      return (
        (entry.type === "message" &&
          message?.role === "assistant" &&
          message.stopReason === "aborted") ||
        (entry.type === "custom_message" &&
          entry.customType === SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE)
      );
    },
    { minEntries: 1 },
  );
}
