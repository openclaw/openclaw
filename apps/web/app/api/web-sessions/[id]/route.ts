import { readFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveWebChatDir, resolveOpenClawStateDir } from "@/lib/workspace";
import { enrichSubagentSessionFromTranscript } from "@/lib/active-runs";
import { readIndex, writeIndex } from "../shared";

export const dynamic = "force-dynamic";

export type ChatLine = {
  id: string;
  role: "user" | "assistant";
  /** Plain text summary (always present, used for sidebar / backward compat). */
  content: string;
  /** Full UIMessage parts array — reasoning, tool calls, outputs, text.
   *  Present for sessions saved after the rich-persistence update;
   *  absent for older sessions (fall back to `content` as a text part). */
  parts?: Array<Record<string, unknown>>;
  timestamp: string;
};

/* ─── Agent session fallback helpers ─── */

function findAgentSessionFile(sessionId: string): string | null {
  const agentsDir = join(resolveOpenClawStateDir(), "agents");
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

function parseAgentTranscriptToChatLines(content: string): ChatLine[] {
  const lines = content.trim().split("\n").filter((l) => l.trim());
  const messages: ChatLine[] = [];
  const pendingToolCalls = new Map<string, { toolName: string; args?: unknown }>();
  let currentAssistant: ChatLine | null = null;

  const flushAssistant = () => {
    if (!currentAssistant) {return;}
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
      const toolCallId = msg.toolCallId as string ?? "";
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
          parts.push({
            type: "tool-invocation",
            toolCallId,
            toolName,
            args,
          });
        } else if (part.type === "tool_use" || part.type === "tool-call") {
          const toolName = (part.name ?? part.toolName ?? "unknown") as string;
          const toolCallId = (part.id ?? part.toolCallId ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2)}`) as string;
          const args = part.input ?? part.args ?? {};
          pendingToolCalls.set(toolCallId, { toolName, args });
          parts.push({
            type: "tool-invocation",
            toolCallId,
            toolName,
            args,
          });
        // Legacy inline tool results
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

/** GET /api/web-sessions/[id] — read all messages for a web chat session.
 *  Falls back to agent session directories when no web session is found,
 *  enabling ChatPanel to load cron run transcripts transparently. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (id.includes(":subagent:")) {
    enrichSubagentSessionFromTranscript(id);
  }
  const filePath = join(resolveWebChatDir(), `${id}.jsonl`);

  if (existsSync(filePath)) {
    const content = readFileSync(filePath, "utf-8");
    const messages: ChatLine[] = content
      .trim()
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line) as ChatLine; } catch { return null; }
      })
      .filter((m): m is ChatLine => m !== null);
    return Response.json({ id, messages });
  }

  // Fallback: search agent session directories (cron runs, CLI sessions)
  const agentFile = findAgentSessionFile(id);
  if (agentFile) {
    const content = readFileSync(agentFile, "utf-8");
    const messages = parseAgentTranscriptToChatLines(content);
    return Response.json(
      { id, messages },
      { headers: { "X-Session-Source": "agent" } },
    );
  }

  return Response.json({ error: "Session not found" }, { status: 404 });
}

/** DELETE /api/web-sessions/[id] — delete a web chat session */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const sessions = readIndex();
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx === -1) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  sessions.splice(idx, 1);
  writeIndex(sessions);

  const filePath = join(resolveWebChatDir(), `${id}.jsonl`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }

  return Response.json({ ok: true });
}

/** PATCH /api/web-sessions/[id] — update session metadata (e.g. rename) */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const sessions = readIndex();
  const session = sessions.find((s) => s.id === id);
  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  if (typeof body.title === "string") {
    session.title = body.title;
  }
  session.updatedAt = Date.now();
  writeIndex(sessions);

  return Response.json({ session });
}
