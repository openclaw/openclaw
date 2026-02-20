/**
 * Stream-JSON protocol types for Claude Code CLI (v2.1.41+).
 *
 * The CLI uses NDJSON (newline-delimited JSON) over stdin/stdout when invoked
 * with `-p --output-format stream-json --input-format stream-json --verbose`.
 *
 * These types are derived from empirical analysis of the CLI source. The npm
 * package does not export protocol types — only tool input schemas.
 */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export type ClaudeCodeUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

// ---------------------------------------------------------------------------
// Messages FROM Claude Code (stdout)
// ---------------------------------------------------------------------------

/** System message — session init, status, hooks, task notifications. */
export type CCSystemMessage =
  | CCSystemInitMessage
  | CCSystemStatusMessage
  | CCSystemHookStartedMessage
  | CCSystemHookProgressMessage
  | CCSystemHookResponseMessage
  | CCSystemTaskNotificationMessage;

export type CCSystemInitMessage = {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  tools: string[];
  mcp_servers: unknown[];
  model: string;
  permissionMode?: string;
  claude_code_version?: string;
  agents?: string[];
  skills?: string[];
  plugins?: string[];
  uuid: string;
};

export type CCSystemStatusMessage = {
  type: "system";
  subtype: "status";
  status: string | null;
  permissionMode?: string;
  uuid: string;
  session_id: string;
};

export type CCSystemHookStartedMessage = {
  type: "system";
  subtype: "hook_started";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  uuid: string;
  session_id: string;
};

export type CCSystemHookProgressMessage = {
  type: "system";
  subtype: "hook_progress";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  output?: string;
  uuid: string;
  session_id: string;
};

export type CCSystemHookResponseMessage = {
  type: "system";
  subtype: "hook_response";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  output?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  outcome?: string;
  uuid: string;
  session_id: string;
};

export type CCSystemTaskNotificationMessage = {
  type: "system";
  subtype: "task_notification";
  task_id: string;
  status: "completed" | "failed" | "stopped";
  output_file?: string;
  summary?: string;
  uuid: string;
  session_id: string;
};

/** Assistant message — Claude's response with text and tool_use blocks. */
export type CCAssistantMessage = {
  type: "assistant";
  message: {
    model: string;
    id: string;
    type: "message";
    role: "assistant";
    content: CCContentBlock[];
    stop_reason: "end_turn" | "tool_use" | null;
    usage?: ClaudeCodeUsage;
  };
  session_id: string;
  uuid: string;
};

export type CCContentBlock = CCTextBlock | CCToolUseBlock;

export type CCTextBlock = {
  type: "text";
  text: string;
};

export type CCToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

/** User message — tool results echoed back. */
export type CCUserMessage = {
  type: "user";
  message: {
    role: "user";
    content: CCToolResultBlock[];
  };
  uuid: string;
  session_id: string;
};

export type CCToolResultBlock = {
  tool_use_id: string;
  type: "tool_result";
  content: string;
};

/** Result message — terminal, always the last message. */
export type CCResultMessage = {
  type: "result";
  subtype: CCResultSubtype;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error: boolean;
  num_turns?: number;
  stop_reason?: string;
  session_id: string;
  total_cost_usd?: number;
  usage?: ClaudeCodeUsage;
  modelUsage?: Record<string, unknown>;
  permission_denials?: string[];
  uuid: string;
  result?: string;
  errors?: string[];
};

export type CCResultSubtype =
  | "success"
  | "error_during_execution"
  | "error_max_turns"
  | "error_max_budget_usd";

/** Stream event — partial deltas for real-time display. */
export type CCStreamEvent = {
  type: "stream_event";
  // Contains content_block_delta with text_delta fragments (high-frequency).
  event?: { type?: string; [key: string]: unknown };
  [key: string]: unknown;
};

/** Auth status — emitted when auth state changes. */
export type CCAuthStatusMessage = {
  type: "auth_status";
  isAuthenticating: boolean;
  output?: string;
  error?: string | null;
  uuid: string;
  session_id: string;
};

/** Control response — response to a control_request we sent. */
export type CCControlResponse = {
  type: "control_response";
  response: {
    subtype: "success" | "error";
    request_id: string;
    response?: Record<string, unknown>;
    error?: string;
    pending_permission_requests?: unknown[];
  };
};

/** Union of all outbound (stdout) message types. */
export type CCOutboundMessage =
  | CCSystemMessage
  | CCAssistantMessage
  | CCUserMessage
  | CCResultMessage
  | CCStreamEvent
  | CCAuthStatusMessage
  | CCControlResponse;

// ---------------------------------------------------------------------------
// Messages TO Claude Code (stdin)
// ---------------------------------------------------------------------------

/** User message — send a prompt or follow-up. */
export type CCUserInput = {
  type: "user";
  message: {
    role: "user";
    content: string;
  };
  uuid: string;
};

/** Control request — change settings mid-session. */
export type CCControlRequest = {
  type: "control_request";
  request: CCControlRequestPayload;
  request_id: string;
};

export type CCControlRequestPayload =
  | { subtype: "set_permission_mode"; permissionMode: string }
  | { subtype: "set_model"; model: string }
  | { subtype: "initialize" }
  | { subtype: "mcp_status" };

/** Keep-alive — prevent stdin EOF. */
export type CCKeepAlive = {
  type: "keep_alive";
};

/** Union of all inbound (stdin) message types. */
export type CCInboundMessage = CCUserInput | CCControlRequest | CCKeepAlive;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Type guard for outbound messages. */
export function parseOutboundMessage(raw: string): CCOutboundMessage | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && typeof parsed.type === "string") {
      return parsed as CCOutboundMessage;
    }
    return null;
  } catch {
    return null;
  }
}
