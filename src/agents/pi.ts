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

  // Collect every assistant message we see; Tau in RPC mode can emit multiple
  // assistant payloads in one run (e.g., queued turns, heartbeats). We concatenate
  // all text blocks so users see everything instead of only the last message_end.
  const texts: string[] = [];
  let lastAssistant: PiAssistantMessage | undefined;

  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as {
        type?: string;
        message?: PiAssistantMessage;
      };
      const msg = ev.message;
      if (msg?.role === "assistant" && Array.isArray(msg.content)) {
        const msgText = msg.content
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text)
          .join("\n")
          .trim();
        if (msgText) texts.push(msgText);
        // keep meta from the most recent assistant message
        lastAssistant = msg;
      }
    } catch {
      // ignore malformed lines
    }
  }

  // Combine all assistant text messages (ignore tool calls/partials). This keeps
  // multi-message replies intact while dropping non-text events.
  const text = texts.length ? texts.join("\n\n").trim() : undefined;

  const meta: AgentMeta | undefined =
    text && lastAssistant
      ? {
          model: lastAssistant.model,
          provider: lastAssistant.provider,
          stopReason: lastAssistant.stopReason,
          usage: lastAssistant.usage,
        }
      : undefined;

  return { texts, meta };
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
