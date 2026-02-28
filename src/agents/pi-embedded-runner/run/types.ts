import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import type { SessionSystemPromptReport } from "../../../config/sessions/types.js";
import type { PluginHookBeforeAgentStartResult } from "../../../plugins/types.js";
import type { ResolvedProviderAuth } from "../../model-auth.js";
import type { MessagingToolSend } from "../../pi-embedded-messaging.js";
import type { NormalizedUsage } from "../../usage.js";
import type { RunEmbeddedPiAgentParams } from "./params.js";

type EmbeddedRunAttemptBase = Omit<
  RunEmbeddedPiAgentParams,
  "provider" | "model" | "authProfileId" | "authProfileIdSource" | "thinkLevel" | "lane" | "enqueue"
>;

export type EmbeddedRunAttemptParams = EmbeddedRunAttemptBase & {
  provider: string;
  modelId: string;
  model: Model<Api>;
  attemptNumber?: number;
  runtimeOverride?: "pi" | "claude-sdk";
  /** Retry path for stale/invalid claude-sdk resume session IDs. */
  forceFreshClaudeSession?: boolean;
  resolvedProviderAuth?: ResolvedProviderAuth;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  thinkLevel: ThinkLevel;
  legacyBeforeAgentStartResult?: PluginHookBeforeAgentStartResult;
};

export type EmbeddedRunAttemptResult = {
  aborted: boolean;
  timedOut: boolean;
  /** True if the timeout occurred while compaction was in progress or pending. */
  timedOutDuringCompaction: boolean;
  promptError: unknown;
  sessionIdUsed: string;
  systemPromptReport?: SessionSystemPromptReport;
  messagesSnapshot: AgentMessage[];
  assistantTexts: string[];
  toolMetas: Array<{ toolName: string; meta?: string }>;
  lastAssistant: AssistantMessage | undefined;
  lastToolError?: {
    toolName: string;
    meta?: string;
    error?: string;
    mutatingAction?: boolean;
    actionFingerprint?: string;
  };
  didSendViaMessagingTool: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: MessagingToolSend[];
  successfulCronAdds?: number;
  cloudCodeAssistFormatError: boolean;
  attemptUsage?: NormalizedUsage;
  compactionCount?: number;
  claudeSdkLifecycle?: {
    sdkStatus: "compacting" | null | undefined;
    compactBoundaryCount: number;
    statusCompactingCount: number;
    statusIdleCount: number;
    lastAuthStatus?: {
      isAuthenticating: boolean;
      error?: string;
      output?: string[];
    };
    lastHookEvent?: {
      subtype: "hook_started" | "hook_progress" | "hook_response";
      hookId?: string;
      hookName?: string;
      hookEvent?: string;
      outcome?: string;
    };
    lastTaskEvent?: {
      subtype: "task_started" | "task_progress" | "task_notification";
      taskId?: string;
      status?: string;
      description?: string;
    };
    lastRateLimitInfo?: unknown;
    lastPromptSuggestion?: string;
  };
  /** Client tool call detected (OpenResponses hosted tools). */
  clientToolCall?: { name: string; params: Record<string, unknown> };
};
