//#region extensions/codex/src/app-server/protocol.d.ts
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = {
  [key: string]: JsonValue;
};
type CodexServiceTier = string;
type CodexAppServerRequestMethod = keyof CodexAppServerRequestResultMap | (string & {});
type CodexAppServerRequestParams<M extends CodexAppServerRequestMethod> = M extends keyof CodexAppServerRequestParamsOverride ? CodexAppServerRequestParamsOverride[M] : unknown;
type CodexAppServerRequestResult<M extends CodexAppServerRequestMethod> = M extends keyof CodexAppServerRequestResultMap ? CodexAppServerRequestResultMap[M] : JsonValue | undefined;
type RpcRequest = {
  id?: number | string;
  method: string;
  params?: JsonValue;
};
type CodexInitializeResponse = {
  serverInfo?: {
    name?: string;
    version?: string;
  };
  protocolVersion?: string;
  userAgent?: string;
};
type CodexUserInput = {
  type: "text";
  text: string;
  text_elements?: JsonValue[];
} | {
  type: "image";
  url: string;
} | {
  type: "localImage";
  path: string;
};
type CodexDynamicToolSpec = JsonObject & {
  name: string;
  description: string;
  inputSchema: JsonValue;
};
type CodexTurnEnvironmentParams = JsonObject & {
  environmentId: string;
  cwd: string;
};
type CodexThreadStartParams = JsonObject & {
  input?: CodexUserInput[];
  cwd?: string;
  model?: string;
  modelProvider?: string | null;
  approvalPolicy?: string | JsonObject;
  approvalsReviewer?: string | null;
  sandbox?: string;
  serviceTier?: CodexServiceTier | null;
  dynamicTools?: CodexDynamicToolSpec[] | null;
  developerInstructions?: string;
  experimentalRawEvents?: boolean;
  environments?: CodexTurnEnvironmentParams[] | null;
  persistExtendedHistory?: boolean;
};
type CodexThreadResumeParams = JsonObject & {
  threadId: string;
  model?: string;
  modelProvider?: string | null;
  approvalPolicy?: string | JsonObject;
  approvalsReviewer?: string | null;
  sandbox?: string;
  serviceTier?: CodexServiceTier | null;
  config?: JsonObject;
  developerInstructions?: string;
  persistExtendedHistory?: boolean;
};
type CodexThreadStartResponse = {
  thread: CodexThread;
  model: string;
  modelProvider?: string | null;
};
type CodexThreadForkParams = CodexThreadStartParams & {
  threadId: string;
  baseInstructions?: string;
  ephemeral?: boolean;
  threadSource?: string | JsonObject;
  excludeTurns?: boolean;
};
type CodexThreadForkResponse = CodexThreadStartResponse;
type CodexThreadResumeResponse = {
  thread: CodexThread;
  model: string;
  modelProvider?: string | null;
};
type CodexThreadInjectItemsParams = JsonObject & {
  threadId: string;
  items: JsonValue[];
};
type CodexThreadUnsubscribeParams = JsonObject & {
  threadId: string;
};
type CodexTurnInterruptParams = JsonObject & {
  threadId: string;
  turnId: string;
};
type CodexTurnStartParams = JsonObject & {
  threadId: string;
  input?: CodexUserInput[];
  cwd?: string;
  model?: string;
  approvalPolicy?: string | JsonObject;
  approvalsReviewer?: string | null;
  sandboxPolicy?: CodexSandboxPolicy;
  serviceTier?: CodexServiceTier | null;
  effort?: string | null;
  environments?: CodexTurnEnvironmentParams[] | null;
  collaborationMode?: {
    mode: string;
    settings: JsonObject & {
      developer_instructions: string | null;
    };
  } | null;
};
type CodexSandboxPolicy = string | JsonObject;
type CodexTurnStartResponse = {
  turn: CodexTurn;
};
type CodexTurn = {
  id: string;
  threadId: string;
  status?: string;
  error?: CodexErrorNotification["error"];
  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  items: CodexThreadItem[];
};
type CodexThread = {
  id: string;
  sessionId?: string;
  name?: string | null;
  preview?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  status?: CodexThreadStatus | null;
  cwd?: string | null;
  source?: CodexSessionSource | null;
  threadSource?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
};
type CodexThreadStatus = {
  type: "notLoaded";
} | {
  type: "idle";
} | {
  type: "systemError";
} | {
  type: "active";
  activeFlags?: string[];
};
type CodexSubAgentThreadSpawnSource = {
  parent_thread_id: string;
  depth?: number;
  agent_path?: string | null;
  agent_nickname?: string | null;
  agent_role?: string | null;
};
type CodexSubAgentSource = "review" | "compact" | "memory_consolidation" | {
  thread_spawn: CodexSubAgentThreadSpawnSource;
} | {
  other: string;
};
type CodexSessionSource = "cli" | "vscode" | "exec" | "appServer" | "unknown" | {
  custom: string;
} | {
  subAgent: CodexSubAgentSource;
};
type CodexThreadItem = {
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
  contentItems?: CodexDynamicToolCallOutputContentItem[] | null;
  changes: Array<{
    path: string;
    kind: string;
  }>;
  [key: string]: unknown;
};
type CodexServerNotification = {
  method: string;
  params?: JsonValue;
};
type CodexDynamicToolCallOutputContentItem = {
  type: "inputText";
  text: string;
} | {
  type: "inputImage";
  imageUrl: string;
} | JsonObject;
type CodexErrorNotification = {
  error: {
    message?: string;
    codexErrorInfo?: {
      message?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  message?: string;
};
type CodexModel = {
  id?: string;
  model?: string;
  displayName?: string | null;
  description?: string | null;
  hidden: boolean;
  isDefault: boolean;
  inputModalities: string[];
  supportedReasoningEfforts: CodexReasoningEffortOption[];
  defaultReasoningEffort?: string | null;
};
type CodexReasoningEffortOption = {
  reasoningEffort?: string | null;
};
type CodexModelListResponse = {
  data: CodexModel[];
  nextCursor?: string | null;
};
type CodexGetAccountResponse = {
  account?: JsonValue;
  requiresOpenaiAuth?: boolean;
};
type CodexPluginSummary = {
  id: string;
  name: string;
  source?: JsonObject;
  installed: boolean;
  enabled: boolean;
  installPolicy?: string;
  authPolicy?: string;
  availability?: string;
  interface?: JsonValue;
};
type CodexAppSummary = {
  id: string;
  name: string;
  description?: string | null;
  installUrl?: string | null;
  needsAuth: boolean;
};
type CodexPluginDetail = {
  marketplaceName?: string;
  marketplacePath?: string | null;
  summary: CodexPluginSummary;
  description?: string | null;
  skills?: JsonValue[];
  apps: CodexAppSummary[];
  mcpServers: string[];
};
type CodexPluginMarketplaceEntry = {
  name: string;
  path?: string | null;
  interface?: JsonValue;
  plugins: CodexPluginSummary[];
};
type CodexPluginListResponse = {
  marketplaces: CodexPluginMarketplaceEntry[];
  marketplaceLoadErrors?: JsonValue[];
  featuredPluginIds?: string[];
};
type CodexPluginReadResponse = {
  plugin: CodexPluginDetail;
};
type CodexPluginInstallResponse = {
  authPolicy: string;
  appsNeedingAuth: CodexAppSummary[];
};
type CodexAppInfo = {
  id: string;
  name: string;
  description?: string | null;
  logoUrl?: string | null;
  logoUrlDark?: string | null;
  distributionChannel?: string | null;
  branding?: JsonValue;
  appMetadata?: JsonValue;
  labels?: JsonValue;
  installUrl?: string | null;
  isAccessible: boolean;
  isEnabled: boolean;
  pluginDisplayNames: string[];
};
type CodexAppsListResponse = {
  data: CodexAppInfo[];
  nextCursor?: string | null;
};
type CodexSkillsListResponse = {
  data: JsonValue[];
  nextCursor?: string | null;
};
type CodexHooksListResponse = {
  data: JsonValue[];
  nextCursor?: string | null;
};
type CodexMcpServerStatus = {
  name: string;
  tools: JsonObject;
};
type CodexListMcpServerStatusResponse = {
  data: CodexMcpServerStatus[];
  nextCursor?: string | null;
};
type CodexAppServerRequestParamsOverride = {
  "environment/add": {
    environmentId: string;
    execServerUrl: string;
  };
  "thread/fork": CodexThreadForkParams;
  "thread/inject_items": CodexThreadInjectItemsParams;
  "thread/start": CodexThreadStartParams;
  "thread/unsubscribe": CodexThreadUnsubscribeParams;
  "turn/interrupt": CodexTurnInterruptParams;
};
type CodexAppServerRequestResultMap = {
  initialize: CodexInitializeResponse;
  "account/rateLimits/read": JsonValue;
  "account/read": CodexGetAccountResponse;
  "app/list": CodexAppsListResponse;
  "config/mcpServer/reload": JsonValue;
  "environment/add": JsonValue;
  "experimentalFeature/enablement/set": JsonValue;
  "feedback/upload": JsonValue;
  "hooks/list": CodexHooksListResponse;
  "marketplace/add": JsonValue;
  "mcpServerStatus/list": CodexListMcpServerStatusResponse;
  "model/list": CodexModelListResponse;
  "plugin/install": CodexPluginInstallResponse;
  "plugin/list": CodexPluginListResponse;
  "plugin/read": CodexPluginReadResponse;
  "review/start": JsonValue;
  "skills/list": CodexSkillsListResponse;
  "thread/compact/start": JsonValue;
  "thread/fork": CodexThreadForkResponse;
  "thread/inject_items": JsonValue;
  "thread/list": JsonValue;
  "thread/resume": CodexThreadResumeResponse;
  "thread/start": CodexThreadStartResponse;
  "thread/unsubscribe": JsonValue;
  "turn/interrupt": JsonValue;
  "turn/start": CodexTurnStartResponse;
  "turn/steer": JsonValue;
};
//#endregion
//#region extensions/codex/src/app-server/config.d.ts
type CodexAppServerTransportMode = "stdio" | "websocket";
type CodexAppServerPolicyMode = "yolo" | "guardian";
type CodexAppServerApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";
type CodexAppServerEffectiveApprovalPolicy = CodexAppServerApprovalPolicy | {
  granular: {
    mcp_elicitations: boolean;
    rules: boolean;
    sandbox_approval: boolean;
    request_permissions?: boolean;
    skill_approval?: boolean;
  };
};
type CodexAppServerSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type CodexAppServerApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
type CodexAppServerCommandSource = "managed" | "resolved-managed" | "config" | "env";
type CodexDynamicToolsLoading = "searchable" | "direct";
type CodexPluginDestructivePolicy = boolean;
type CodexComputerUseConfig = {
  enabled?: boolean;
  autoInstall?: boolean;
  marketplaceDiscoveryTimeoutMs?: number;
  marketplaceSource?: string;
  marketplacePath?: string;
  marketplaceName?: string;
  pluginName?: string;
  mcpServerName?: string;
};
type CodexPluginEntryConfig = {
  enabled?: boolean;
  marketplaceName?: string;
  pluginName?: string;
  allow_destructive_actions?: CodexPluginDestructivePolicy;
};
type CodexPluginsConfig = {
  enabled?: boolean;
  allow_destructive_actions?: CodexPluginDestructivePolicy;
  plugins?: Record<string, CodexPluginEntryConfig>;
};
type CodexAppServerExperimentalConfig = {
  sandboxExecServer?: boolean;
};
type CodexAppServerStartOptions = {
  transport: CodexAppServerTransportMode;
  command: string;
  commandSource?: CodexAppServerCommandSource;
  args: string[];
  url?: string;
  authToken?: string;
  headers: Record<string, string>;
  env?: Record<string, string>;
  clearEnv?: string[];
};
type CodexAppServerRuntimeOptions = {
  start: CodexAppServerStartOptions;
  codeModeOnly: boolean;
  requestTimeoutMs: number;
  turnCompletionIdleTimeoutMs: number;
  postToolRawAssistantCompletionIdleTimeoutMs?: number;
  approvalPolicy: CodexAppServerEffectiveApprovalPolicy;
  sandbox: CodexAppServerSandboxMode;
  approvalsReviewer: CodexAppServerApprovalsReviewer;
  serviceTier?: CodexServiceTier;
};
type CodexPluginConfig = {
  codexDynamicToolsLoading?: CodexDynamicToolsLoading;
  codexDynamicToolsExclude?: string[];
  discovery?: {
    enabled?: boolean;
    timeoutMs?: number;
  };
  computerUse?: CodexComputerUseConfig;
  codexPlugins?: CodexPluginsConfig;
  appServer?: {
    mode?: CodexAppServerPolicyMode;
    transport?: CodexAppServerTransportMode;
    command?: string;
    args?: string[] | string;
    url?: string;
    authToken?: string;
    headers?: Record<string, string>;
    clearEnv?: string[];
    codeModeOnly?: boolean;
    requestTimeoutMs?: number;
    turnCompletionIdleTimeoutMs?: number;
    postToolRawAssistantCompletionIdleTimeoutMs?: number;
    approvalPolicy?: CodexAppServerApprovalPolicy;
    sandbox?: CodexAppServerSandboxMode;
    approvalsReviewer?: CodexAppServerApprovalsReviewer;
    serviceTier?: CodexServiceTier | null;
    defaultWorkspaceDir?: string;
    experimental?: CodexAppServerExperimentalConfig;
  };
};
//#endregion
//#region extensions/codex/src/app-server/transport.d.ts
type CodexAppServerTransport = {
  stdin: {
    write: (data: string, callback?: (error?: Error | null) => void) => unknown;
    end?: () => unknown;
    destroy?: () => unknown;
    unref?: () => unknown;
    on?: (event: "error", listener: (error: Error) => void) => unknown;
  };
  stdout: NodeJS.ReadableStream & {
    destroy?: () => unknown;
    unref?: () => unknown;
  };
  stderr: NodeJS.ReadableStream & {
    destroy?: () => unknown;
    unref?: () => unknown;
  };
  pid?: number;
  exitCode?: number | null;
  signalCode?: string | null;
  killed?: boolean;
  kill?: (signal?: NodeJS.Signals) => unknown;
  unref?: () => unknown;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
};
//#endregion
//#region extensions/codex/src/app-server/client.d.ts
type CodexServerRequestHandler = (request: Required<Pick<RpcRequest, "id" | "method">> & {
  params?: JsonValue;
}) => Promise<JsonValue | undefined> | JsonValue | undefined;
type CodexServerNotificationHandler = (notification: CodexServerNotification) => Promise<void> | void;
declare class CodexAppServerClient {
  private readonly child;
  private readonly lines;
  private readonly pending;
  private readonly requestHandlers;
  private readonly notificationHandlers;
  private readonly closeHandlers;
  private nextId;
  private initialized;
  private closed;
  private closeError;
  private serverVersion;
  private stderrTail;
  private pendingParse;
  private constructor();
  static start(options?: Partial<CodexAppServerStartOptions>): CodexAppServerClient;
  static fromTransportForTests(child: CodexAppServerTransport): CodexAppServerClient;
  initialize(): Promise<void>;
  getServerVersion(): string | undefined;
  request<M extends CodexAppServerRequestMethod>(method: M, params: CodexAppServerRequestParams<M>, options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<CodexAppServerRequestResult<M>>;
  request<T = JsonValue | undefined>(method: string, params?: unknown, options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<T>;
  notify(method: string, params?: JsonValue): void;
  addRequestHandler(handler: CodexServerRequestHandler): () => void;
  addNotificationHandler(handler: CodexServerNotificationHandler): () => void;
  addCloseHandler(handler: (client: CodexAppServerClient) => void): () => void;
  close(): void;
  closeAndWait(options?: {
    exitTimeoutMs?: number;
    forceKillDelayMs?: number;
  }): Promise<void>;
  private writeMessage;
  private handleLine;
  private handlePendingParseLine;
  private handleParsedMessage;
  private handleResponse;
  private handleServerRequest;
  private runServerRequestHandlers;
  private runServerRequestHandlersWithoutTimeout;
  private handleNotification;
  private closeWithError;
  private markClosed;
  private rejectPendingRequests;
}
//#endregion
export { CodexDynamicToolSpec as a, CodexThreadStartParams as c, JsonObject as d, CodexPluginConfig as i, CodexTurnEnvironmentParams as l, CodexAppServerRuntimeOptions as n, CodexSandboxPolicy as o, CodexAppServerStartOptions as r, CodexThreadResumeParams as s, CodexAppServerClient as t, CodexTurnStartParams as u };