import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveOpenClawStateDir } from "./workspace";

export type GatewaySessionEntry = {
  sessionKey: string;
  sessionId: string;
  channel: string;
  origin: {
    label?: string;
    provider: string;
    surface: string;
    chatType: string;
    from?: string;
    to?: string;
    accountId?: string;
  };
  updatedAt: number;
  chatType: string;
};

export type ChannelStatus = {
  id: string;
  configured: boolean;
  running: boolean;
  connected: boolean;
  error?: string;
  lastMessage?: number;
};

export type TranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts?: Array<Record<string, unknown>>;
  timestamp: string;
};

function deriveChannelFromKey(sessionKey: string, lastChannel?: string): string {
  if (lastChannel && lastChannel !== "unknown") return lastChannel;
  const parts = sessionKey.split(":");
  if (parts.length >= 3) {
    const segment = parts[2];
    if (segment === "web" || segment === "main") return "webchat";
    if (segment === "cron") return "cron";
    if (segment === "telegram" || segment === "whatsapp" || segment === "discord"
      || segment === "slack" || segment === "signal" || segment === "imessage"
      || segment === "nostr" || segment === "googlechat") return segment;
  }
  return lastChannel || "unknown";
}

export function readGatewaySessionsForAgent(agentId: string): GatewaySessionEntry[] {
  const stateDir = resolveOpenClawStateDir();
  const sessionsFile = join(stateDir, "agents", agentId, "sessions", "sessions.json");
  if (!existsSync(sessionsFile)) return [];

  let data: Record<string, Record<string, unknown>>;
  try {
    data = JSON.parse(readFileSync(sessionsFile, "utf-8"));
  } catch {
    return [];
  }

  const entries: GatewaySessionEntry[] = [];
  for (const [key, val] of Object.entries(data)) {
    if (key.includes(":subagent:")) continue;

    const channel = deriveChannelFromKey(key, val.lastChannel as string | undefined);
    if (channel === "webchat" || channel === "unknown") continue;

    const origin = (val.origin ?? {}) as Record<string, unknown>;
    entries.push({
      sessionKey: key,
      sessionId: val.sessionId as string,
      channel,
      origin: {
        label: origin.label as string | undefined,
        provider: (origin.provider ?? channel) as string,
        surface: (origin.surface ?? channel) as string,
        chatType: (origin.chatType ?? val.chatType ?? "direct") as string,
        from: origin.from as string | undefined,
        to: origin.to as string | undefined,
        accountId: origin.accountId as string | undefined,
      },
      updatedAt: val.updatedAt as number ?? 0,
      chatType: (val.chatType ?? "direct") as string,
    });
  }

  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  return entries;
}

