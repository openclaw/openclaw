import path from "node:path";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { redactImageDataForDiagnostics } from "./payload-redaction.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "./queued-file-writer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TraceEventType =
  | "llm_request"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_start"
  | "tool_update"
  | "tool_end"
  | "agent_start"
  | "agent_end"
  | "compaction_start"
  | "compaction_end";

export type TraceEvent = {
  ts: string;
  type: TraceEventType;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  // LLM request fields
  systemPrompt?: string;
  messagesCount?: number;
  toolsCount?: number;
  payload?: unknown;
  // Message fields
  text?: string;
  reasoning?: string;
  stopReason?: string;
  usage?: Record<string, unknown>;
  // Tool fields
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
  // Lifecycle fields
  phase?: string;
  error?: string;
  // Generic metadata
  [key: string]: unknown;
};

type TraceLogConfig = {
  enabled: boolean;
  filePath: string;
  verbose: boolean;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const writers = new Map<string, QueuedFileWriter>();
const log = createSubsystemLogger("agent/trace");

export function resolveTraceLogConfig(env: NodeJS.ProcessEnv): TraceLogConfig {
  const enabled = parseBooleanValue(env.OPENCLAW_AGENT_TRACE) ?? false;
  const fileOverride = env.OPENCLAW_AGENT_TRACE_FILE?.trim();
  const filePath = fileOverride
    ? resolveUserPath(fileOverride)
    : path.join(resolveStateDir(env), "logs", "agent-trace.jsonl");
  const verbose = parseBooleanValue(env.OPENCLAW_AGENT_TRACE_VERBOSE) ?? false;
  return { enabled, filePath, verbose };
}

function getWriter(filePath: string): QueuedFileWriter {
  return getQueuedFileWriter(writers, filePath);
}

// ---------------------------------------------------------------------------
// Terminal formatting helpers
// ---------------------------------------------------------------------------

function truncate(text: string | undefined, maxLen = 80): string {
  if (!text) {
    return "";
  }
  const oneLine = text.replace(/\n/g, "\\n");
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}...` : oneLine;
}

function formatTerminalEvent(evt: TraceEvent, verbose: boolean): string {
  const prefix = "[agent/trace]";
  switch (evt.type) {
    case "llm_request": {
      const summary = `➡️  LLM_REQ  ${evt.provider ?? "?"}/${evt.model ?? "?"} msgs=${evt.messagesCount ?? "?"} tools=${evt.toolsCount ?? "?"}`;
      if (verbose && evt.systemPrompt) {
        return `${prefix} ${summary}\n${prefix}   system: ${truncate(evt.systemPrompt, 200)}`;
      }
      return `${prefix} ${summary}`;
    }
    case "message_start":
      return `${prefix} ⬅️  MSG_START`;
    case "message_update":
      return `${prefix} ⬅️  MSG_UPD   "${truncate(evt.text, 60)}"`;
    case "message_end": {
      const usage = evt.usage;
      const inTok = typeof usage?.input === "number" ? usage.input : "?";
      const outTok = typeof usage?.output === "number" ? usage.output : "?";
      const tokens = usage ? `tokens=${inTok}→${outTok}` : "";
      return `${prefix} ⬅️  MSG_END   ${tokens} "${truncate(evt.text, 60)}"`;
    }
    case "tool_start":
      return `${prefix} 🔧 TOOL_START ${evt.toolName ?? "?"} args=${truncate(safeJsonStringify(evt.args) ?? "{}", 100)}`;
    case "tool_update":
      return `${prefix} 🔧 TOOL_UPD   ${evt.toolName ?? "?"}`;
    case "tool_end": {
      const status = evt.isError ? "ERR" : "ok";
      const dur = evt.durationMs ? `${evt.durationMs}ms` : "";
      return `${prefix} 🔧 TOOL_END   ${evt.toolName ?? "?"} ${status} ${dur} result=${truncate(safeJsonStringify(evt.result) ?? "", 100)}`;
    }
    case "agent_start":
      return `${prefix} 🟢 AGENT_START`;
    case "agent_end":
      return evt.error
        ? `${prefix} 🔴 AGENT_END  error=${truncate(evt.error, 120)}`
        : `${prefix} 🟢 AGENT_END`;
    case "compaction_start":
      return `${prefix} 🔄 COMPACTION_START`;
    case "compaction_end":
      return `${prefix} 🔄 COMPACTION_END`;
    default:
      return `${prefix} ❓ ${String(evt.type)}`;
  }
}

// ---------------------------------------------------------------------------
// Agent Trace Logger
// ---------------------------------------------------------------------------

export type AgentTraceLogger = {
  enabled: true;
  /** Wrap a StreamFn to intercept request payloads. */
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
  /** Log a raw session event (message_start, tool_execution_start, etc.). */
  logSessionEvent: (evt: Record<string, unknown>) => void;
};

export function createAgentTraceLogger(params: {
  env?: NodeJS.ProcessEnv;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  workspaceDir?: string;
  writer?: QueuedFileWriter;
}): AgentTraceLogger | null {
  const env = params.env ?? process.env;
  const cfg = resolveTraceLogConfig(env);
  if (!cfg.enabled) {
    return null;
  }

  const writer = params.writer ?? getWriter(cfg.filePath);
  const base: Partial<TraceEvent> = {
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    model: params.modelId,
  };

  // Track tool start times for duration calculation
  const toolStartTimes = new Map<string, number>();

  const record = (event: TraceEvent) => {
    // Write JSONL
    const line = safeJsonStringify(event);
    if (line) {
      writer.write(`${line}\n`);
    }
    // Terminal output
    const termLine = formatTerminalEvent(event, cfg.verbose);
    if (termLine) {
      log.debug(termLine);
    }
  };

  const wrapStreamFn: AgentTraceLogger["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model, context, options) => {
      let sysTextFromContext = "";
      if (typeof (context as unknown as { system?: unknown })?.system === "string") {
        sysTextFromContext = (context as unknown as { system: string }).system;
      }
      const ctx = context as unknown as Record<string, unknown>;
      const messages = Array.isArray(ctx?.messages) ? ctx.messages : [];
      const tools = Array.isArray(ctx?.tools) ? ctx.tools : [];

      // Create a wrapped onPayload that will capture the final JSON payload
      // generated by the provider SDK. This is the only reliable way to get
      // the true system prompt for all providers (e.g. OpenAICompat).
      const nextOnPayload = (payload: unknown) => {
        let finalSysText = sysTextFromContext;

        // Try extracting system prompt from the raw provider payload
        if (payload && typeof payload === "object") {
          const p = payload as Record<string, unknown>;

          // OpenAI / Anthropic messages array styles
          if (Array.isArray(p.messages)) {
            const sysMsg = p.messages.find(
              (m: unknown) =>
                m && typeof m === "object" && (m as { role?: unknown }).role === "system",
            ) as { content?: unknown } | undefined;
            if (sysMsg) {
              if (typeof sysMsg.content === "string") {
                finalSysText = sysMsg.content;
              } else if (Array.isArray(sysMsg.content)) {
                finalSysText = sysMsg.content
                  .filter(
                    (b: unknown) =>
                      b && typeof b === "object" && (b as { type?: unknown }).type === "text",
                  )
                  .map((b: unknown) => (b as { text?: string }).text ?? "")
                  .join("");
              }
            }
          }

          // Anthropic top-level system field style
          if (!finalSysText && typeof p.system === "string") {
            finalSysText = p.system;
          }

          if (!finalSysText && Array.isArray(p.system)) {
            finalSysText = p.system
              .filter(
                (b: unknown) =>
                  b && typeof b === "object" && (b as { type?: unknown }).type === "text",
              )
              .map((b: unknown) => (b as { text?: string }).text ?? "")
              .join("");
          }
        }

        record({
          ...base,
          ts: new Date().toISOString(),
          type: "llm_request",
          provider: (model as { provider?: string }).provider ?? params.provider,
          model: (model as { id?: string }).id ?? params.modelId,
          messagesCount: messages.length,
          toolsCount: tools.length,
          ...(cfg.verbose
            ? {
                payload: redactImageDataForDiagnostics(
                  payload ?? {
                    messages,
                    tools,
                    system: finalSysText,
                  },
                ),
              }
            : {
                systemPrompt: finalSysText ? finalSysText.slice(0, 500) : undefined,
              }),
        });

        return options?.onPayload?.(payload, model);
      };

      return streamFn(model, context, {
        ...options,
        onPayload: nextOnPayload,
      });
    };
    return wrapped;
  };

  const logSessionEvent: AgentTraceLogger["logSessionEvent"] = (evt) => {
    const type = typeof evt.type === "string" ? evt.type : "unknown";
    const message = evt.message as Record<string, unknown> | undefined;
    const role = typeof message?.role === "string" ? message.role : undefined;

    switch (type) {
      case "message_start":
        if (role === "user") {
          break;
        } // Skip user messages
        record({
          ...base,
          ts: new Date().toISOString(),
          type: "message_start",
        });
        break;
      case "message_update": {
        if (!cfg.verbose || role === "user") {
          break;
        }
        const content = message?.content;
        let text = "";
        let reasoning = "";
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          text = content
            .filter(
              (b: unknown) =>
                b && typeof b === "object" && (b as { type?: unknown }).type === "text",
            )
            .map((b: unknown) => (b as { text?: string }).text ?? "")
            .join("");
          reasoning = content
            .filter(
              (b: unknown) =>
                b && typeof b === "object" && (b as { type?: unknown }).type === "thinking",
            )
            .map((b: unknown) => (b as { thinking?: string }).thinking ?? "")
            .join("");
        }
        record({
          ...base,
          ts: new Date().toISOString(),
          type: "message_update",
          text: cfg.verbose ? text : text.slice(0, 200),
          reasoning: cfg.verbose ? reasoning : reasoning.slice(0, 200),
        });
        break;
      }

      case "message_end": {
        if (role === "user") {
          break;
        }
        const content = message?.content;
        let text = "";
        let reasoning = "";
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          text = content
            .filter(
              (b: unknown) =>
                b && typeof b === "object" && (b as { type?: unknown }).type === "text",
            )
            .map((b: unknown) => (b as { text?: string }).text ?? "")
            .join("");
          reasoning = content
            .filter(
              (b: unknown) =>
                b && typeof b === "object" && (b as { type?: unknown }).type === "thinking",
            )
            .map((b: unknown) => (b as { thinking?: string }).thinking ?? "")
            .join("");
        }
        const usage = message?.usage as Record<string, unknown> | undefined;
        record({
          ...base,
          ts: new Date().toISOString(),
          type: "message_end",
          text: cfg.verbose ? text : text.slice(0, 500),
          reasoning: cfg.verbose ? reasoning : reasoning.slice(0, 500),
          stopReason: typeof message?.stopReason === "string" ? message.stopReason : undefined,
          usage: usage ?? undefined,
        });
        break;
      }

      case "tool_execution_start": {
        const toolName = typeof evt.toolName === "string" ? evt.toolName : undefined;
        const toolCallId = typeof evt.toolCallId === "string" ? evt.toolCallId : undefined;
        if (toolCallId) {
          toolStartTimes.set(toolCallId, Date.now());
        }
        record({
          ...base,
          ts: new Date().toISOString(),
          type: "tool_start",
          toolName,
          toolCallId,
          args: cfg.verbose ? evt.args : summarizeArgs(evt.args),
        });
        break;
      }

      case "tool_execution_update": {
        if (!cfg.verbose) {
          break;
        }
        record({
          ...base,
          ts: new Date().toISOString(),
          type: "tool_update",
          toolName: typeof evt.toolName === "string" ? evt.toolName : undefined,
          toolCallId: typeof evt.toolCallId === "string" ? evt.toolCallId : undefined,
          result: summarizeResult(evt.partialResult),
        });
        break;
      }

      case "tool_execution_end": {
        const toolCallId = typeof evt.toolCallId === "string" ? evt.toolCallId : undefined;
        const startTime = toolCallId ? toolStartTimes.get(toolCallId) : undefined;
        const durationMs = startTime ? Date.now() - startTime : undefined;
        if (toolCallId) {
          toolStartTimes.delete(toolCallId);
        }
        record({
          ...base,
          ts: new Date().toISOString(),
          type: "tool_end",
          toolName: typeof evt.toolName === "string" ? evt.toolName : undefined,
          toolCallId,
          isError: typeof evt.isError === "boolean" ? evt.isError : undefined,
          result: cfg.verbose ? evt.result : summarizeResult(evt.result),
          durationMs,
        });
        break;
      }

      case "agent_start":
        record({
          ...base,
          ts: new Date().toISOString(),
          type: "agent_start",
          phase: "start",
        });
        break;

      case "agent_end":
        record({
          ...base,
          ts: new Date().toISOString(),
          type: "agent_end",
          phase: "end",
          error: typeof evt.error === "string" ? evt.error : undefined,
        });
        break;

      case "auto_compaction_start":
        record({
          ...base,
          ts: new Date().toISOString(),
          type: "compaction_start",
        });
        break;

      case "auto_compaction_end":
        record({
          ...base,
          ts: new Date().toISOString(),
          type: "compaction_end",
        });
        break;

      default:
        // Try to log unhandled events as raw debug logs just to see if we're missing something
        if (cfg.verbose) {
          log.debug(`Unhandled trace event type: ${type}`);
        }
        break;
    }
  };

  log.info("agent trace logger enabled", { filePath: writer.filePath });
  return { enabled: true, wrapStreamFn, logSessionEvent };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeArgs(args: unknown): unknown {
  if (!args || typeof args !== "object") {
    return args;
  }
  const record = args as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.length > 200) {
      summary[key] = `${value.slice(0, 200)}... (${value.length} chars)`;
    } else {
      summary[key] = value;
    }
  }
  return summary;
}

function summarizeResult(result: unknown): unknown {
  if (typeof result === "string") {
    return result.length > 300 ? `${result.slice(0, 300)}... (${result.length} chars)` : result;
  }
  if (!result || typeof result !== "object") {
    return result;
  }
  const serialized = safeJsonStringify(result);
  if (serialized && serialized.length > 500) {
    return `${serialized.slice(0, 500)}... (${serialized.length} chars)`;
  }
  return result;
}
