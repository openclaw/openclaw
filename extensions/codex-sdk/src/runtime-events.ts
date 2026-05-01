import { AcpRuntimeError, type AcpRuntimeEvent } from "openclaw/plugin-sdk/acpx";
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_REASONING_EFFORTS,
  CODEX_SANDBOX_MODES,
  CODEX_WEB_SEARCH_MODES,
  type CodexApprovalPolicy,
  type CodexReasoningEffort,
  type CodexSandboxMode,
  type CodexWebSearchMode,
  type ResolvedCodexRouteConfig,
} from "./config.js";

export type CodexInput =
  | string
  | Array<{ type: "text"; text: string } | { type: "local_image"; path: string }>;

export type CodexThreadOptions = {
  model?: string;
  sandboxMode?: CodexSandboxMode;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  modelReasoningEffort?: CodexReasoningEffort;
  networkAccessEnabled?: boolean;
  webSearchMode?: CodexWebSearchMode;
  approvalPolicy?: CodexApprovalPolicy;
  additionalDirectories?: string[];
};

export type CodexUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
};

export type CodexThreadItem =
  | { id?: string; type: "agent_message"; text?: string }
  | { id?: string; type: "reasoning"; text?: string }
  | {
      id?: string;
      type: "command_execution";
      command?: string;
      aggregated_output?: string;
      exit_code?: number;
      status?: string;
    }
  | {
      id?: string;
      type: "file_change";
      changes?: Array<{ path?: string; kind?: string }>;
      status?: string;
    }
  | {
      id?: string;
      type: "mcp_tool_call";
      server?: string;
      tool?: string;
      arguments?: unknown;
      error?: { message?: string };
      status?: string;
    }
  | { id?: string; type: "web_search"; query?: string }
  | { id?: string; type: "todo_list"; items?: Array<{ text?: string; completed?: boolean }> }
  | { id?: string; type: "error"; message?: string };

export type CodexThreadEvent =
  | { type: "thread.started"; thread_id?: string }
  | { type: "turn.started" }
  | { type: "turn.completed"; usage?: CodexUsage }
  | { type: "turn.failed"; error?: { message?: string } }
  | { type: "item.started" | "item.updated" | "item.completed"; item?: CodexThreadItem }
  | { type: "error"; message?: string };

export const CONTROL_KEYS = [
  "model",
  "sandboxMode",
  "approvalPolicy",
  "modelReasoningEffort",
  "skipGitRepoCheck",
  "networkAccessEnabled",
  "webSearchMode",
  "route",
] as const;

const BACKCHANNEL_TURN_INSTRUCTIONS =
  "OpenClaw has injected an MCP backchannel. Use openclaw_status to refresh OpenClaw runtime context, openclaw_proposal to create operator-visible follow-up work, and openclaw_gateway_request only for explicitly allowed Gateway RPC methods.";

export function composeRouteText(params: {
  route: ResolvedCodexRouteConfig;
  text: string;
  backchannelEnabled: boolean;
}): string {
  const instructions = params.route.instructions?.trim();
  const sections = [
    ...(params.backchannelEnabled
      ? [
          "<openclaw-codex-backchannel>",
          BACKCHANNEL_TURN_INSTRUCTIONS,
          "</openclaw-codex-backchannel>",
          "",
        ]
      : []),
    ...(instructions
      ? [
          `<openclaw-codex-route route="${params.route.label}">`,
          instructions,
          "</openclaw-codex-route>",
          "",
        ]
      : []),
    params.text,
  ];
  return sections.join("\n");
}

export function mapCodexThreadEvent(event: CodexThreadEvent): {
  events: AcpRuntimeEvent[];
  ignoredType?: string;
  threadId?: string;
} {
  switch (event.type) {
    case "thread.started": {
      const threadId = event.thread_id?.trim();
      return {
        ...(threadId ? { threadId } : {}),
        events: threadId
          ? [
              {
                type: "status",
                text: `Codex thread started: ${threadId}`,
                tag: "session_info_update",
              },
            ]
          : [],
      };
    }
    case "turn.started":
      return {
        events: [{ type: "status", text: "Codex turn started.", tag: "session_info_update" }],
      };
    case "turn.completed": {
      const used = totalUsage(event.usage);
      return {
        events: [
          ...(used !== undefined
            ? [
                {
                  type: "status" as const,
                  text: `Codex tokens used: ${used}`,
                  tag: "usage_update" as const,
                  used,
                },
              ]
            : []),
          { type: "done", stopReason: "end_turn" },
        ],
      };
    }
    case "turn.failed":
      return {
        events: [
          {
            type: "error",
            message: event.error?.message || "Codex turn failed.",
            code: "ACP_TURN_FAILED",
            retryable: true,
          },
        ],
      };
    case "error":
      return {
        events: [
          {
            type: "error",
            message: event.message || "Codex SDK stream error.",
            code: "ACP_TURN_FAILED",
            retryable: true,
          },
        ],
      };
    case "item.started":
    case "item.updated":
    case "item.completed":
      return { events: event.item ? mapThreadItem(event.item, event.type) : [] };
    default:
      return { events: [], ignoredType: (event as { type?: string }).type };
  }
}

