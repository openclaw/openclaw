import type { SessionTranscriptRuntimeTarget } from "../../../config/sessions/session-accessor.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export type EmbeddedAttemptSessionPreparationInput = {
  attempt: EmbeddedRunAttemptParams;
  activeContextEngine?: ContextEngine;
  agentDir: string;
  assertCurrent: () => void;
  effectiveCwd: string;
  effectiveWorkspace: string;
  onSessionManagerCreated: (sessionManager: ReturnType<typeof guardSessionManager>) => void;
  replayAllowedToolNames: ReadonlySet<string>;
  resolveActiveContextEnginePluginId: () => string | undefined;
  runAbortSignal: AbortSignal;
  sessionAgentId: string;
  sessionTarget: SessionTranscriptRuntimeTarget;
  withOwnedTranscriptWrite: <T>(operation: () => Promise<T> | T) => Promise<T>;
};
