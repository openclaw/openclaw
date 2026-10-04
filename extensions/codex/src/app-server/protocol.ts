import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexCommandExecParams, CodexCommandExecResponse } from "./command-exec-protocol.js";
import type * as Control from "./protocol-control-plane.js";
import type { JsonObject, JsonValue } from "./protocol-json.js";
import type * as CodexMcpProtocol from "./protocol-mcp.js";
import type { CodexSessionSource, CodexThreadSourceKind } from "./protocol-session-source.js";

export type {
  CodexConfigReadResponse,
  CodexConfigRequirementsReadResponse,
  CodexPluginDetail,
  CodexPluginListResponse,
  CodexPluginReadResponse,
} from "./protocol-control-plane.js";
export type { CodexListMcpServerStatusResponse, CodexMcpServerStatus } from "./protocol-mcp.js";
export {
  CODEX_INTERACTIVE_CUSTOM_THREAD_SOURCES,
  CODEX_INTERACTIVE_THREAD_SOURCE_KINDS,
} from "./protocol-session-source.js";
export type { CodexSessionSource } from "./protocol-session-source.js";
export { isRpcResponse } from "./protocol-json.js";
export type {
  JsonObject,
  JsonValue,
  RpcMessage,
  RpcRequest,
  RpcResponse,
} from "./protocol-json.js";

export type CodexServiceTier = string;
export type CodexApprovalPolicy =
  | "untrusted"
  | "on-request"
  | {
      granular: {
        sandbox_approval: boolean;
        rules: boolean;
        skill_approval: boolean;
        request_permissions: boolean;
        mcp_elicitations: boolean;
      };
    }
  | "never";
export type CodexApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type CodexPersonality = "none" | "friendly" | "pragmatic";

export type CodexAppServerRequestMethod = keyof CodexAppServerRequests | (string & {});
export type CodexAppServerRequestParams<M extends CodexAppServerRequestMethod> =
  M extends keyof CodexAppServerRequests ? CodexAppServerRequests[M]["params"] : unknown;

export type CodexAppServerRequestResult<M extends CodexAppServerRequestMethod> =
  M extends keyof CodexAppServerRequests
    ? CodexAppServerRequests[M]["result"]
    : JsonValue | undefined;

export type CodexInitializeParams = {
  clientInfo: {
    name: string;
    title?: string;
    version?: string;
  };
  capabilities?: JsonObject;
};

export type CodexInitializeResponse = {
  serverInfo?: {
    name?: string;
    version?: string;
  };
  protocolVersion?: string;
  userAgent?: string;
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
};

export type CodexUserInput =
  | {
      type: "text";
      text: string;
      text_elements: Array<{
        byteRange: { start: number; end: number };
        placeholder: string | null;
      }>;
    }
  | {
      type: "image";
      url: string;
    }
  | {
      type: "localImage";
      path: string;
    }
  | {
      type: "skill";
      name: string;
      path: string;
    };

export type CodexDynamicToolFunctionSpec = JsonObject & {
  type: "function";
  name: string;
  description: string;
  inputSchema: JsonValue;
  deferLoading?: boolean;
};

/** Namespace Codex keeps directly model-visible without exposing it to Code Mode guests. */
export const CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE = "openclaw_direct";

type CodexDynamicToolNamespaceSpec = JsonObject & {
  type: "namespace";
  name: string;
  description: string;
  tools: CodexDynamicToolFunctionSpec[];
};

export type CodexDynamicToolSpec = CodexDynamicToolFunctionSpec | CodexDynamicToolNamespaceSpec;

export function flattenCodexDynamicToolFunctions(
  tools: readonly CodexDynamicToolSpec[] | undefined,
): CodexDynamicToolFunctionSpec[] {
  return (tools ?? []).flatMap((tool) => (tool.type === "namespace" ? tool.tools : [tool]));
}

export type CodexTurnEnvironmentParams = JsonObject & {
  environmentId: string;
  cwd: string;
};

export type CodexThreadStartParams = JsonObject & {
  threadSource?: string | null;
  input?: CodexUserInput[];
  cwd?: string;
  projectId?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  model?: string;
  modelProvider?: string | null;
  config?: JsonObject;
  personality?: CodexPersonality | null;
  approvalPolicy?: CodexApprovalPolicy | null;
  approvalsReviewer?: CodexApprovalsReviewer | null;
  sandbox?: CodexSandboxMode | null;
  serviceTier?: CodexServiceTier | null;
  dynamicTools?: CodexDynamicToolSpec[] | null;
  developerInstructions?: string;
  experimentalRawEvents?: boolean;
  environments?: CodexTurnEnvironmentParams[] | null;
  ephemeral?: boolean;
};

