import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { ImageContent, Model } from "../../llm/types.js";
import type { Agent, AgentEvent, AgentMessage, ThinkingLevel } from "../runtime/index.js";
import type {
  ExtensionCommandContextActions,
  ExtensionErrorListener,
  ExtensionRunner,
  ExtensionUIContext,
  InputSource,
  ShutdownHandler,
  ToolDefinition,
} from "./extensions/index.js";
import type { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import type { SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";

/** The embedded request boundary owns threshold checks while this flag is set. */
export const agentSessionDeferThresholdCompaction: unique symbol = Symbol(
  "openclaw.agent-session.defer-threshold-compaction",
);

/** Runs provider checkpoint work without aborting or restarting the current tool loop. */
export const agentSessionRunProviderCompaction: unique symbol = Symbol(
  "openclaw.agent-session.run-provider-compaction",
);

type AgentSessionCompactionOutcome =
  | {
      status: "completed";
      tokensBefore: number;
      tokensAfter: number;
      willRetry: boolean;
      qualityDegraded?: true;
    }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string }
  | { status: "aborted" };

type AgentSessionCompactionEndEvent = {
  type: "compaction_end";
  hooksHandled?: boolean;
  itemId?: string;
  reason: "manual" | "threshold" | "overflow";
  outcome: AgentSessionCompactionOutcome;
};

export type AgentSessionEvent =
  | Exclude<AgentEvent, { type: "agent_end" }>
  | {
      type: "agent_end";
      messages: AgentMessage[];
      willRetry: boolean;
      assistantEntryId?: string;
    }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "agent_settled" }
  | { type: "agent_handoff" }
  | {
      type: "compaction_start";
      reason: "manual" | "threshold" | "overflow";
      itemId?: string;
      hooksHandled?: boolean;
    }
  | { type: "session_info_changed"; name: string | undefined }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
  | AgentSessionCompactionEndEvent
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };

export type AgentSessionEventListener = (event: AgentSessionEvent) => unknown;
export type AgentSessionWriteSettlementRunner = <T>(run: () => Promise<T> | T) => Promise<T>;

export interface AgentSessionConfig {
  agent: Agent;
  /** Exact system prompt prepared by the runtime owner. */
  systemPrompt: string;
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  cwd: string;
  resourceLoader: ResourceLoader;
  /** SDK custom tools registered outside extensions. */
  customTools?: ToolDefinition[];
  modelRegistry: ModelRegistry;
  /** Runtime-owned tool allowlist, also used for initial activation. */
  allowedToolNames: string[];
  /** Mutable reference used by Agent to access the current extension runner. */
  extensionRunnerRef?: { current?: ExtensionRunner };
  /** Settlement boundary for session writes and write-capable hooks. */
  withSessionWriteSettlement?: AgentSessionWriteSettlementRunner;
  /** Owner of reactive context-overflow recovery. Defaults to the session. */
  contextOverflowRecoveryOwner?: "session" | "caller";
  /** Resolve the admitted compaction policy from the active model, including provider defaults. */
  resolveCompactionThinkingLevel?: (
    model: Model & { compactionThinkingDefault?: ThinkLevel },
    inheritedLevel: ThinkingLevel,
  ) => ThinkingLevel;
  /** Whether disposing this object ends the durable provider session. Defaults to true. */
  cleanupProviderSessionResourcesOnDispose?: boolean;
}

export interface ExtensionBindings {
  uiContext?: ExtensionUIContext;
  commandContextActions?: ExtensionCommandContextActions;
  abortHandler?: () => void;
  shutdownHandler?: ShutdownHandler;
  onError?: ExtensionErrorListener;
}

export interface PromptOptions {
  /** Expand file-based prompt templates. Defaults to true. */
  expandPromptTemplates?: boolean;
  images?: ImageContent[];
  /** Queue behavior when an agent is already streaming. */
  streamingBehavior?: "steer" | "followUp";
  /** Source of input for extension input handlers. Defaults to interactive. */
  source?: InputSource;
  /** Internal RPC hook for prompt preflight acceptance or rejection. */
  preflightResult?: (success: boolean) => void;
  /** Internal identity for a current user turn that is already durable. */
  persistedUserIdempotencyKey?: string;
}
