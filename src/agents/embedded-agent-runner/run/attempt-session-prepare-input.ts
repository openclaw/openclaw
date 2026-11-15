import type { SessionTranscriptRuntimeTarget } from "../../../config/sessions/session-accessor.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import type { PersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.types.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { AgentSession } from "../../sessions/index.js";
import type { LlmBoundaryOptions } from "./attempt-llm-boundary.types.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export type EmbeddedAttemptSessionPreparationInput = {
  attempt: EmbeddedRunAttemptParams;
  activeContextEngine?: ContextEngine;
  agentDir: string;
  assertCurrent: () => void;
  effectiveCwd: string;
  effectiveWorkspace: string;
  onSessionManagerCreated: (sessionManager: ReturnType<typeof guardSessionManager>) => void;
  resolveActiveContextEnginePluginId: () => string | undefined;
  runAbortSignal: AbortSignal;
  sessionAgentId: string;
  sessionTarget: SessionTranscriptRuntimeTarget;
  withOwnedTranscriptWrite: <T>(operation: () => Promise<T> | T) => Promise<T>;
};

type SessionBoundaryAttempt = Pick<
  EmbeddedRunAttemptParams,
  | "config"
  | "inputProvenance"
  | "onUserMessagePersistenceInvalidated"
  | "operation"
  | "prompt"
  | "promptCacheKey"
  | "sessionId"
  | "sessionKey"
  | "skipPreparedUserTurnMessage"
  | "suppressNextUserMessagePersistence"
  | "userTurnTranscriptRecorder"
>;

export type EmbeddedAttemptSessionBoundaryInput = {
  abortSignal?: AbortSignal;
  activeSession: Pick<AgentSession, "agent" | "subscribe">;
  appendOnlyRuntimeContext?: boolean;
  inHistorySystemUpdates?: boolean;
  attempt: SessionBoundaryAttempt;
  getUserTranscriptContexts: () => LlmBoundaryOptions["userTranscriptContexts"];
  isRawModelRun: boolean;
  preparedUserTurnMessage: PersistedUserTurnMessage | undefined;
  sessionManager: ReturnType<typeof guardSessionManager>;
  setActiveSessionSystemPrompt: (systemPrompt: string) => void;
};