export type CodexThreadResumeParams = JsonObject & {
  threadId: string;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  model?: string;
  modelProvider?: string | null;
  personality?: CodexPersonality | null;
  approvalPolicy?: CodexApprovalPolicy | null;
  approvalsReviewer?: CodexApprovalsReviewer | null;
  sandbox?: CodexSandboxMode | null;
  serviceTier?: CodexServiceTier | null;
  config?: JsonObject;
  developerInstructions?: string;
  excludeTurns?: boolean;
  initialTurnsPage?: {
    limit?: number | null;
    sortDirection?: "asc" | "desc" | null;
    itemsView?: "notLoaded" | "summary" | "full" | null;
  } | null;
};

export type CodexThreadStartResponse = {
  thread: CodexThread;
  model: string;
  modelProvider?: string | null;
};

export type CodexThreadForkParams = JsonObject & {
  threadId: string;
  lastTurnId?: string | null;
  beforeTurnId?: string | null;
  path?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: CodexServiceTier | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: CodexApprovalPolicy | null;
  approvalsReviewer?: CodexApprovalsReviewer | null;
  sandbox?: CodexSandboxMode | null;
  permissions?: string | null;
  config?: JsonObject | null;
  baseInstructions?: string;
  developerInstructions?: string;
  ephemeral?: boolean;
  threadSource?: string | null;
  excludeTurns?: boolean;
};

/** Asserts the experimental beforeTurnId request field before it crosses the app-server boundary. */
export function assertCodexThreadForkParams(value: unknown): CodexThreadForkParams {
  if (
    !isRecord(value) ||
    typeof value.threadId !== "string" ||
    !value.threadId.trim() ||
    (value.beforeTurnId !== undefined &&
      value.beforeTurnId !== null &&
      typeof value.beforeTurnId !== "string")
  ) {
    throw new Error("Invalid Codex app-server thread/fork params");
  }
  // SAFETY: The required id and optional fork boundary are checked; native Codex validates other options.
  return value as CodexThreadForkParams;
}

export type CodexThreadForkResponse = CodexThreadStartResponse;

export type CodexThreadListParams = JsonObject & {
  cursor?: string | null;
  limit?: number | null;
  modelProviders?: string[] | null;
  sortKey?: "created_at" | "updated_at" | "recency_at" | null;
  sortDirection?: "asc" | "desc" | null;
  archived?: boolean | null;
  cwd?: string | string[] | null;
  useStateDbOnly?: boolean;
  searchTerm?: string | null;
  sourceKinds?: CodexThreadSourceKind[] | null;
  parentThreadId?: string | null;
  ancestorThreadId?: string | null;
};

