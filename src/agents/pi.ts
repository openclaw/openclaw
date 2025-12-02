import path from "node:path";

import type { AgentMeta, AgentParseResult, AgentSpec } from "./types.js";

type PiAssistantMessage = {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input?: number; output?: number };
  model?: string;
  provider?: string;
  stopReason?: string;
};

function parsePiJson(raw: string): AgentParseResult {
  const lines = raw.split(/\n+/).filter((l) => l.trim().startsWith("{"));
  let lastMessage: PiAssistantMessage | undefined;
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as {
        type?: string;
        message?: PiAssistantMessage;
      };
      // Pi emits a stream; we only care about the terminal assistant message_end.
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        lastMessage = ev.message;
      }
    } catch {
      // ignore
    }
  }
  const text =
    lastMessage?.content
      ?.filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
      ?.trim() ?? undefined;
  const meta: AgentMeta | undefined = lastMessage
    ? {
        model: lastMessage.model,
        provider: lastMessage.provider,
        stopReason: lastMessage.stopReason,
        usage: lastMessage.usage,
      }
    : undefined;
  return { text, meta };
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
