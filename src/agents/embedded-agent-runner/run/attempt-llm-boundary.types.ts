import type { AgentMessage } from "../../../../packages/agent-core/src/types.js";

export type UserTranscriptContext = {
  runtimeMessage: AgentMessage;
  transcriptMessage: AgentMessage;
};

export type CurrentUserTimestampMatch = {
  timestamp: number;
  text: string;
  alternateText?: string;
  runtimeTimestamp?: number;
};

export type LlmBoundaryOptions = {
  sessionVersion?: number;
  appendOnlyRuntimeContext?: boolean;
  inHistorySystemUpdates?: boolean;
  timezone?: string;
  includeTimestamp?: boolean;
  projectPersistedSenderContext?: boolean;
  userTranscriptContexts?: readonly UserTranscriptContext[];
  currentUserTimestampOverride?: CurrentUserTimestampMatch;
  onRuntimeContextCarrierRemoved?: (removed: AgentMessage[]) => void;
};
