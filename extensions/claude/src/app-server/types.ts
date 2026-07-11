/**
 * Codex-shaped JSON-RPC protocol types that the @zeroaltitude/openclaw-claude-bridge
 * binary speaks. Field names mirror openclaw/extensions/codex/src/app-server/
 * protocol.ts so the same OpenClaw harness pattern works for both providers.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export type RpcId = number | string;

export type RpcRequest = {
  jsonrpc?: "2.0";
  id?: RpcId;
  method: string;
  params?: unknown;
};

export type RpcResponse = {
  jsonrpc?: "2.0";
  id: RpcId;
  result?: JsonValue;
  error?: { code: number; message: string; data?: JsonValue };
};

export type RpcNotification = {
  jsonrpc?: "2.0";
  method: string;
  params?: JsonValue;
};

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

export type ApprovalPolicy = "never" | "untrusted" | "on-failure" | "on-request";

export type SandboxPolicy = { type: string; [key: string]: unknown };

export type UserInput =
  | { type: "text"; text: string; text_elements?: JsonValue[] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

export type DynamicToolSpec = {
  name: string;
  description: string;
  inputSchema: JsonValue;
  /**
   * Optional MCP namespace for the tool. Used by codex-style searchable
   * tool routing: clients that group deferred-loadable tools under a
   * namespace can address them as `<namespace>.<name>`. The claude bridge
   * sets this to "openclaw" for searchable tools so SDK consumers that
   * grow namespace support can find them without eager registration.
   */
  namespace?: string;
  /**
   * Hint to the SDK / MCP layer that this tool should NOT be registered
   * eagerly at thread/start — it should be discoverable on demand via a
   * search/lookup tool. The Anthropic claude-agent-sdk does not yet
   * implement deferred loading natively (see KNOWN LIMITATION in
   * extensions/claude/README.md); the flag is forwarded so that future
   * SDK support, or a server-side search-meta-tool implementation, can
   * honor it without a protocol bump.
   */
  deferLoading?: boolean;
};

export type DynamicToolCallParams = {
  namespace?: string | null;
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments?: JsonValue;
};

export type DynamicToolCallOutputContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string }
  | JsonObject;

export type DynamicToolCallResponse = {
  contentItems: DynamicToolCallOutputContentItem[];
  success: boolean;
};

export type ThreadStartParams = {
  cwd?: string;
  model?: string;
  modelProvider?: string;
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: "user" | "auto_review";
  sandbox?: SandboxPolicy;
  serviceTier?: string | null;
  dynamicTools?: DynamicToolSpec[];
  developerInstructions?: string;
  config?: JsonObject;
  /**
   * Plugin-supplied native (Claude Code preset) tool names to block for
   * this thread. Merged on the server with the env-derived default
   * (OPENCLAW_CLAUDE_APP_SERVER_DISALLOWED_TOOLS, typically "Agent,Task").
   * Use this to project OpenClaw's `disableTools` / restrictive
   * `toolsAllow` policy onto the SDK's native tools, which bypass the
   * dynamic-tools bridge.
   */
  disallowedTools?: string[];
};

export type ThreadResumeParams = {
  threadId: string;
  model?: string;
  modelProvider?: string;
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: "user" | "auto_review";
  sandbox?: SandboxPolicy;
  /**
   * Updated workspace pin. When set, the server patches meta.cwd so
   * subsequent turns get the new path without a thread rotation. Used by
   * the plugin when openclaw's resolveSandboxContext switches the
   * effectiveWorkspace mid-session.
   */
  cwd?: string;
};

export type TurnStartParams = {
  threadId: string;
  input: UserInput[];
  cwd?: string;
  model?: string;
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /**
   * Per-turn Fast mode opt-in. Forwarded verbatim to the claude-bridge,
   * which threads it into the Claude Agent SDK's `settings.fastMode`.
   * The caller (run-attempt) is responsible for checking model capability
   * (`supportsFastMode`) before setting this — the bridge does not re-gate.
   * Bridge >= 0.2.8.
   */
  fastMode?: boolean;
  /**
   * Set when this thread is known one-shot (heartbeat/cron/subagent-dispatched
   * — never reused for a follow-up turn), so the bridge can close its
   * subprocess immediately after this turn instead of holding it idle until
   * the query-thread-timeout sweep. Bridge >= 0.3.1; older bridges ignore the
   * field (JSON passthrough) and fall back to the idle-sweep default.
   */
  oneShot?: boolean;
};

export type TurnInterruptParams = { threadId: string; turnId: string };

export type Thread = {
  id: string;
  sessionId: string;
  cliVersion: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  ephemeral: boolean;
  modelProvider: string;
  preview: string;
  source: string | { custom: string };
  status: { type: string; [key: string]: unknown };
  turns: unknown[];
  [key: string]: unknown;
};

export type ThreadStartResponse = {
  thread: Thread;
  model: string;
  modelProvider: string;
  cwd: string;
  approvalPolicy: unknown;
  approvalsReviewer: string;
  sandbox: SandboxPolicy;
};

export type ThreadItem = {
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
  text: string;
  changes: Array<{ path: string; kind: string }>;
  aggregatedOutput: string | null;
  [key: string]: unknown;
};

export type Turn = {
  id: string;
  threadId?: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  items: ThreadItem[];
  error?: { message: string; [key: string]: unknown } | null;
};
