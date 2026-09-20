import type { ProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { ToolResultContentSource } from "../../../packages/agent-core/src/types.js";
/**
 * Shared types for preparing and executing CLI-backed agent runs.
 */
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { CliSessionBinding, SessionEntry } from "../../config/sessions.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import type { SessionSystemPromptReport } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine } from "../../context-engine/types.js";
import type { CronScheduledToolCallerOrigin } from "../../cron/scheduled-tool-policy.js";
import type { DiagnosticEmbeddedRunOwner } from "../../logging/diagnostic-run-activity.js";
import type {
  CliBackendExecute,
  CliBackendExecutionMode,
  CliBackendPromptContext,
} from "../../plugins/cli-backend.types.js";
import type { PluginInstanceConsumer } from "../../plugins/plugin-instance.types.js";
import type { SpawnSecretInput } from "../../process/supervisor/types.js";
import type { SkillWorkshopProposalRevisionConstraint } from "../../skills/workshop/types.js";
import type { AdmittedRunContext } from "../admitted-run-context.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import type { ExecElevatedDefaults } from "../bash-tools.exec-types.js";
import type { BootstrapContextMode } from "../bootstrap-files.js";
import type { ResolvedCliBackend } from "../cli-backends.js";
import type { CliSessionReuseResult } from "../cli-session.js";
import type {
  AgentRunClientContext,
  AgentRunMessageContext,
  AgentRunChannelContext,
  AgentRunModelOptions,
  AgentRunInputContext,
  AgentRunTranscriptContext,
  AgentRunLifecycle,
} from "../command/shared-types.js";
import type { ContextWindowInfo } from "../context-window-guard.js";
import type { FailoverReason } from "../embedded-agent-helpers.js";
import type { EmbeddedAgentExecutionPhase } from "../embedded-agent-runner/execution-phase.js";
import type {
  CurrentInboundPromptContext,
  ResolvedToolPromptFinalizer,
} from "../embedded-agent-runner/run/params.js";
import type { ExecPolicyOverrides } from "../exec-defaults.js";
import type { PreparedQuestionAnswerAuthority } from "../harness/host-private-capabilities.js";
import type { AgentHarnessIsolatedCompletionParamsV2 } from "../harness/types.js";
import type { ReplyExpectation } from "../reply-completion.js";
import type { RootedExecutionRequest } from "../rooted-run-params.js";
import type { EmbeddedRunTrigger } from "../run-trigger.js";
import type { SilentReplyPromptMode } from "../system-prompt.types.js";
import type { prepareCliBundleMcpConfig } from "./bundle-mcp.js";

export type NodeClaudePlacement = { nodeId: string; cwd?: string };

export type CliExecutionTarget =
  | { kind: "node"; placement: NodeClaudePlacement }
  | { kind: "plugin"; execute: CliBackendExecute }
  | { kind: "process" };

type CliSessionRetryParams = {
  provider: string;
  reason: FailoverReason;
  sessionId: string;
};

/** Input contract for one CLI-backed agent run. */
export type RunCliAgentParams = {
  /** Core lifecycle owner; never forwarded to the plugin execution context. */
  diagnosticOwner?: DiagnosticEmbeddedRunOwner;
  sessionTarget?: SessionTranscriptRuntimeTarget;
  /** Session identity used only for sandbox and tool-policy resolution. */
  runtimePolicySessionKey?: string;
  sessionEntry?: SessionEntry;
  trigger?: EmbeddedRunTrigger;
  sessionFile: string;
  /** Host-owned task root; preparation must mediate all tools through its filesystem policy. */
  rootedExecution?: RootedExecutionRequest;
  /** Start a fresh CLI process so per-turn MCP authority is reloaded from this run. */
  disableCliLiveSession?: boolean;
  /** Finalizes caller-owned guidance after backend tool projection is known. */
  finalizePromptForResolvedTools?: ResolvedToolPromptFinalizer;
  /** Undecorated current-turn prompt used to merge inline and offloaded images. */
  imagePrompt?: string;
  /**
   * Execution mode for the generic CLI runner. Side questions are one-shot
   * background answers and must not reuse or mutate normal agent sessions.
   */
  executionMode?: CliBackendExecutionMode;
  /** Internal one-shot inference path: suppress transcript, hook, context-engine, and delivery work. */
  isolatedCompletion?: true;
  outputTextPolicy?: AgentHarnessIsolatedCompletionParamsV2["outputTextPolicy"];
  /** Internal backend control command: reuse the native session without recording a conversation turn. */
  controlOperation?: "compact";
  /** Persist the successful CLI assistant reply into the OpenClaw session transcript. */
  persistAssistantTranscript?: boolean;
  /** Session store path used when assistant transcript persistence is enabled. */
  storePath?: string;
  /** Admission-time lifecycle half of the durable transcript writer fence. */
  expectedLifecycleRevision?: string;
  /** Exact admitted run allowed to append to the durable transcript. */
  expectedWriterRunId?: string;
  currentInboundContext?: CurrentInboundPromptContext;
  /** Selected model provider used for tool policy; distinct from a CLI runtime id. */
  modelProvider?: string;
  /** Resolved logical model selected by this run's owner, before CLI transport mapping. */
  requesterModel?: ProviderModelRef;
  /** Native context window resolved by the run owner from its prepared model catalog. */
  modelContextWindow?: number;
  /** Effective context cap resolved by the run owner from its prepared model catalog. */
  modelContextTokens?: number;
  provider: string;
  silentReplyPromptMode?: SilentReplyPromptMode;
  allowEmptyAssistantReplyAsSilent?: boolean;
  terminalReplyExpectation?: ReplyExpectation;
  /** Static portion of extraSystemPrompt (excluding per-message inbound metadata) for session reuse hashing. */
  extraSystemPromptStatic?: string;
  cliSessionBindingFacts?: CliSessionBindingFacts;
  streamParams?: import("../command/shared-types.js").AgentStreamParams;
  cliSessionId?: string;
  cliSessionBinding?: CliSessionBinding;
  /** Consume the backend fork argument on this resume invocation only. */
  forkCliSessionOnResume?: boolean;
  /** Bound a resumed fork at this previously observed assistant checkpoint. */
  cliSessionResumeAt?: string;
  /** Atomically claim the persisted one-shot marker after the CLI queue admits this turn. */
  claimCliSessionFork?: () => Promise<boolean>;
  /** Re-arm a claimed marker when the CLI turn fails before producing a successor session. */
  restoreCliSessionFork?: () => Promise<void>;
  /** Persist the successor ID as soon as the CLI reports the forked session. */
  persistCliSessionForkSuccessor?: (sessionId: string) => Promise<void>;
  /** Atomically arm a cache-preserving fork before retrying a stalled resumed session. */
  onBeforeForkedCliSessionRetry?: (params: CliSessionRetryParams) => boolean | Promise<boolean>;
  /** Private seam: report the credential/runtime owner only after a successful real turn. */
  onSuccessfulAuthBinding?: (binding: {
    authProfileId?: string;
    authFingerprint?: string;
    runtimeOwnerFingerprint?: string;
    runtimeOwnerKind?: "cli-runtime" | "plugin-harness" | "aws-sdk";
    runtimeOwnerId?: string;
    runtimeArtifactFingerprint?: string;
    runtimeArtifactId?: string;
    skipLocalCredential?: true;
  }) => void;
  onBeforeFreshCliSessionRetry?: (params: CliSessionRetryParams) => boolean | Promise<boolean>;
  bootstrapContextMode?: BootstrapContextMode;
  chatId?: string;
  /** Effective turn-local exec policy resolved before entering the CLI runtime. */
  execOverrides?: ExecPolicyOverrides;
  /** Effective elevated-exec defaults resolved before entering the CLI runtime. */
  bashElevated?: ExecElevatedDefaults;
  /** Runtime tool allow-list. CLI harnesses need a backend-owned exact translation. */
  toolsAllow?: string[];
  /** Exact Skill Workshop proposal revision bound by the Gateway for this turn. */
  skillWorkshopProposalRevision?: SkillWorkshopProposalRevisionConstraint;
  skillLibraryAuthoring?: import("../../skills/library/authoring.js").SkillLibraryAuthoringCapability;
  /** Server-authored origin for fresh automation mutations from this CLI run. */
  cronCreatorCallerOrigin?: CronScheduledToolCallerOrigin;
  /** Exact native plus canonical OpenClaw surface for a selectable CLI backend. */
  cliToolAvailability?: {
    native: string[];
    openClaw: string[];
  };
  /** Caller-owned authority for credential use; cancellation alone is not authorization. */
  assertCurrent?: () => void;
  onExecutionStarted?: () => void;
  onExecutionPhase?: (info: {
    phase: EmbeddedAgentExecutionPhase;
    provider?: string;
    model?: string;
    backend?: string;
    source?: string;
    firstModelCallStarted?: boolean;
  }) => void;
  emitCommentaryText?: boolean;
  /**
   * Close any long-lived CLI live session created for this run after the run
   * finishes. Intended for temporary helper calls that should not keep process
   * handles alive after returning.
   */
  cleanupCliLiveSessionOnRunEnd?: boolean;
} & AgentRunClientContext &
  AgentRunMessageContext &
  AgentRunChannelContext &
  AgentRunModelOptions &
  AgentRunInputContext &
  AgentRunTranscriptContext &
  AgentRunLifecycle;

/** Backend config after MCP, skill, env, and cleanup preparation. */
export type CliSecretInput = SpawnSecretInput & {
  /** Process-local non-secret generation used only to invalidate a warm child. */
  fingerprint: string;
};

type CliPreparedBackend = Awaited<ReturnType<typeof prepareCliBundleMcpConfig>> & {
  /** Exact process cleanup retained across attempt copies and natural registry removal. */
  closeLiveSession?: (
    reason: import("../../plugins/cli-backend.types.js").CliBackendLiveSessionCloseReason,
  ) => Promise<void>;
  /** Transfer process-owned native skill artifacts without claiming turn-scoped MCP/auth state. */
  claimLiveSessionResources?: () => (() => Promise<void>) | undefined;
  /** Private child-only credential transport; never serialized into env or public plugin state. */
  secretInput?: CliSecretInput;
  /** Gateway-owned capture fence for this prepared bundle-MCP client. */
  mcpClientGrantCapture?: {
    /** Fresh bearer minted for this prepared turn. */
    transportToken: string;
    /** Move this turn's authority onto the bearer held by an existing child. */
    adoptProcessToken: (processToken: string) => void;
    /** Revoke the bearer when the child process that holds it exits. */
    revokeProcessToken: () => void;
    activate: (captureKey: string, assertCurrent: () => void) => void;
    deactivate: (captureKey: string) => void;
    captureNativeTools?: (tools: unknown) => void;
  };
};

/** Reusable CLI session id, soft content drift, or hard invalidation. */
export type CliReusableSession =
  | CliSessionReuseResult
  | {
      mode: "invalidate";
      invalidatedReason: "system-prompt" | "missing-transcript" | "orphaned-tool-use";
    };

export type CliSessionBindingFacts = {
  extraSystemPromptStatic?: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  requireExplicitMessageTarget?: boolean;
};

/** Fully prepared execution context consumed by the CLI runner executor. */
export type PreparedCliRunContext = {
  params: RunCliAgentParams & { admittedRunContext: AdmittedRunContext };
  /** Core-only original caller policy, bound to each native request's exact lifetime. */
  bindQuestionAnswerAuthority?: (assertActive: () => void) => PreparedQuestionAnswerAuthority;
  effectiveAuthProfileId?: string;
  /** Selected profile snapshot used only for terminal health settlement. */
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  started: number;
  workspaceDir: string;
  cwd?: string;
  backendResolved: ResolvedCliBackend;
  preparedBackend: CliPreparedBackend;
  executionTarget: CliExecutionTarget;
  /** Keeps a plugin-owned turn admitted on its backend instance across a plugin hot reload. */
  pluginExecutionConsumer?: PluginInstanceConsumer;
  reusableCliSession: CliReusableSession;
  /** Resume is safe only while the exact managed Claude stdio child still exists. */
  requiredClaudeLiveSessionGeneration?: string;
  hadSessionFile: boolean;
  contextEngineConfig: OpenClawConfig;
  contextEngine?: ContextEngine;
  deferContextEngineDisposalUntil?: (promise: Promise<void>) => void;
  contextEngineTurnPrompt?: string;
  promptContext?: CliBackendPromptContext;
  /** Logical model input retained for policy/observation hooks when transport context is separate. */
  promptForHooks?: string;
  modelId: string;
  normalizedModel: string;
  contextWindowInfo?: ContextWindowInfo;
  systemPrompt: string;
  systemPromptReport: SessionSystemPromptReport;
  claudeSkillsPluginArgs: string[];
  /** Host-held, policy-selected personal Workshop tool for the paired-node adapter. */
  nodeSkillWorkshop?: import("../tools/common.js").AnyAgentTool;
  openClawHistoryPrompt?: string;
  /** Live owner of the transcript account-coverage checkpoint, independent of native continuity. */
  cliHistoryWriter?: import("../../config/sessions/cli-history-boundary.js").CliHistoryWriter;
  authEpoch?: string;
  /** Strict owner fingerprint captured for live inference verification only. */
  authBindingFingerprint?: string;
  /** Stable CLI backend/profile owner shape, usable only with a successful native session. */
  runtimeOwnerFingerprint?: string;
  /** Exact executable/package implementation used by this CLI process. */
  runtimeArtifactFingerprint?: string;
  authBindingSkipsLocalCredential?: true;
  authEpochVersion: number;
  extraSystemPromptHash?: string;
  messageToolPolicyHash?: string;
  promptToolNamesHash?: string;
  resultContentSourceByToolName?: ReadonlyMap<string, ToolResultContentSource>;
  cwdHash?: string;
  mcpDeliveryCapture?: true;
};
