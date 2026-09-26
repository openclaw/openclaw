/** Persists CLI and ACP command fallbacks through the shared transcript owner. */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  persistSessionTranscriptTurn,
  type TranscriptMessageAppendResult,
} from "../../config/sessions/session-accessor.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { StopReason } from "../../llm/types.js";
import { normalizeInputProvenance, type InputProvenance } from "../../sessions/input-provenance.js";
import {
  buildPersistedUserTurnMessage,
  preparePersistedUserTurnMessageForTranscriptWrite,
  type PersistedUserTurnMessage,
  type UserTurnInput,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import {
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agent-run-terminal-outcome.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../harness/hook-helpers.js";
import { projectAgentHarnessTranscriptMessageForDisplay } from "../harness/transcript-visibility.js";
import { buildUsageWithNoCost } from "../stream-message-shared.js";
import type { ContextUsage } from "../usage.js";

type TranscriptUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  contextUsage?: ContextUsage;
};

type TextTurnTranscriptContext = {
  inputProvenance?: InputProvenance;
  body: string;
  transcriptBody?: string;
  sessionId: string;
  sessionKey: string;
  sessionFile?: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  sessionAgentId: string;
  threadId?: string | number;
  sessionCwd: string;
  config: OpenClawConfig;
};

type PersistTextTurnTranscriptParams = TextTurnTranscriptContext & {
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  userMessage?: PersistedUserTurnMessage;
  userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
  assistantIdempotencyKey?: string;
  expectedSessionId?: string;
  finalText: string;
  skipAssistantTurn?: boolean;
  assistant: {
    api: string;
    provider: string;
    model: string;
    stopReason: StopReason;
    usage?: TranscriptUsage;
  };
};

type PersistTextTurnTranscriptResult =
  | {
      kind: "persisted";
      sessionEntry: SessionEntry | undefined;
      assistantTranscript?: TranscriptMessageAppendResult<unknown>;
    }
  | { kind: "session-rebound"; sessionEntry: undefined };

const ACP_TRANSCRIPT_USAGE = buildUsageWithNoCost({});
const CLI_TRANSCRIPT_UNAVAILABLE_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  contextUsage: { state: "unavailable" },
} as const;

function resolveCliTranscriptUsage(usage: TranscriptUsage | undefined): TranscriptUsage {
  if (!usage) {
    return CLI_TRANSCRIPT_UNAVAILABLE_USAGE;
  }
  if (usage.contextUsage) {
    return usage;
  }
  const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return {
    ...usage,
    contextUsage:
      promptTokens > 0
        ? {
            state: "available",
            promptTokens,
            totalTokens: promptTokens + (usage.output ?? 0),
          }
        : { state: "unavailable" },
  };
}
function resolveTranscriptUsage(usage: PersistTextTurnTranscriptParams["assistant"]["usage"]) {
  if (!usage) {
    return ACP_TRANSCRIPT_USAGE;
  }
  const resolved = buildUsageWithNoCost({
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.total,
  });
  return usage.contextUsage ? { ...resolved, contextUsage: usage.contextUsage } : resolved;
}

