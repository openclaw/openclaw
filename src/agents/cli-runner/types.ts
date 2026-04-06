import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { CliSessionBinding } from "../../config/sessions.js";
import type { SessionSystemPromptReport } from "../../config/sessions/types.js";
import type { CliBackendConfig } from "../../config/types.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import type { BootstrapPromptWarningMode } from "../bootstrap-budget.js";
import type { ResolvedCliBackend } from "../cli-backends.js";
import type { BootstrapProfile, EmbeddedContextFile } from "../pi-embedded-helpers.js";
import type { EmbeddedRunTrigger } from "../pi-embedded-runner/run/params.js";
import type { SkillSnapshot } from "../skills.js";
import type { WorkspaceBootstrapFile } from "../workspace.js";

export type RunCliAgentParams = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  prompt: string;
  provider: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  streamParams?: import("../command/types.js").AgentStreamParams;
  ownerNumbers?: string[];
  cliSessionId?: string;
  cliSessionBinding?: CliSessionBinding;
  authProfileId?: string;
  bootstrapPromptWarningSignaturesSeen?: string[];
  bootstrapPromptWarningSignature?: string;
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  messageProvider?: string;
  agentAccountId?: string;
  /** Resolved message channel (e.g. "feishu") for context-aware streaming. */
  messageChannel?: string;
  /** Skills snapshot for the current workspace/agent context. */
  skillsSnapshot?: SkillSnapshot;
  /** Disable built-in/MCP tools for this run. */
  disableTools?: boolean;
  /** Number of compactions that have already occurred on this session before this run. */
  sessionCompactionCount?: number;
  /** Abort signal to cancel the run early. */
  abortSignal?: AbortSignal;
  /** What triggered this agent run. */
  trigger?: EmbeddedRunTrigger;
  /** Called when the CLI emits a system/init record. */
  onSystemInit?: (payload: { subtype: string; sessionId?: string }) => void;
  /** Called with each assistant text chunk as it streams in. */
  onAssistantTurn?: (text: string) => void;
  /** Called with each thinking/reasoning chunk as it streams in. */
  onThinkingTurn?: (payload: { text: string; delta?: string }) => void;
  /** Called when a tool-use block starts. */
  onToolUseEvent?: (payload: { name: string; toolUseId?: string; input?: unknown }) => void;
  /** Called when a tool result arrives. */
  onToolResult?: (payload: {
    toolUseId?: string;
    text?: string;
    isError?: boolean;
    startLine?: number;
    numLines?: number;
    totalLines?: number;
  }) => void;
};

export type CliPreparedBackend = {
  backend: CliBackendConfig;
  cleanup?: () => Promise<void>;
  mcpConfigHash?: string;
  env?: Record<string, string>;
};

export type CliReusableSession = {
  sessionId?: string;
  invalidatedReason?: "auth-profile" | "auth-epoch" | "system-prompt" | "mcp";
};

export type PreparedCliRunContext = {
  params: RunCliAgentParams;
  started: number;
  workspaceDir: string;
  backendResolved: ResolvedCliBackend;
  preparedBackend: CliPreparedBackend;
  reusableCliSession: CliReusableSession;
  modelId: string;
  normalizedModel: string;
  systemPrompt: string;
  systemPromptReport: SessionSystemPromptReport;
  promptTools: AgentTool[];
  bootstrapPromptWarningLines: string[];
  heartbeatPrompt?: string;
  authEpoch?: string;
  extraSystemPromptHash?: string;
  /** Context window size in tokens for the resolved model. */
  contextWindowTokens: number;
  /** The bootstrap profile actually used after pre-flight budget trimming. */
  activeProfile: BootstrapProfile;
  /** Context files actually injected after budget trimming (may differ from original). */
  activeContextFiles: EmbeddedContextFile[];
  /** Original bootstrap files before budget analysis (needed for runtime recovery). */
  bootstrapFiles: WorkspaceBootstrapFile[];
  /** Bootstrap prompt truncation warning mode. */
  bootstrapPromptWarningMode: BootstrapPromptWarningMode;
  /** Session agent ID resolved for the run. */
  sessionAgentId?: string;
  /** Default agent ID for the session. */
  defaultAgentId?: string;
  /** Whether this backend is claude-cli. */
  isClaude: boolean;
  /** Bootstrap budget limits (per-file). */
  bootstrapMaxChars: number;
  /** Bootstrap budget limits (total). */
  bootstrapTotalMaxChars: number;
  /** Skills prompt for the run (undefined if not applicable). */
  skillsPrompt?: string;
  /** Effective skill snapshot used to build the run prompt/env. */
  effectiveSkillsSnapshot?: SkillSnapshot;
  /** Docs path resolved for the run workspace. */
  docsPath?: string;
  /** Extra system prompt used in the build. */
  extraSystemPrompt?: string;
};
