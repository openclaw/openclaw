import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  appendMemoryLoadTelemetry,
  buildTelemetryRecord,
  enforceMemoryLoadPolicy,
  resolveMemoryLoadPolicy,
} from "../tools/memory-load-policy.js";

function extractText(msg: AgentMessage): string {
  const m = msg as { content?: unknown };
  if (typeof m.content === "string") {
    return m.content;
  }
  if (!Array.isArray(m.content)) {
    return "";
  }
  const chunks: string[] = [];
  for (const block of m.content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const t = (block as { text?: unknown }).text;
      if (typeof t === "string") {
        chunks.push(t);
      }
    }
  }
  return chunks.join("\n");
}

function replaceText(msg: AgentMessage, text: string): AgentMessage {
  const source = msg as Record<string, unknown>;
  return {
    ...source,
    content: [{ type: "text", text }],
  } as AgentMessage;
}

function extractCandidatePathsFromToolResultText(text: string): string[] {
  const out = new Set<string>();
  const pathRegex = /"path"\s*:\s*"([^"]+)"/g;
  const citationRegex = /\b(memory\/[\w./-]+\.md|MEMORY\.md)\b/g;

  let m: RegExpExecArray | null;
  while ((m = pathRegex.exec(text)) !== null) {
    if (m[1]) {
      out.add(m[1]);
    }
  }
  while ((m = citationRegex.exec(text)) !== null) {
    if (m[1]) {
      out.add(m[1]);
    }
  }
  return [...out];
}

function isMemoryToolResult(msg: AgentMessage): boolean {
  const anyMsg = msg as { role?: unknown; type?: unknown; toolName?: unknown };
  const roleOk =
    anyMsg.role === "toolResult" || anyMsg.role === "tool" || anyMsg.type === "toolResult";
  const name = typeof anyMsg.toolName === "string" ? anyMsg.toolName : "";
  return roleOk && (name === "memory_search" || name === "memory_get");
}

export async function sanitizeMemoryToolResultsByPolicy(params: {
  messages: AgentMessage[];
  sessionKey?: string;
  taskId?: string;
}): Promise<AgentMessage[]> {
  if (!Array.isArray(params.messages) || params.messages.length === 0) {
    return params.messages;
  }

  const runtime = await resolveMemoryLoadPolicy();
  const out: AgentMessage[] = [];

  for (const msg of params.messages) {
    if (!isMemoryToolResult(msg)) {
      out.push(msg);
      continue;
    }

    const text = extractText(msg);
    const candidatePaths = extractCandidatePathsFromToolResultText(text);
    if (candidatePaths.length === 0) {
      out.push(msg);
      continue;
    }

    const decision = enforceMemoryLoadPolicy({
      query: "pre_prompt_memory_context_guard",
      candidatePaths,
      confidence: 1,
      missSignals: 0,
      policy: runtime.policy,
      mode: runtime.mode,
    });

    const denied = decision.deniedPaths.map((d) => d.path);
    if (runtime.mode.enforce && denied.length > 0) {
      const redacted = replaceText(
        msg,
        `[policy] memory snippet dropped by ${runtime.policy.version}; denied paths: ${denied.join(", ")}`,
      );
      out.push(redacted);
      await appendMemoryLoadTelemetry(
        buildTelemetryRecord({
          sessionKey: params.sessionKey,
          taskId: params.taskId,
          policyVersion: runtime.policy.version,
          query: "pre_prompt_memory_context_guard",
          candidatePaths,
          decision,
          violationCode: "MEMORY_CONTEXT_POLICY_DROP",
        }),
      );
      continue;
    }

    out.push(msg);
  }

  return out;
}
