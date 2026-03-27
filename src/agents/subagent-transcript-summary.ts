import { callGateway } from "../gateway/call.js";
import { extractAssistantText, stripToolMessages } from "./tools/sessions-helpers.js";

export type TranscriptSummary = {
  toolCalls: { name: string; hasError: boolean }[];
  toolErrorCount: number;
  lastAssistantText: string | undefined;
  totalMessages: number;
};

/**
 * Extract a compact summary from a session's chat history.
 * Uses the same chat.history gateway RPC as readLatestAssistantReply.
 */
export async function extractTranscriptSummary(params: {
  sessionKey: string;
  maxMessages?: number;
}): Promise<TranscriptSummary> {
  const limit = params.maxMessages ?? 200;
  let messages: unknown[] = [];
  try {
    const history = await callGateway<{ messages: Array<unknown> }>({
      method: "chat.history",
      params: { sessionKey: params.sessionKey, limit },
      timeoutMs: 15_000,
    });
    messages = Array.isArray(history?.messages) ? history.messages : [];
  } catch {
    // If we can't read history, return empty summary
    return { toolCalls: [], toolErrorCount: 0, lastAssistantText: undefined, totalMessages: 0 };
  }

  const toolCalls: { name: string; hasError: boolean }[] = [];
  let toolErrorCount = 0;
  let lastAssistantText: string | undefined;

  // Track tool_use IDs to match with tool_result errors
  const toolUseIds = new Map<string, string>(); // id -> name

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = (msg as { role?: unknown }).role;
    const content = (msg as { content?: unknown }).content;

    if (role === "assistant") {
      // Extract text and tool_use blocks
      const text = extractAssistantText(msg);
      if (text) {
        lastAssistantText = text;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") {
            continue;
          }
          const blockType = (block as { type?: unknown }).type;
          if (blockType === "tool_use") {
            const name = (block as { name?: unknown }).name;
            const id = (block as { id?: unknown }).id;
            if (typeof name === "string") {
              toolCalls.push({ name, hasError: false });
              if (typeof id === "string") {
                toolUseIds.set(id, name);
              }
            }
          }
        }
      }
    }

    if (role === "toolResult" || role === "tool") {
      const isError = (msg as { isError?: unknown }).isError === true;
      if (isError) {
        toolErrorCount++;
        // Try to match back to the tool call
        const toolUseId = (msg as { tool_use_id?: unknown }).tool_use_id;
        if (typeof toolUseId === "string") {
          const matchedName = toolUseIds.get(toolUseId);
          if (matchedName) {
            const call = toolCalls.find((c) => c.name === matchedName && !c.hasError);
            if (call) {
              call.hasError = true;
            }
          }
        }
      }
    }
  }

  const filtered = stripToolMessages(messages);
  return {
    toolCalls,
    toolErrorCount,
    lastAssistantText,
    totalMessages: filtered.length,
  };
}

/**
 * Build an augmented task message for a retry attempt.
 * Injects previous attempt context so the agent can continue from where it left off.
 */
export function formatTranscriptForRetry(params: {
  originalTask: string;
  summary: TranscriptSummary;
  retryNumber: number;
  maxRetries: number;
  failureReason?: string;
}): string {
  const { originalTask, summary, retryNumber, maxRetries, failureReason } = params;

  const errorTools = summary.toolCalls.filter((c) => c.hasError).map((c) => c.name);
  const truncatedProgress = summary.lastAssistantText
    ? summary.lastAssistantText.length > 1000
      ? summary.lastAssistantText.slice(0, 1000) + "..."
      : summary.lastAssistantText
    : "No progress captured";

  const lines: string[] = [
    `## RETRY ATTEMPT ${retryNumber}/${maxRetries}`,
    "",
    "### Previous Attempt Summary",
    `- Tools called: ${summary.toolCalls.length} (${summary.toolErrorCount} errors)`,
  ];

  if (errorTools.length > 0) {
    lines.push(`- Failed tools: ${errorTools.join(", ")}`);
  }

  lines.push(`- Last progress: ${truncatedProgress}`);

  if (failureReason) {
    lines.push(`- Failure reason: ${failureReason}`);
  }

  lines.push("", "### Original Task", originalTask, "", "### Instructions");
  lines.push("Continue from where the previous attempt left off. Do NOT restart from scratch.");
  lines.push("If the previous attempt hit a specific error, try a different approach.");

  return lines.join("\n");
}
