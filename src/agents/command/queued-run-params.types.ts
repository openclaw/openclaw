import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../../auto-reply/get-reply-options.types.js";
import type { ReasoningLevel, ThinkLevel, VerboseLevel } from "../../auto-reply/thinking.shared.js";
import type { ChatType } from "../../channels/chat-type.js";
import type { SessionEntry, SessionToolOverrides } from "../../config/sessions/types.js";
import type { GroupToolPolicyConfig } from "../../config/types.tools.js";
import type { GatewayUiCommandTarget } from "../../gateway/ui-command-target.types.js";
import type { PluginHookChannelContext } from "../../plugins/hook-channel-context.types.js";
import type { RuntimePluginToolGrant } from "../../plugins/runtime/tool-grant.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { ProviderReviewAcknowledgment } from "../../sessions/provider-review.js";
import type { SkillLibraryAuthoringCapability } from "../../skills/library/authoring.js";
import type { SkillSnapshot } from "../../skills/types.js";
import type { ReplyExpectation } from "../reply-completion.js";
import type { RequesterOrigin } from "../requester-origin.js";
import type { ScheduledToolPolicyContext } from "../scheduled-tool-policy.js";
import type { TrustedSubagentCompletionHandoff } from "../subagents/announce/subagent-announce-handoff.js";
import type { SilentReplyPromptMode } from "../system-prompt.types.js";

/** Prepared execution inputs retained by queued turns, without live attempt ownership. */
export type QueuedAgentRunParams = {
  requesterOrigin?: RequesterOrigin;
  operatorProfileId?: string;
  conversationId?: string | null;
  messageThreadId?: string | number;
  providerReviewAcknowledgment?: ProviderReviewAcknowledgment;
  sessionId: string;
  sessionKey?: string;
  messageProvider?: string;
  /** Capabilities declared by the gateway client that originated this run. */
  clientCaps?: string[];
  /** Profile selected from the session's assigned human owner or authenticated human creator, never its latest sender. */
  bootstrapUserProfileId?: string;
  gatewayUiCommandTarget?: GatewayUiCommandTarget;
  chatType?: ChatType;
  agentAccountId?: string;
  /** Channel-specific identity metadata surfaced to plugin hooks. */
  channelContext?: PluginHookChannelContext;
  /** Trusted sender identity bit for command/channel-action auth. */
  senderIsOwner?: boolean;
  /** Verified current requester for Git credit only; grants no tool authority. */
  gitContributorProfileId?: string;
  /** Device-scoped operator session allowed to review approvals initiated by this run. */
  approvalReviewerDeviceId?: string;
  workspaceDir: string;
  /** Task working directory for tool/runtime execution. Defaults to workspaceDir. */
  cwd?: string;
  toolOverrides?: SessionToolOverrides;
  skillsSnapshot?: SkillSnapshot;
  authProfileId?: string;
  thinkLevel?: ThinkLevel;
  /** Run-scoped selection intent for declared chat-template effort. */
  thinkingExplicit?: boolean;
  cyberAccessProgram?: SessionEntry["cyberAccessProgram"];
  fastMode?: FastMode;
  /** Effective auto fast-mode cutoff for this run, in seconds. */
  fastModeAutoOnSeconds?: number;
  timeoutMs: number;
  /** Explicit timeout override; equality with the configured default does not imply inheritance. */
  runTimeoutOverrideMs?: number;
  ownerNumbers?: string[];
  inputProvenance?: InputProvenance;
  /** Trusted server-stamped authority for an explicitly capped scheduled run. */
  scheduledToolPolicy?: ScheduledToolPolicyContext;
  extraSystemPrompt?: string;
  /** Exact producer-owned transient section; unannotated instructions remain persistent. */
  extraSystemPromptTurnContext?: { start: number; text: string };
  /** Visible source replies must use the message tool when set to message_tool_only. */
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  /** Action sink available for model-proposed follow-up tasks. */
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
  suppressNextUserMessagePersistence?: boolean;
  /** Out-of-band plugin bindings attached by the run initiator. */
  toolBindings?: Readonly<Record<string, unknown>>;
  /** Raw peer observed by the inbound routing owner, before identity linking. */
  conversationRoutePeerId?: string;
  /** Trusted channel-configured policy for the admitted conversation turn. */
  conversationToolPolicy?: GroupToolPolicyConfig;
  /** Trusted provider role ids for the requester in this group turn. */
  memberRoleIds?: string[];
  permissionMode?: SessionEntry["permissionMode"];
  sessionRoot?: string;
  /** Locks the selected model against hooks and fallbacks; does not imply native model ownership. */
  modelSelectionLocked?: boolean;
  authProfileIdSource?: "auto" | "user";
  verboseLevel?: VerboseLevel;
  reasoningLevel?: ReasoningLevel;
  /** Consumed in-process subagent-completion capability; never derived from public input. */
  trustedInternalHandoff?: TrustedSubagentCompletionHandoff;
  /** Owner-scoped plugin tool grant; normal policy and deny rules still apply. */
  runtimePluginToolGrant?: RuntimePluginToolGrant;
  silentReplyPromptMode?: SilentReplyPromptMode;
  enforceFinalTag?: boolean;
  silentExpected?: boolean;
  /**
   * Host-owned reply requirement for this input, independent of model output.
   * Confirmed source delivery and pending custody prevent duplicate recovery.
   */
  terminalReplyExpectation?: ReplyExpectation;
  suppressTranscriptOnlyAssistantPersistence?: boolean;
  skillLibraryAuthoring?: SkillLibraryAuthoringCapability;
};
