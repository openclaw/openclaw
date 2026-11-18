import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import type { Model } from "../../llm/types.js";
import type { ImageSanitizationLimits } from "../image-sanitization.js";
import type { TranscriptPolicy } from "../transcript-policy.types.js";

export type GenericReplayHistoryParams = {
  /** Inter-session provenance has already been annotated by the caller. */
  messages: AgentMessage[];
  allowedToolNames?: Iterable<string>;
  policy: TranscriptPolicy;
  imageLimits: ImageSanitizationLimits;
  signedThinkingProvider: boolean;
  allowProviderOwnedThinkingReplay: boolean;
  isOpenAIResponsesApi: boolean;
  latestModelSwitchTimestamp?: number | null;
  preserveLatestAssistantThinking?: boolean;
};

/** Host-resolved route facts, not provider callbacks or mutable registry handles. */
export type PreparedCompactionReplayOptions = Omit<
  GenericReplayHistoryParams,
  "messages" | "latestModelSwitchTimestamp" | "preserveLatestAssistantThinking" | "allowedToolNames"
> & {
  allowedToolNames: string[];
  model: Model;
  sessionId: string;
  replayEnabled: boolean;
  historyLimit?: number;
  observedTokenCount?: number;
};