export function parseConfigOptionPatch(key: string, rawValue: string): Partial<CodexThreadOptions> {
  const value = rawValue.trim();
  switch (key) {
    case "model":
      return value ? { model: value } : { model: undefined };
    case "sandboxMode":
      assertOneOf(value, CODEX_SANDBOX_MODES, "Invalid Codex sandboxMode.");
      return { sandboxMode: value as CodexSandboxMode };
    case "approvalPolicy":
      assertOneOf(value, CODEX_APPROVAL_POLICIES, "Invalid Codex approvalPolicy.");
      return { approvalPolicy: value as CodexApprovalPolicy };
    case "modelReasoningEffort":
      assertOneOf(value, CODEX_REASONING_EFFORTS, "Invalid Codex modelReasoningEffort.");
      return { modelReasoningEffort: value as CodexReasoningEffort };
    case "skipGitRepoCheck":
      return { skipGitRepoCheck: parseBooleanOption(value, key) };
    case "networkAccessEnabled":
      return { networkAccessEnabled: parseBooleanOption(value, key) };
    case "webSearchMode":
      assertOneOf(value, CODEX_WEB_SEARCH_MODES, "Invalid Codex webSearchMode.");
      return { webSearchMode: value as CodexWebSearchMode };
    default:
      throw new AcpRuntimeError(
        "ACP_BACKEND_UNSUPPORTED_CONTROL",
        `Codex SDK backend does not accept config key "${key}".`,
      );
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = "name" in error ? String((error as { name?: unknown }).name ?? "") : "";
  const message = "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
  return name === "AbortError" || /aborted|cancelled|canceled/i.test(message);
}

function mapThreadItem(item: CodexThreadItem, eventType: string): AcpRuntimeEvent[] {
  if (item.type === "agent_message") {
    const text = item.text?.trim();
    return eventType === "item.completed" && text ? [{ type: "text_delta", text }] : [];
  }
  if (item.type === "reasoning") {
    const text = item.text?.trim();
    return text
      ? [{ type: "text_delta", text, stream: "thought", tag: "agent_thought_chunk" }]
      : [];
  }
  if (item.type === "command_execution") {
    const command = item.command?.trim() || "command";
    const output = item.aggregated_output?.trim();
    const suffix = output ? `\n${output}` : "";
    return [
      {
        type: "tool_call",
        title: command,
        text: `${command} (${item.status ?? eventType})${suffix}`,
        toolCallId: item.id,
        status: item.status,
        tag: eventType === "item.completed" ? "tool_call" : "tool_call_update",
      },
    ];
  }
  if (item.type === "file_change") {
    const changes = (item.changes ?? [])
      .map((change) => `${change.kind ?? "change"} ${change.path ?? ""}`.trim())
      .filter(Boolean)
      .join(", ");
    return [
      {
        type: "tool_call",
        title: "file change",
        text: changes || `file change (${item.status ?? eventType})`,
        toolCallId: item.id,
        status: item.status,
        tag: eventType === "item.completed" ? "tool_call" : "tool_call_update",
      },
    ];
  }
  if (item.type === "mcp_tool_call") {
    const tool = [item.server, item.tool].filter(Boolean).join("/");
    const error = item.error?.message ? `: ${item.error.message}` : "";
    return [
      {
        type: "tool_call",
        title: tool || "mcp tool",
        text: `${tool || "mcp tool"} (${item.status ?? eventType})${error}`,
        toolCallId: item.id,
        status: item.status,
        tag: eventType === "item.completed" ? "tool_call" : "tool_call_update",
      },
    ];
  }
  if (item.type === "web_search") {
    return [
      {
        type: "tool_call",
        title: "web search",
        text: `web search: ${item.query ?? ""}`.trim(),
        toolCallId: item.id,
        status: eventType,
        tag: eventType === "item.completed" ? "tool_call" : "tool_call_update",
      },
    ];
  }
  if (item.type === "todo_list") {
    const summary = (item.items ?? [])
      .map((todo) => `${todo.completed ? "[x]" : "[ ]"} ${todo.text ?? ""}`.trim())
      .filter(Boolean)
      .join("\n");
    return summary ? [{ type: "status", text: summary, tag: "plan" }] : [];
  }
  if (item.type === "error") {
    return [
      {
        type: "error",
        message: item.message || "Codex item error.",
        code: "ACP_TURN_FAILED",
        retryable: true,
      },
    ];
  }
  return [];
}

function totalUsage(usage: CodexUsage | undefined): number | undefined {
  if (!usage) {
    return undefined;
  }
  const values = [
    usage.input_tokens,
    usage.cached_input_tokens,
    usage.output_tokens,
    usage.reasoning_output_tokens,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0);
}

function assertOneOf(value: string, allowed: readonly string[], message: string): void {
  if (!allowed.includes(value)) {
    throw new AcpRuntimeError("ACP_TURN_FAILED", message);
  }
}

function parseBooleanOption(value: string, key: string): boolean {
  if (/^(true|1|yes|on)$/i.test(value)) {
    return true;
  }
  if (/^(false|0|no|off)$/i.test(value)) {
    return false;
  }
  throw new AcpRuntimeError("ACP_TURN_FAILED", `Invalid boolean value for ${key}.`);
}
