import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type { ThinkLevel, VerboseLevel } from "../../auto-reply/thinking.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { SkillSnapshot } from "../../skills/types.js";
import type { resolveMessageChannel } from "../../utils/message-channel.js";
import type { PreparedAgentRunAdmission } from "../admitted-run-context.js";
import type { RunEntryCandidateOptions } from "../embedded-agent-runner/run-entry.js";
import type { DeferredEmbeddedRunLifecycleManager } from "../embedded-agent-runner/run/deferred-lifecycle-owner.js";
import type { RunEmbeddedAgentInternalParams } from "../embedded-agent-runner/run/internal-params.js";
import type { PreparedModelRuntimePluginGeneration } from "../prepared-model-runtime.types.js";
import type { AgentMessage } from "../runtime/index.js";
import type { AgentCommandOpts, AgentRunContext } from "./types.js";

export type RunAgentAttemptParams = Pick<
  RunEntryCandidateOptions,
  "isFallbackRetry" | "modelRoutingProvenance"
> &
  Partial<Omit<RunEntryCandidateOptions, "isFallbackRetry" | "modelRoutingProvenance">> & {
    preparedRunAdmission: PreparedAgentRunAdmission;
    providerOverride: string;
    modelOverride: string;
    modelHasVision?: boolean;
    modelThinkingCapability?: RunEmbeddedAgentInternalParams["modelThinkingCapability"];
    configuredAuthProfileId?: string;
    originalProvider: string;
    cfg: OpenClawConfig;
    sessionEntry: SessionEntry | undefined;
    sessionId: string;
    sessionKey: string | undefined;
    sessionTarget?: SessionTranscriptRuntimeTarget;
    sessionAgentId: string;
    sessionFile: string;
    workspaceDir: string;
    cwd?: string;
    body: string;
    transcriptBody?: string;
    preserveCliSessionBinding?: boolean;
    resolvedThinkLevel: ThinkLevel;
    fastMode?: FastMode;
    fastModeStartedAtMs?: number;
    fastModeAutoOnSeconds?: number;
    timeoutMs: number;
    runTimeoutOverrideMs?: number;
    runId: string;
    lifecycleGeneration: string;
    opts: AgentCommandOpts;
    runContext: AgentRunContext;
    spawnedBy: string | undefined;
    messageChannel: ReturnType<typeof resolveMessageChannel>;
    skillsSnapshot: SkillSnapshot | undefined;
    resolvedVerboseLevel: VerboseLevel | undefined;
    agentDir: string;
    onAgentEvent: (evt: {
      stream: string;
      data?: Record<string, unknown>;
      sessionKey?: string;
    }) => void | Promise<void>;
    deferTerminalLifecycle?: boolean;
    deferredLifecycle?: DeferredEmbeddedRunLifecycleManager;
    authProfileProvider: string;
    sessionStore?: Record<string, SessionEntry>;
    storePath?: string;
    pluginsEnabled?: boolean;
    metadataSnapshot?: PluginMetadataSnapshot;
    pluginGeneration: PreparedModelRuntimePluginGeneration | undefined;
    sessionHasHistory?: boolean;
    fallbackRuntimeState?: { originRuntime?: "cli" | "embedded" };
    suppressPromptPersistenceOnRetry?: boolean;
    userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
    onUserMessagePersisted?: (message: Extract<AgentMessage, { role: "user" }>) => void;
    onLifecycleGenerationChanged?: (lifecycleGeneration: string) => void;
    onCompactionAccounting?: RunEmbeddedAgentInternalParams["onCompactionAccounting"];
    onCompactionRequestBudget?: RunEmbeddedAgentInternalParams["onCompactionRequestBudget"];
    onSuccessfulAuthProfile?: (
      selection: Pick<RunEmbeddedAgentInternalParams, "authProfileId" | "authProfileIdSource">,
    ) => void;
  };
