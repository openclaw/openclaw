import type {
  ApprovalDecision,
  ApprovalTerminalReason,
} from "../../../packages/gateway-protocol/src/schema/approvals.js";
import type { AnyAgentTool } from "../tools/common.js";

type AgentHarnessHostApprovalResult = Readonly<{
  decision: ApprovalDecision | null | undefined;
  terminalReason: ApprovalTerminalReason | null | undefined;
}>;

type AgentHarnessPreparedEnvironment = Readonly<{
  credentialScrubEnv: Readonly<Record<string, string>>;
  localIdentityEnv: Readonly<Record<string, string>>;
  /** Local child destination facts; must not be projected into a remote or sandbox process. */
  localProcessEnv?: Readonly<Record<string, string>>;
  /** Non-secret fact used to select the local GitHub identity overlay. */
  managedLocalIdentity: boolean;
}>;

type AgentHarnessToolSurfaceOptions = Omit<
  NonNullable<Parameters<(typeof import("../agent-tools.js"))["createOpenClawCodingTools"]>[0]>,
  "operationalRunInstance"
>;

type AgentHarnessModelExecutionBinder = (
  model: import("@openclaw/model-catalog-core/model-catalog-refs").ProviderModelRef | undefined,
) => Readonly<{ signal: AbortSignal; assertCurrent: () => void; release: () => void }> | undefined;

export type AgentHarnessHostCapabilities = Readonly<{
  kind: "agent-harness-host-capability";
  version: 1;
  /** Fails closed unless this exact admitted run capability remains active. */
  assertActive: () => void;
  /** Binds the actual native model; returns undefined only for runs without an operator source. */
  bindModelExecution?: AgentHarnessModelExecutionBinder;
  /** Retains the original source for already-admitted work beyond foreground completion. */
  retainSourceAuthority?: () =>
    | Readonly<{
        assertCurrent: () => void;
        signal?: AbortSignal;
        /** Live preflight fact; absence means unknown, not an unrestricted source. */
        modelPolicyRequired?: boolean;
        /** Opaque equality for compatible active input; never authority by itself. */
        sourceIdentity?: object;
        /** Binds later dispatches while this retained work remains active. */
        bindModelExecution?: AgentHarnessModelExecutionBinder;
        release: () => void;
      }>
    | undefined;
  /** Reports one completed model call's output tokens to this admitted run's live total. */
  reportOutputTokens?: (outputTokens: number) => void;
  /** Adds native provenance only to this host's exact current admitted prompt. */
  annotateCurrentUserTurn?: (
    annotation: import("../../sessions/user-turn-transcript.types.js").UserTurnTranscriptAnnotation,
  ) => Promise<void>;
  /** Rebuilds retained attachments under this host's captured media policy and run authority. */
  prepareContextMedia?: (request: {
    message: import("../runtime/index.js").AgentMessage;
    maxChars: number;
  }) => Promise<{ text?: string; images: import("../../llm/types.js").ImageContent[] }>;
  /** Stages reply attachments under captured sender policy while the harness reader is live. */
  prepareReplyMedia?: (
    request: {
      workspaceRoot?: string;
      readWorkspaceFile: (
        relativePath: string,
        options: { maxBytes: number; signal: AbortSignal },
      ) => Promise<Buffer>;
      signal?: AbortSignal;
    } & (
      | {
          kind: "attempt";
          attempt: import("../embedded-agent-runner/run/attempt-result.js").EmbeddedRunAttemptWithReceiptEvidence;
        }
      | { kind: "payload"; payload: import("../../auto-reply/reply-payload.js").ReplyPayload }
    ),
  ) => Promise<
    | {
        kind: "attempt";
        preparedMedia: import("../../auto-reply/reply/reply-media-paths.js").PreparedReplyMedia;
      }
    | { kind: "payload"; payload: import("../../auto-reply/reply-payload.js").ReplyPayload }
  >;
  /** Closure-bound event sink backed by the host-owned trajectory recorder. */
  trajectory?: Readonly<{
    recordEvent: (type: string, data?: Record<string, unknown>) => void;
    flush: () => Promise<void>;
  }>;
  /** Closure-bound non-secret maps prepared before harness placement. */
  preparedEnvironment?: () => AgentHarnessPreparedEnvironment;
  /** Current bounded presence hint; physical activity does not identify the message source. */
  activeComputerContext?: () => string;
  /** Applies the exact host caller binding to a plugin-built tool surface. */
  bindToolSurface: (tools: AnyAgentTool[], options?: Readonly<{ cwd?: string }>) => AnyAgentTool[];
  /** Creates and binds core tools without exposing admitted-run correlation to the plugin. */
  createToolSurface?: (
    options: AgentHarnessToolSurfaceOptions,
    bindingOptions?: Readonly<{ cwd?: string }>,
  ) => AnyAgentTool[];
  /** Core-owned byte binding for a native command approval, scoped to this admitted run. */
  prepareMutableFileApproval?: (request: { command: string; cwd?: string }) => Promise<
    | {
        ok: true;
        requiresOneShot: boolean;
        revalidate: () => Promise<{ ok: true } | { ok: false; message: string }>;
      }
    | { ok: false; message: string }
  >;
  /** Runs policy with host-fixed HookContext; callers provide only the native action tuple. */
  runBeforeToolCall: (
    request: Omit<
      Parameters<(typeof import("../agent-tools.before-tool-call.js"))["runBeforeToolCallHook"]>[0],
      "approvalMode" | "ctx"
    > & {
      /** Native relays may defer approval for a correlated app-server callback. */
      approvalMode?: "request" | "defer";
      /** Action-local facts from the native runtime; host authority remains closure-bound. */
      nativeOperation?: Readonly<{ cwd?: string }>;
    },
  ) => ReturnType<(typeof import("../agent-tools.before-tool-call.js"))["runBeforeToolCallHook"]>;
  requestApproval: (request: {
    signal?: AbortSignal;
    title: string;
    description: string;
    /** Full action evidence for authenticated reviewer surfaces, not channel messages. */
    detail?: string;
    severity: "info" | "warning";
    toolName: string;
    toolCallId?: string;
    mcpTool?: { server: string; tool: string };
    /** Persistence-only proof; loss of correlation does not cancel a one-shot approval. */
    isMcpToolApprovalActive?: () => boolean;
    allowedDecisions?: ApprovalDecision[];
    timeoutMs: number;
    transportTimeoutMs?: number;
  }) => Promise<{ id?: string; decision?: ApprovalDecision | null } | undefined>;
  waitForApproval: (request: {
    approvalId: string;
    timeoutMs: number;
    transportTimeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<AgentHarnessHostApprovalResult | undefined>;
}>;