async function persistTextTurnTranscript(
  params: PersistTextTurnTranscriptParams,
): Promise<PersistTextTurnTranscriptResult> {
  const promptText = params.transcriptBody ?? params.body;
  const replyText = params.skipAssistantTurn === true ? "" : params.finalText;
  const userMessage =
    params.userMessage ??
    (await params.userTurnTranscriptRecorder?.resolveMessage()) ??
    (promptText
      ? buildPersistedUserTurnMessage({
          text: promptText,
          timestamp: Date.now(),
          provenance: params.inputProvenance,
        })
      : undefined);
  if (!userMessage && !replyText) {
    return { kind: "persisted", sessionEntry: params.sessionEntry };
  }
  const inputProvenance =
    params.inputProvenance ?? normalizeInputProvenance(userMessage?.provenance);

  const messages = [];
  if (userMessage) {
    messages.push({
      message: userMessage,
      // Early persistence already owns this row, even when the input has no message key.
      eventId: params.userTurnTranscriptRecorder?.getAdmissionReceipt()?.entryId,
      idempotencyLookup: "scan" as const,
      prepareMessageAfterIdempotencyCheck: (message: unknown) => {
        const prepared = preparePersistedUserTurnMessageForTranscriptWrite(
          // SAFETY: This per-entry callback receives the typed user row attached above.
          message as PersistedUserTurnMessage,
          {
            agentId: params.sessionAgentId,
            sessionKey: params.sessionKey,
            beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
          },
        );
        return prepared
          ? projectAgentHarnessTranscriptMessageForDisplay({
              hidden: false,
              inputProvenance,
              message: prepared,
            })
          : undefined;
      },
    });
  }

  if (replyText) {
    const prepareAssistantTranscriptMessage = params.prepareAssistantTranscriptMessage;
    messages.push({
      idempotencyLookup: "scan-assistant" as const,
      message: {
        role: "assistant",
        ...(params.assistantIdempotencyKey
          ? { idempotencyKey: params.assistantIdempotencyKey }
          : {}),
        content: [{ type: "text", text: replyText }],
        api: params.assistant.api,
        provider: params.assistant.provider,
        model: params.assistant.model,
        usage: resolveTranscriptUsage(params.assistant.usage),
        stopReason: params.assistant.stopReason,
        timestamp: Date.now(),
      },
      prepareMessageAfterIdempotencyCheck: (message: unknown) => {
        // SAFETY: This append creates the assistant row above; the preparer cannot receive another row.
        const assistant = message as Parameters<PrepareAssistantTranscriptMessage>[0];
        return projectAgentHarnessTranscriptMessageForDisplay({
          hidden: false,
          inputProvenance,
          message: prepareAssistantTranscriptMessage
            ? prepareAssistantTranscriptMessage(assistant, replyText)
            : assistant,
        });
      },
    });
  }

  const turn = await persistSessionTranscriptTurn(
    {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      storePath: params.storePath,
      agentId: params.sessionAgentId,
      threadId: params.threadId,
    },
    {
      config: params.config,
      cwd: params.sessionCwd,
      messages,
      publishWhen: "always",
      touchSessionEntry: true,
      updateMode: "file-only",
      expectedSessionId:
        params.expectedSessionId ??
        (params.sessionStore && params.storePath ? params.sessionId : undefined),
    },
  );
  if (turn.rejectedReason === "session-rebound") {
    return { kind: "session-rebound", sessionEntry: undefined };
  }
  const persistedUser = turn.messages.find(
    (entry) => asOptionalRecord(entry.message)?.role === "user",
  );
  if (persistedUser) {
    params.userTurnTranscriptRecorder?.markRuntimePersisted(
      // SAFETY: The typed user-write hook above is the only producer of this batch's user row.
      persistedUser.message as PersistedUserTurnMessage,
      persistedUser.anchor,
      { appended: persistedUser.appended },
    );
  }
  const assistantTranscript = turn.messages.find(
    (entry) => asOptionalRecord(entry.message)?.role === "assistant",
  );
  return {
    kind: "persisted",
    sessionEntry: turn.sessionEntry,
    ...(assistantTranscript ? { assistantTranscript } : {}),
  };
}

export function resolveCliTranscriptReplyText(result: EmbeddedAgentRunResult): string {
  const visibleText = result.meta.finalAssistantVisibleText?.trim();
  if (visibleText) {
    return visibleText;
  }

  return (result.payloads ?? [])
    .filter((payload) => !payload.isError && !payload.isReasoning)
    .map((payload) => payload.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
}

export async function persistAcpTurnTranscript(
  params: TextTurnTranscriptContext & {
    prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
    userInput?: UserTurnInput;
    userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
    assistantIdempotencyKey?: string;
    expectedSessionId?: string;
    finalText: string;
    terminalOutcome: AgentRunTerminalOutcome;
  },
): Promise<PersistTextTurnTranscriptResult> {
  const outcome = classifyAgentRunTerminalOutcome(params.terminalOutcome);
  return await persistTextTurnTranscript({
    ...params,
    ...(params.userInput ? { userMessage: buildPersistedUserTurnMessage(params.userInput) } : {}),
    assistant: {
      api: "openai-responses",
      provider: "openclaw",
      model: "acp-runtime",
      stopReason: outcome === "success" ? "stop" : outcome === "failure" ? "error" : "aborted",
    },
  });
}

export async function persistCliTurnTranscript(
  params: TextTurnTranscriptContext & {
    userMessage?: PersistedUserTurnMessage;
    result: EmbeddedAgentRunResult;
    skipUserTurn?: boolean;
    skipAssistantTurn?: boolean;
  },
): Promise<PersistTextTurnTranscriptResult> {
  const { result, skipUserTurn: requestedSkipUserTurn, ...transcript } = params;
  const replyText = resolveCliTranscriptReplyText(result);
  const provider = result.meta.agentMeta?.provider?.trim() ?? "cli";
  const model = result.meta.agentMeta?.model?.trim() ?? "default";
  const skipUserTurn = requestedSkipUserTurn === true;

  return await persistTextTurnTranscript({
    ...transcript,
    body: skipUserTurn ? "" : transcript.body,
    transcriptBody: skipUserTurn ? undefined : transcript.transcriptBody,
    userMessage: skipUserTurn ? undefined : transcript.userMessage,
    finalText: replyText,
    assistant: {
      api: "cli",
      provider,
      model,
      stopReason: "stop",
      // The marker is terminal for fallback scans: without it, readers could
      // skip this turn and revive an older cumulative usage record as fresh.
      usage: resolveCliTranscriptUsage(result.meta.agentMeta?.lastCallUsage),
    },
  });
}