export type CodexThreadListResponse = {
  data: CodexThread[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
};

export type CodexThreadTurnsListParams = JsonObject & {
  threadId: string;
  cursor?: string | null;
  limit?: number | null;
  sortDirection?: "asc" | "desc" | null;
  itemsView?: "notLoaded" | "summary" | "full" | null;
};

export type CodexThreadTurnsListResponse = {
  data: CodexTurn[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
};

export type CodexThreadItemsListParams = JsonObject & {
  threadId: string;
  cursor?: string;
  limit: number;
  sortDirection: "desc";
};

export type CodexThreadItemsListResponse = {
  data: Array<{ turnId: string; item: CodexThreadItem }>;
  nextCursor?: string | null;
};

type CodexThreadIdParams = JsonObject & { threadId: string };

type CodexInitialTurnsPage = Omit<CodexThreadTurnsListResponse, "data"> & {
  data: Pick<CodexTurn, "id" | "status">[];
};

export type CodexThreadResumeResponse = CodexThreadStartResponse & {
  cwd: string;
  initialTurnsPage?: CodexInitialTurnsPage | null;
};

type CodexThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

type CodexThreadGoal = {
  threadId: string;
  objective: string;
  status: CodexThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

type CodexThreadGoalSetParams = JsonObject & {
  threadId: string;
  objective?: string;
  status?: CodexThreadGoalStatus;
  tokenBudget?: number | null;
};

export type CodexTurnStartParams = JsonObject & {
  threadId: string;
  turnTrigger?: string | null;
  input: CodexUserInput[];
  /** Native 0.153.4 flattens these entries into its Responses turn-metadata object. */
  responsesapiClientMetadata?: Record<string, string> | null;
  additionalContext?: Record<string, { kind: "untrusted" | "application"; value: string }>;
  cwd?: string;
  runtimeWorkspaceRoots?: string[] | null;
  model?: string;
  approvalPolicy?: CodexApprovalPolicy | null;
  approvalsReviewer?: CodexApprovalsReviewer | null;
  sandboxPolicy?: CodexSandboxPolicy;
  serviceTier?: CodexServiceTier | null;
  effort?: string | null;
  personality?: CodexPersonality | null;
  environments?: CodexTurnEnvironmentParams[] | null;
  collaborationMode?: {
    mode: "plan" | "default";
    settings: {
      model: string;
      reasoning_effort: string | null;
      developer_instructions: string | null;
    };
  } | null;
};

export type CodexSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "externalSandbox"; networkAccess: "restricted" | "enabled" }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

export type CodexTurnStartResponse = {
  turn: CodexTurn;
};

type CodexTurnSteerParams = JsonObject &
  Pick<CodexTurnStartParams, "threadId" | "input" | "additionalContext"> & {
    expectedTurnId: string;
  };

export type CodexTurn = {
  id: string;
  threadId?: string;
  status?: string;
  error?: CodexErrorNotification["error"] | null;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  items: CodexThreadItem[];
};

export type CodexThread = {
  id: string;
  ephemeral?: boolean;
  cliVersion?: string | null;
  gitInfo?: { sha?: string | null; branch?: string | null; originUrl?: string | null } | null;
  forkedFromId?: string | null;
  parentThreadId?: string | null;
  sessionId?: string;
  path?: string | null;
  projectId: string | null;
  historyMode?: "legacy" | "paginated";
  extra?: JsonObject | null;
  name?: string | null;
  preview?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  recencyAt?: number | null;
  status?: CodexThreadStatus | null;
  canAcceptDirectInput?: boolean | null;
  /** Codex 0.153+: current loaded selection, otherwise latest persisted model. */
  model?: string | null;
  modelProvider?: string | null;
  /** Native creation-time provenance; unavailable on older or incomplete records. */
  originator?: string | null;
  cwd?: string | null;
  source?: CodexSessionSource | null;
  threadSource?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
  turns?: CodexTurn[];
};

export type CodexThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags?: string[] };

export type CodexThreadItem = {
  id: string;
  type: string;
  title: string | null;
  status: string | null;
  name: string | null;
  tool: string | null;
  server: string | null;
  command: string | null;
  cwd: string | null;
  query: string | null;
  arguments?: JsonValue;
  result?: JsonValue;
  error?: CodexErrorNotification["error"];
  exitCode?: number | null;
  durationMs?: number | null;
  aggregatedOutput: string | null;
  text: string;
  delivery?: "async" | null;
  contentItems?: CodexDynamicToolCallOutputContentItem[] | null;
  changes: Array<{ path: string; kind: string }>;
  [key: string]: unknown;
};

type CodexStrictReviewRequiredNotification = {
  method: "autoApprovalReview/strictReviewRequired";
  params: JsonObject & {
    threadId: string;
    turnId: string;
    startedAtMs: number;
  };
};

export type CodexServerNotification =
  | CodexStrictReviewRequiredNotification
  | {
      method: string;
      params?: JsonValue;
    };

export type CodexDynamicToolCallParams = {
  namespace?: string | null;
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments?: JsonValue;
};

export type CodexDynamicToolCallResponse = {
  contentItems: CodexDynamicToolCallOutputContentItem[];
  success: boolean;
};

export type CodexDynamicToolDiagnosticTerminalType = "blocked" | "completed" | "error";
export type CodexDynamicToolDiagnosticTerminalReason = "failed" | "cancelled" | "timed_out";

export type CodexDynamicToolCallOutputContentItem =
  | {
      type: "inputText";
      text: string;
    }
  | {
      type: "inputImage";
      imageUrl: string;
    }
  | JsonObject;

// Mirrors v2 ErrorNotification/TurnError (codex-rs app-server-protocol
// notification.rs + thread_data.rs). `message` is required upstream; other
// TurnError fields stay open because CodexErrorInfo is a wide enum.
export type CodexErrorNotification = {
  error: {
    message?: string;
    codexErrorInfo?: "misalignmentPolicyViolation" | (string & {}) | JsonObject | null;
    additionalDetails?: string | null;
    misalignment?: {
      errorType?: string | null;
      detailedExplanation?: string | null;
      steer?: { message: string } | null;
    } | null;
    [key: string]: unknown;
  };
  willRetry?: boolean;
  threadId?: string;
  turnId?: string;
};

export type CodexTurnCompletedNotification = CodexTurnStartResponse;

export type CodexModel = {
  id?: string;
  model?: string;
  displayName?: string | null;
  description?: string | null;
  hidden: boolean;
  isDefault: boolean;
  inputModalities: string[];
  serviceTiers?: { id: string; name: string; description: string }[];
  supportedReasoningEfforts: CodexReasoningEffortOption[];
  defaultReasoningEffort?: string | null;
  multiAgentVersion?: "disabled" | "v1" | "v2" | null;
};

type CodexReasoningEffortOption = {
  reasoningEffort?: string | null;
};

export type CodexModelListResponse = {
  data: CodexModel[];
  nextCursor?: string | null;
};

export type CodexGetAccountResponse = {
  account?:
    | { type: "apiKey" }
    | { type: "chatgpt"; email: string | null; planType: string }
    | { type: "amazonBedrock"; usesCodexManagedCredentials?: boolean }
    | null;
  requiresOpenaiAuth: boolean;
};

type CodexModelProviderCapabilitiesReadResponse = {
  namespaceTools: boolean;
  imageGeneration: boolean;
  webSearch: boolean;
};

export type CodexChatgptAuthTokensRefreshResponse = {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: string | null;
};

export type CodexLoginAccountParams =
  | {
      type: "apiKey";
      apiKey: string;
    }
  | (CodexChatgptAuthTokensRefreshResponse & { type: "chatgptAuthTokens" });

export type CodexRequestObject = Record<string, unknown>;

export declare namespace v2 {
  export type AppInfo = Control.CodexAppInfo;
  export type AppSummary = Control.CodexAppSummary;
  export type AppsInstalledResponse = Control.CodexAppsInstalledResponse;
  export type InstalledApp = Control.CodexInstalledApp;
  export type PluginDetail = Control.CodexPluginDetail;
  export type PluginInstalledParams = Control.CodexPluginInstalledParams;
  export type PluginInstalledResponse = Control.CodexPluginInstalledResponse;
  export type PluginInstallParams = Control.CodexPluginInstallParams;
  export type PluginInstallResponse = Control.CodexPluginInstallResponse;
  export type PluginListParams = Control.CodexPluginListParams;
  export type PluginListResponse = Control.CodexPluginListResponse;
  export type PluginMarketplaceEntry = Control.CodexPluginMarketplaceEntry;
  export type PluginReadParams = Control.CodexPluginReadParams;
  export type PluginReadResponse = Control.CodexPluginReadResponse;
  export type PluginSummary = Control.CodexPluginSummary;
}

type CodexRequestContract<Params, Result> = { params: Params; result: Result };

// Each wire method owns its request and response together. Unmodeled params remain unknown.
type CodexAppServerRequests = {
  "thread/backgroundTerminals/list": CodexRequestContract<
    { threadId: string; limit?: number },
    { data: { itemId: string; processId: string }[] }
  >;
  "thread/backgroundTerminals/terminate": CodexRequestContract<
    { threadId: string; processId: string },
    { terminated: boolean }
  >;
  initialize: CodexRequestContract<unknown, CodexInitializeResponse>;
  "account/rateLimits/read": CodexRequestContract<unknown, JsonValue>;
  "account/read": CodexRequestContract<unknown, CodexGetAccountResponse>;
  "app/installed": CodexRequestContract<
    Control.CodexAppsInstalledParams,
    Control.CodexAppsInstalledResponse
  >;
  "app/list": CodexRequestContract<Control.CodexAppsListParams, Control.CodexAppsListResponse>;
  "app/read": CodexRequestContract<Control.CodexAppsReadParams, Control.CodexAppsReadResponse>;
  "command/exec": CodexRequestContract<CodexCommandExecParams, CodexCommandExecResponse>;
  "config/batchWrite": CodexRequestContract<
    Control.CodexConfigBatchWriteParams,
    Control.CodexConfigWriteResponse
  >;
  "config/mcpServer/reload": CodexRequestContract<unknown, JsonValue>;
  "config/read": CodexRequestContract<
    Control.CodexConfigReadParams,
    Control.CodexConfigReadResponse
  >;
  "configRequirements/read": CodexRequestContract<
    unknown,
    Control.CodexConfigRequirementsReadResponse
  >;
  "config/value/write": CodexRequestContract<
    Control.CodexConfigValueWriteParams,
    Control.CodexConfigWriteResponse
  >;
  "environment/add": CodexRequestContract<
    { environmentId: string; execServerUrl: string },
    JsonValue
  >;
  "experimentalFeature/list": CodexRequestContract<
    Control.CodexExperimentalFeatureListParams,
    Control.CodexExperimentalFeatureListResponse
  >;
  "experimentalFeature/enablement/set": CodexRequestContract<unknown, JsonValue>;
  "feedback/upload": CodexRequestContract<unknown, JsonValue>;
  "hooks/list": CodexRequestContract<unknown, Control.CodexHooksListResponse>;
  "marketplace/add": CodexRequestContract<unknown, JsonValue>;
  "mcpServerStatus/list": CodexRequestContract<
    unknown,
    CodexMcpProtocol.CodexListMcpServerStatusResponse
  >;
  "mcpServer/resource/read": CodexRequestContract<
    CodexMcpProtocol.ResourceReadParams,
    CodexMcpProtocol.ResourceReadResult
  >;
  "mcpServer/tool/call": CodexRequestContract<
    CodexMcpProtocol.ToolCallParams,
    CodexMcpProtocol.ToolCallResult
  >;
  "model/list": CodexRequestContract<unknown, CodexModelListResponse>;
  "modelProvider/capabilities/read": CodexRequestContract<
    unknown,
    CodexModelProviderCapabilitiesReadResponse
  >;
  "plugin/installed": CodexRequestContract<
    Control.CodexPluginInstalledParams,
    Control.CodexPluginInstalledResponse
  >;
  "plugin/install": CodexRequestContract<
    Control.CodexPluginInstallParams,
    Control.CodexPluginInstallResponse
  >;
  "plugin/list": CodexRequestContract<
    Control.CodexPluginListParams,
    Control.CodexPluginListResponse
  >;
  "plugin/read": CodexRequestContract<
    Control.CodexPluginReadParams,
    Control.CodexPluginReadResponse
  >;
  "review/start": CodexRequestContract<unknown, JsonValue>;
  "skills/list": CodexRequestContract<unknown, Control.CodexSkillsListResponse>;
  "thread/compact/start": CodexRequestContract<unknown, JsonValue>;
  "thread/archive": CodexRequestContract<CodexThreadIdParams, JsonValue>;
  "thread/delete": CodexRequestContract<CodexThreadIdParams, Record<string, never>>;
  "thread/fork": CodexRequestContract<CodexThreadForkParams, CodexThreadForkResponse>;
  "thread/inject_items": CodexRequestContract<
    JsonObject & { threadId: string; items: JsonValue[] },
    JsonValue
  >;
  "thread/list": CodexRequestContract<CodexThreadListParams, CodexThreadListResponse>;
  "thread/turns/list": CodexRequestContract<
    CodexThreadTurnsListParams,
    CodexThreadTurnsListResponse
  >;
  "thread/items/list": CodexRequestContract<
    CodexThreadItemsListParams,
    CodexThreadItemsListResponse
  >;
  "thread/name/set": CodexRequestContract<
    JsonObject & { threadId: string; name: string },
    JsonValue
  >;
  "thread/read": CodexRequestContract<
    JsonObject & { threadId: string; includeTurns?: boolean },
    { thread: CodexThread }
  >;
  "thread/resume": CodexRequestContract<CodexThreadResumeParams, CodexThreadResumeResponse>;
  "thread/start": CodexRequestContract<CodexThreadStartParams, CodexThreadStartResponse>;
  "thread/unarchive": CodexRequestContract<CodexThreadIdParams, { thread: CodexThread }>;
  "thread/unsubscribe": CodexRequestContract<CodexThreadIdParams, JsonValue>;
  "thread/goal/set": CodexRequestContract<CodexThreadGoalSetParams, { goal: CodexThreadGoal }>;
  "thread/goal/get": CodexRequestContract<CodexThreadIdParams, { goal: CodexThreadGoal | null }>;
  "thread/goal/clear": CodexRequestContract<CodexThreadIdParams, { cleared: boolean }>;
  "turn/interrupt": CodexRequestContract<
    JsonObject & { threadId: string; turnId: string },
    JsonValue
  >;
  "turn/start": CodexRequestContract<CodexTurnStartParams, CodexTurnStartResponse>;
  "turn/steer": CodexRequestContract<CodexTurnSteerParams, { turnId: string }>;
};

export function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}
