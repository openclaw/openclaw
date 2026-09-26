import type { resolveContextEngine } from "../../../context-engine/registry.js";
import type { ToolOutcomeObserver } from "../../agent-tools.before-tool-call.js";
import type { EmbeddedRunReplayState } from "../replay-state.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import type { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";
import type { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";
import type { createEmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type PreparedRuntime = Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>>;
type ContextEngine = Awaited<ReturnType<typeof resolveContextEngine>>;
type SessionPromptState = Awaited<ReturnType<typeof createEmbeddedRunSessionPromptState>>;
type TerminalRetryState = ReturnType<typeof createEmbeddedRunTerminalRetryState>;

export type EmbeddedRunAttemptDispatchInput = {
  runInput: PreparedEmbeddedRunInput;
  preparedRuntime: PreparedRuntime;
  contextEngine: ContextEngine;
  sessionPromptState: SessionPromptState;
  terminalRetryState: TerminalRetryState;
  replayState: EmbeddedRunReplayState;
  provider: string;
  modelId: string;
  startupStagesEmitted: boolean;
  bootstrapPromptWarningSignaturesSeen: string[];
  resolveRuntimeFallbackReason: () => string | null;
  onToolOutcome: ToolOutcomeObserver;
  semanticNoProgressObserver?: EmbeddedRunAttemptParams["semanticNoProgressObserver"];
  semanticStallReplanState?: EmbeddedRunAttemptParams["semanticStallReplanState"];
  isTurnTainted: () => boolean;
  allocateToolOutcomeOrdinal: NonNullable<EmbeddedRunAttemptParams["allocateToolOutcomeOrdinal"]>;
  getPostCompactionAbortError: () => Error | undefined;
  setPostCompactionAbortController: (controller: AbortController | undefined) => void;
  clearPostCompactionAbortController: (controller: AbortController) => void;
  permissionChange?: EmbeddedRunAttemptParams["permissionChange"];
};