export function listAllAgentIds(): string[] {
  const stateDir = resolveOpenClawStateDir();
  const agentsDir = join(stateDir, "agents");
  if (!existsSync(agentsDir)) return [];
  try {
    return readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

export function findSessionTranscriptFile(sessionId: string): string | null {
  const stateDir = resolveOpenClawStateDir();
  const agentsDir = join(stateDir, "agents");
  if (!existsSync(agentsDir)) return null;
  try {
    for (const d of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = join(agentsDir, d.name, "sessions", `${sessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch { /* ignore */ }
  return null;
}

export function parseTranscriptToMessages(content: string): TranscriptMessage[] {
  const lines = content.trim().split("\n").filter((l) => l.trim());
  const messages: TranscriptMessage[] = [];
  const pendingToolCalls = new Map<string, { toolName: string; args?: unknown }>();
  let currentAssistant: TranscriptMessage | null = null;

  const flushAssistant = () => {
    if (!currentAssistant) return;
    const textSummary = (currentAssistant.parts ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
      .slice(0, 200);
    currentAssistant.content = textSummary;
    messages.push(currentAssistant);
    currentAssistant = null;
  };

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== "message" || !entry.message) continue;

    const msg = entry.message as Record<string, unknown>;
    const role = msg.role as string;

    if (role === "toolResult") {
      const toolCallId = (msg.toolCallId as string) ?? "";
      const rawContent = msg.content;
      const outputText = typeof rawContent === "string"
        ? rawContent
        : Array.isArray(rawContent)
          ? (rawContent as Array<{ type: string; text?: string }>)
              .filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n")
          : JSON.stringify(rawContent ?? "");
      let result: unknown;
      try { result = JSON.parse(outputText); } catch { result = { output: outputText.slice(0, 5000) }; }

      const assistantParts = currentAssistant?.parts;
      if (assistantParts) {
        const tc = assistantParts.find(
          (p) => p.type === "tool-invocation" && p.toolCallId === toolCallId,
        );
        if (tc) {
          delete tc.state;
          tc.result = result;
          continue;
        }
      }

      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== "assistant") continue;
        const tc = messages[i].parts?.find(
          (p) => p.type === "tool-invocation" && p.toolCallId === toolCallId,
        );
        if (tc) {
          delete tc.state;
          tc.result = result;
        }
        break;
      }
      continue;
    }

    if (role === "user") {
      flushAssistant();
    }

    if (role !== "user" && role !== "assistant") continue;

    const parts: Array<Record<string, unknown>> = [];

    if (Array.isArray(msg.content)) {
      for (const part of msg.content as Array<Record<string, unknown>>) {
        if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          parts.push({ type: "text", text: part.text });
        } else if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
          parts.push({ type: "reasoning", text: part.thinking });
        } else if (part.type === "toolCall") {
          const toolName = (part.name ?? part.toolName ?? "unknown") as string;
          const toolCallId = (part.id ?? part.toolCallId ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2)}`) as string;
          const args = part.arguments ?? part.input ?? part.args ?? {};
          pendingToolCalls.set(toolCallId, { toolName, args });
          parts.push({ type: "tool-invocation", toolCallId, toolName, args });
        } else if (part.type === "tool_use" || part.type === "tool-call") {
          const toolName = (part.name ?? part.toolName ?? "unknown") as string;
          const toolCallId = (part.id ?? part.toolCallId ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2)}`) as string;
          const args = part.input ?? part.args ?? {};
          pendingToolCalls.set(toolCallId, { toolName, args });
          parts.push({ type: "tool-invocation", toolCallId, toolName, args });
        } else if (part.type === "tool_result" || part.type === "tool-result") {
          const toolCallId = (part.tool_use_id ?? part.toolCallId ?? "") as string;
          const pending = pendingToolCalls.get(toolCallId);
          const raw = part.content ?? part.output;
          const outputText = typeof raw === "string"
            ? raw
            : Array.isArray(raw)
              ? (raw as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n")
              : JSON.stringify(raw ?? "");
          let result: unknown;
          try { result = JSON.parse(outputText); } catch { result = { output: outputText.slice(0, 5000) }; }

          const existingMsg = messages[messages.length - 1];
          if (existingMsg) {
            const tc = existingMsg.parts?.find(
              (p) => p.type === "tool-invocation" && p.toolCallId === toolCallId,
            );
            if (tc) {
              delete tc.state;
              tc.result = result;
              continue;
            }
          }
          parts.push({
            type: "tool-invocation",
            toolCallId,
            toolName: pending?.toolName ?? "tool",
            args: pending?.args ?? {},
            result,
          });
        }
      }
    } else if (typeof msg.content === "string" && msg.content.trim()) {
      parts.push({ type: "text", text: msg.content });
    }

    if (parts.length > 0) {
      const timestamp = (entry.timestamp as string) ?? new Date((entry.ts as number) ?? Date.now()).toISOString();
      if (role === "assistant") {
        if (!currentAssistant) {
          currentAssistant = {
            id: (entry.id as string) ?? `msg-${messages.length}`,
            role: "assistant",
            content: "",
            parts: [],
            timestamp,
          };
        }
        currentAssistant.parts = [...(currentAssistant.parts ?? []), ...parts];
        currentAssistant.timestamp = timestamp;
      } else {
        messages.push({
          id: (entry.id as string) ?? `msg-${messages.length}`,
          role: "user",
          content: parts
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text as string)
            .join("\n")
            .slice(0, 200),
          parts,
          timestamp,
        });
      }
    }
  }
  flushAssistant();
  return messages;
}

export function sessionDisplayTitle(entry: GatewaySessionEntry): string {
  if (entry.origin.label) return entry.origin.label;
  if (entry.channel === "cron") {
    const cronMatch = entry.sessionKey.match(/cron:([^:]+)/);
    return cronMatch ? `Cron: ${cronMatch[1].slice(0, 8)}` : "Cron Job";
  }
  const channelName = entry.channel.charAt(0).toUpperCase() + entry.channel.slice(1);
  return `${channelName} Session`;
}
