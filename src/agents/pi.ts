import path from "node:path";

import type {
  AgentMeta,
  AgentParseResult,
  AgentSpec,
  AgentToolResult,
} from "./types.js";
import { normalizeUsage, type UsageLike } from "./usage.js";

type PiAssistantMessage = {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: UsageLike;
  model?: string;
  provider?: string;
  stopReason?: string;
  errorMessage?: string;
  name?: string;
  toolName?: string;
  tool_call_id?: string;
  toolCallId?: string;
  details?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
};

function inferToolName(msg: PiAssistantMessage): string | undefined {
  const candidates = [msg.toolName, msg.name, msg.toolCallId, msg.tool_call_id]
    .map((c) => (typeof c === "string" ? c.trim() : ""))
    .filter(Boolean);
  if (candidates.length) return candidates[0];

  if (msg.role?.includes(":")) {
    const suffix = msg.role.split(":").slice(1).join(":").trim();
    if (suffix) return suffix;
  }

  return undefined;
}

function deriveToolMeta(msg: PiAssistantMessage): string | undefined {
  const details = msg.details ?? msg.arguments;
  const pathVal =
    details && typeof details.path === "string" ? details.path : undefined;
  const offset =
    details && typeof details.offset === "number" ? details.offset : undefined;
  const limit =
    details && typeof details.limit === "number" ? details.limit : undefined;
  const command =
    details && typeof details.command === "string"
      ? details.command
      : undefined;

  if (pathVal) {
    if (offset !== undefined && limit !== undefined) {
      return `${pathVal}:${offset}-${offset + limit}`;
    }
    return pathVal;
  }
  if (command) return command;
  return undefined;
}

function parsePiJson(raw: string): AgentParseResult {
  const lines = raw.split(/\n+/).filter((l) => l.trim().startsWith("{"));

  // Collect only completed assistant messages (skip streaming updates/toolcalls).
  const texts: string[] = [];
  const toolResults: AgentToolResult[] = [];
  let lastAssistant: PiAssistantMessage | undefined;
  let lastPushed: string | undefined;

  const pickText = (msg?: PiAssistantMessage) =>
    msg?.content
      ?.filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
      .trim();

  const handleAssistant = (msg?: PiAssistantMessage) => {
    if (!msg) return;
    lastAssistant = msg;
    const text = pickText(msg);
    const fallbackError =
      !text && typeof msg.errorMessage === "string"
        ? `Warning: ${msg.errorMessage}`
        : undefined;
    const chosen = (text || fallbackError)?.trim();
    if (chosen && chosen !== lastPushed) {
      texts.push(chosen);
      lastPushed = chosen;
    }
  };

  const handleToolResult = (msg?: PiAssistantMessage) => {
    if (!msg || !msg.content) return;
    const toolText = pickText(msg);
    if (!toolText) return;
    toolResults.push({
      text: toolText,
      toolName: inferToolName(msg),
      meta: deriveToolMeta(msg),
    });
  };

  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as {
        type?: string;
        message?: PiAssistantMessage;
        toolResults?: PiAssistantMessage[];
        messages?: PiAssistantMessage[];
      };

      // Turn-level assistant + tool results
      if (ev.type === "turn_end") {
        handleAssistant(ev.message);
        if (Array.isArray(ev.toolResults)) {
          for (const tr of ev.toolResults) handleToolResult(tr);
        }
      }

      // Agent-level summary of all messages
      if (ev.type === "agent_end" && Array.isArray(ev.messages)) {
        for (const msg of ev.messages) {
          const role = msg?.role ?? "";
          if (role === "assistant") handleAssistant(msg);
          else if (role.toLowerCase().includes("tool")) handleToolResult(msg);
        }
      }

      const role = ev.message?.role ?? "";
      const isAssistantMessage =
        (ev.type === "message" ||
          ev.type === "message_end" ||
          ev.type === "message_start") &&
        role === "assistant";
      const isToolResult =
        (ev.type === "message" ||
          ev.type === "message_end" ||
          ev.type === "message_start") &&
        typeof role === "string" &&
        role.toLowerCase().includes("tool");

      if (isAssistantMessage) handleAssistant(ev.message);
      if (isToolResult) handleToolResult(ev.message);
    } catch {
      // ignore malformed lines
    }
  }

  const meta: AgentMeta | undefined = lastAssistant
    ? {
        model: lastAssistant.model,
        provider: lastAssistant.provider,
        stopReason: lastAssistant.stopReason,
        usage: normalizeUsage(lastAssistant.usage),
      }
    : undefined;

  return {
    texts,
    toolResults: toolResults.length ? toolResults : undefined,
    meta,
  };
}

export const piSpec: AgentSpec = {
  kind: "pi",
  isInvocation: (argv) => {
    if (argv.length === 0) return false;
    const base = path.basename(argv[0]).replace(/\.(m?js)$/i, "");
    if (base === "pi" || base === "tau") return true;

    // Also handle node entrypoints like `node /.../pi-mono/packages/coding-agent/dist/cli.js`
    if (base === "node" && argv.length > 1) {
      const second = argv[1]?.toString().toLowerCase();
      return (
        second.includes("pi-mono") &&
        second.includes("packages") &&
        second.includes("coding-agent") &&
        (second.endsWith("cli.js") || second.includes("/dist/cli"))
      );
    }

    return false;
  },
  buildArgs: (ctx) => {
    const argv = [...ctx.argv];
    let bodyPos = ctx.bodyIndex;
    const modeIdx = argv.indexOf("--mode");
    const modeVal =
      modeIdx >= 0 ? argv[modeIdx + 1]?.toString().toLowerCase() : undefined;
    const isRpcMode = modeVal === "rpc";
    // Non-interactive print + JSON
    if (!isRpcMode && !argv.includes("-p") && !argv.includes("--print")) {
      argv.splice(bodyPos, 0, "-p");
      bodyPos += 1;
    }
    if (
      ctx.format === "json" &&
      !argv.includes("--mode") &&
      !argv.some((a) => a === "--mode")
    ) {
      argv.splice(bodyPos, 0, "--mode", "json");
      bodyPos += 2;
    }
    // Session defaults
    // Identity prefix optional; Pi usually doesn't need it, but allow injection
    if (!(ctx.sendSystemOnce && ctx.systemSent) && argv[bodyPos]) {
      const existingBody = argv[bodyPos];
      argv[bodyPos] = [ctx.identityPrefix, existingBody]
        .filter(Boolean)
        .join("\n\n");
    }
    return argv;
  },
  parseOutput: parsePiJson,
};
