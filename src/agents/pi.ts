import path from "node:path";

import type {
  AgentMeta,
  AgentParseResult,
  AgentSpec,
  AgentToolResult,
} from "./types.js";

type PiAssistantMessage = {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input?: number; output?: number };
  model?: string;
  provider?: string;
  stopReason?: string;
  name?: string;
  toolName?: string;
  tool_call_id?: string;
  toolCallId?: string;
  details?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
};

function inferToolName(msg: PiAssistantMessage): string | undefined {
  const candidates = [
    msg.toolName,
    msg.name,
    msg.toolCallId,
    msg.tool_call_id,
  ]
    .map((c) => (typeof c === "string" ? c.trim() : ""))
    .filter(Boolean);
  if (candidates.length) return candidates[0];

  if (msg.role && msg.role.includes(":")) {
    const suffix = msg.role.split(":").slice(1).join(":").trim();
    if (suffix) return suffix;
  }

  return undefined;
}

function deriveToolMeta(msg: PiAssistantMessage): string | undefined {
  const details = msg.details ?? msg.arguments;
  const pathVal = details && typeof details.path === "string" ? details.path : undefined;
  const offset = details && typeof details.offset === "number" ? details.offset : undefined;
  const limit = details && typeof details.limit === "number" ? details.limit : undefined;
  const command = details && typeof details.command === "string" ? details.command : undefined;

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

  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as {
        type?: string;
        message?: PiAssistantMessage;
      };

      const isToolResult =
        (ev.type === "message" || ev.type === "message_end") &&
        ev.message?.role &&
        typeof ev.message.role === "string" &&
        ev.message.role.toLowerCase().includes("tool");
      const isAssistantMessage =
        (ev.type === "message" || ev.type === "message_end") &&
        ev.message?.role === "assistant" &&
        Array.isArray(ev.message.content);

      if (!isAssistantMessage && !isToolResult) continue;

      const msg = ev.message as PiAssistantMessage;
      const msgText = msg.content
        ?.filter((c) => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n")
        .trim();

      if (isAssistantMessage) {
        if (msgText && msgText !== lastPushed) {
          texts.push(msgText);
          lastPushed = msgText;
          lastAssistant = msg;
        }
      } else if (isToolResult && msg.content) {
        const toolText = msg.content
          ?.filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text)
          .join("\n")
          .trim();
        if (toolText) {
          toolResults.push({
            text: toolText,
            toolName: inferToolName(msg),
            meta: deriveToolMeta(msg),
          });
        }
      }
    } catch {
      // ignore malformed lines
    }
  }

  const meta: AgentMeta | undefined =
    lastAssistant && texts.length
      ? {
          model: lastAssistant.model,
          provider: lastAssistant.provider,
          stopReason: lastAssistant.stopReason,
          usage: lastAssistant.usage,
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
    return base === "pi" || base === "tau";
  },
  buildArgs: (ctx) => {
    const argv = [...ctx.argv];
    // Non-interactive print + JSON
    if (!argv.includes("-p") && !argv.includes("--print")) {
      argv.splice(argv.length - 1, 0, "-p");
    }
    if (
      ctx.format === "json" &&
      !argv.includes("--mode") &&
      !argv.some((a) => a === "--mode")
    ) {
      argv.splice(argv.length - 1, 0, "--mode", "json");
    }
    // Session defaults
    // Identity prefix optional; Pi usually doesn't need it, but allow injection
    if (!(ctx.sendSystemOnce && ctx.systemSent) && argv[ctx.bodyIndex]) {
      const existingBody = argv[ctx.bodyIndex];
      argv[ctx.bodyIndex] = [ctx.identityPrefix, existingBody]
        .filter(Boolean)
        .join("\n\n");
    }
    return argv;
  },
  parseOutput: parsePiJson,
};
