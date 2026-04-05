import type {
  AgentCapabilities,
  AnyMessage,
  McpServer,
  SessionNotification,
  SessionConfigOption,
  SetSessionConfigOptionResponse,
  StopReason,
} from "@agentclientprotocol/sdk";
export type { McpServer, SessionNotification } from "@agentclientprotocol/sdk";
import type { PromptInput } from "./prompt-content.js";

export const EXIT_CODES = {
  SUCCESS: 0,
  ERROR: 1,
  USAGE: 2,
  TIMEOUT: 3,
  NO_SESSION: 4,
  PERMISSION_DENIED: 5,
  INTERRUPTED: 130,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export const OUTPUT_FORMATS = ["text", "json", "quiet"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const PERMISSION_MODES = ["approve-all", "approve-reads", "deny-all"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const AUTH_POLICIES = ["skip", "fail"] as const;
export type AuthPolicy = (typeof AUTH_POLICIES)[number];

export const NON_INTERACTIVE_PERMISSION_POLICIES = ["deny", "fail"] as const;
export type NonInteractivePermissionPolicy = (typeof NON_INTERACTIVE_PERMISSION_POLICIES)[number];

export const SESSION_RESUME_POLICIES = ["allow-new", "same-session-only"] as const;
export type SessionResumePolicy = (typeof SESSION_RESUME_POLICIES)[number];

export const OUTPUT_STREAMS = ["prompt", "control"] as const;
export type OutputStream = (typeof OUTPUT_STREAMS)[number];
export type AcpJsonRpcMessage = AnyMessage;
export type AcpMessageDirection = "outbound" | "inbound";

export const OUTPUT_ERROR_CODES = [
  "NO_SESSION",
  "TIMEOUT",
  "PERMISSION_DENIED",
  "PERMISSION_PROMPT_UNAVAILABLE",
  "RUNTIME",
  "USAGE",
] as const;
export type OutputErrorCode = (typeof OUTPUT_ERROR_CODES)[number];

export const OUTPUT_ERROR_ORIGINS = ["cli", "runtime", "queue", "acp"] as const;
export type OutputErrorOrigin = (typeof OUTPUT_ERROR_ORIGINS)[number];

export const QUEUE_ERROR_DETAIL_CODES = [
  "QUEUE_OWNER_CLOSED",
  "QUEUE_OWNER_SHUTTING_DOWN",
  "QUEUE_OWNER_OVERLOADED",
  "QUEUE_OWNER_GENERATION_MISMATCH",
  "QUEUE_REQUEST_INVALID",
  "QUEUE_REQUEST_PAYLOAD_INVALID_JSON",
  "QUEUE_ACK_MISSING",
  "QUEUE_DISCONNECTED_BEFORE_ACK",
  "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
  "QUEUE_PROTOCOL_INVALID_JSON",
  "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
  "QUEUE_PROTOCOL_UNEXPECTED_RESPONSE",
  "QUEUE_NOT_ACCEPTING_REQUESTS",
  "QUEUE_CONTROL_REQUEST_FAILED",
  "QUEUE_RUNTIME_PROMPT_FAILED",
] as const;
export type QueueErrorDetailCode = (typeof QUEUE_ERROR_DETAIL_CODES)[number];

export type OutputErrorAcpPayload = {
  code: number;
  message: string;
  data?: unknown;
};

export type PermissionStats = {
  requested: number;
  approved: number;
  denied: number;
  cancelled: number;
};

export type ClientOperationMethod =
  | "fs/read_text_file"
  | "fs/write_text_file"
  | "terminal/create"
  | "terminal/output"
  | "terminal/wait_for_exit"
  | "terminal/kill"
  | "terminal/release";

export type ClientOperationStatus = "running" | "completed" | "failed";

export type ClientOperation = {
  method: ClientOperationMethod;
  status: ClientOperationStatus;
  summary: string;
  details?: string;
  timestamp: string;
};

export type SessionEventLog = {
  active_path: string;
  segment_count: number;
  max_segment_bytes: number;
  max_segments: number;
  last_write_at?: string;
  last_write_error?: string | null;
};

export type PerfMetricSummary = {
  count: number;
  totalMs: number;
  maxMs: number;
};

export type PerfMetricsSnapshot = {
  counters: Record<string, number>;
  timings: Record<string, PerfMetricSummary>;
  gauges: Record<string, number>;
};

export type OutputFormatterContext = {
  sessionId: string;
};

export type OutputPolicy = {
  format: OutputFormat;
  jsonStrict: boolean;
  suppressReads: boolean;
  suppressNonJsonStderr: boolean;
  queueErrorAlreadyEmitted: boolean;
  suppressSdkConsoleErrors: boolean;
};

export type OutputErrorEmissionPolicy = {
  queueErrorAlreadyEmitted: boolean;
};

export interface OutputFormatter {
  setContext(context: OutputFormatterContext): void;
  onAcpMessage(message: AcpJsonRpcMessage): void;
  onError(params: {
    code: OutputErrorCode;
    detailCode?: string;
    origin?: OutputErrorOrigin;
    message: string;
    retryable?: boolean;
    acp?: OutputErrorAcpPayload;
    timestamp?: string;
  }): void;
  flush(): void;
}

export type AcpClientOptions = {
  agentCommand: string;
  cwd: string;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  sessionOptions?: {
    model?: string;
    allowedTools?: string[];
    maxTurns?: number;
  };
  onAcpMessage?: (direction: AcpMessageDirection, message: AcpJsonRpcMessage) => void;
  onAcpOutputMessage?: (direction: AcpMessageDirection, message: AcpJsonRpcMessage) => void;
  onSessionUpdate?: (notification: SessionNotification) => void;
  onClientOperation?: (operation: ClientOperation) => void;
};

export const SESSION_RECORD_SCHEMA = "openclaw.acpx.session.v1" as const;
export type SessionMessageImage = {
  source: string;
  size?: {
    width: number;
    height: number;
  } | null;
};

export type SessionUserContent =
  | {
      Text: string;
    }
  | {
      Mention: {
        uri: string;
        content: string;
      };
    }
  | {
      Image: SessionMessageImage;
    };

export type SessionToolUse = {
  id: string;
  name: string;
  raw_input: string;
  input: unknown;
  is_input_complete: boolean;
  thought_signature?: string | null;
};

export type SessionToolResultContent =
  | {
      Text: string;
    }
  | {
      Image: SessionMessageImage;
    };

export type SessionToolResult = {
  tool_use_id: string;
  tool_name: string;
  is_error: boolean;
  content: SessionToolResultContent;
  output?: unknown;
};

export type SessionAgentContent =
  | {
      Text: string;
    }
  | {
      Thinking: {
        text: string;
        signature?: string | null;
      };
    }
  | {
      RedactedThinking: string;
    }
  | {
      ToolUse: SessionToolUse;
    };

export type SessionUserMessage = {
  id: string;
  content: SessionUserContent[];
};

export type SessionAgentMessage = {
  content: SessionAgentContent[];
  tool_results: Record<string, SessionToolResult>;
  reasoning_details?: unknown;
};

export type SessionMessage =
  | {
      User: SessionUserMessage;
    }
  | {
      Agent: SessionAgentMessage;
    }
  | "Resume";

export type SessionTokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type SessionConversation = {
  title?: string | null;
  messages: SessionMessage[];
  updated_at: string;
  cumulative_token_usage: SessionTokenUsage;
  request_token_usage: Record<string, SessionTokenUsage>;
};

export type SessionAcpxState = {
  current_mode_id?: string;
  desired_mode_id?: string;
  current_model_id?: string;
  available_models?: string[];
  available_commands?: string[];
  config_options?: SessionConfigOption[];
  session_options?: {
    model?: string;
    allowed_tools?: string[];
    max_turns?: number;
  };
};

export type SessionRecord = {
  schema: typeof SESSION_RECORD_SCHEMA;
  acpxRecordId: string;
  acpSessionId: string;
  agentSessionId?: string;
  agentCommand: string;
  cwd: string;
  name?: string;
  createdAt: string;
  lastUsedAt: string;
  lastSeq: number;
  lastRequestId?: string;
  eventLog: SessionEventLog;
  closed?: boolean;
  closedAt?: string;
  pid?: number;
  agentStartedAt?: string;
  lastPromptAt?: string;
  lastAgentExitCode?: number | null;
  lastAgentExitSignal?: NodeJS.Signals | null;
  lastAgentExitAt?: string;
  lastAgentDisconnectReason?: string;
  protocolVersion?: number;
  agentCapabilities?: AgentCapabilities;
  title?: string | null;
  messages: SessionMessage[];
  updated_at: string;
  cumulative_token_usage: SessionTokenUsage;
  request_token_usage: Record<string, SessionTokenUsage>;
  acpx?: SessionAcpxState;
};

export type RunPromptResult = {
  stopReason: StopReason;
  permissionStats: PermissionStats;
  sessionId: string;
};

export type SessionSendResult = RunPromptResult & {
  record: SessionRecord;
  resumed: boolean;
  loadError?: string;
};

export type SessionSetModeResult = {
  record: SessionRecord;
  resumed: boolean;
  loadError?: string;
};

export type SessionSetConfigOptionResult = {
  record: SessionRecord;
  response: SetSessionConfigOptionResponse;
  resumed: boolean;
  loadError?: string;
};

export type SessionSetModelResult = {
  record: SessionRecord;
  resumed: boolean;
  loadError?: string;
};

export type SessionEnsureResult = {
  record: SessionRecord;
  created: boolean;
};

export type SessionEnqueueResult = {
  queued: true;
  sessionId: string;
  requestId: string;
};

export type SessionSendOutcome = SessionSendResult | SessionEnqueueResult;
export type { PromptInput };
