// SoundChain Forge — BYOK Agent Loop
// Accepts API key per-request. Key flows in memory only, never stored on disk.
// Calls Anthropic → handles tool_use → executes forge tools → loops → streams SSE.
// The operator's console. The warroom desk.

import type { ServerResponse } from "node:http";

// Minimal tool interface — works standalone without OpenClaw dependency
interface ForgeTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute: (id: string, params: Record<string, unknown>) => Promise<any>;
}

// ─── Enums ───────────────────────────────────────────────────────────
const AGENT_STATUS = {
  RUNNING: "RUNNING",
  DONE: "DONE",
  ERROR: "ERROR",
  MAX_TURNS: "MAX_TURNS",
} as const;

// ─── Config ──────────────────────────────────────────────────────────
const MAX_TURNS = 15;
const MAX_MSG_LEN = 8000;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

const FORGE_SYSTEM = `You are SMITH FORGE — a full coding agent in the SoundChain forge.
You have 7 tools: forge_read, forge_write, forge_edit, forge_bash, forge_git, forge_glob, forge_grep.
You are operating on the SoundChain codebase. Use your tools to complete coding tasks.

Rules:
- Read files before editing them. Understand existing code first.
- Use forge_git for safe git operations (status, diff, log, add, commit, push).
- Use forge_bash for running commands (build, test, install).
- Be direct. Complete the task, show what you did.
- Never force-push, never delete branches without asking.
- Keep explanations concise. Show code changes clearly.

Identity: SMITH FORGE · Signature: SC-FURL-THE-ONE · Runtime: EC2
Twin: FURL (browser-side) · Platform: SoundChain (soundchain.io)`;

// ─── SSE Emitter ─────────────────────────────────────────────────────

function setupSSE(res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  });

  return (event: Record<string, unknown>) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // Client disconnected
    }
  };
}

// ─── Tool Definitions → Anthropic Format ─────────────────────────────

function toolsToAnthropic(tools: ForgeTool[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description || "",
    input_schema: t.parameters || { type: "object" as const, properties: {} },
  }));
}

// ─── Anthropic Streaming Parser ──────────────────────────────────────
// Parses SSE from Anthropic Messages API, extracts text deltas and tool_use blocks.

interface ToolUse {
  id: string;
  name: string;
  inputJson: string;
}

interface ParsedResponse {
  textParts: string[];
  toolUses: ToolUse[];
  stopReason: string;
}

async function streamAnthropicResponse(
  body: ReadableStream<Uint8Array>,
  emit: (event: Record<string, unknown>) => void,
): Promise<ParsedResponse> {
  const reader = (body as any).getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const textParts: string[] = [];
  const toolUses: ToolUse[] = [];
  let stopReason = "";
  let currentBlockType = "";
  let currentToolInputJson = "";
  let accumulatedText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data);

        if (parsed.type === "content_block_start") {
          const block = parsed.content_block;
          if (block.type === "text") {
            currentBlockType = "text";
          } else if (block.type === "tool_use") {
            currentBlockType = "tool_use";
            currentToolInputJson = "";
            toolUses.push({ id: block.id, name: block.name, inputJson: "" });
            emit({ type: "tool_start", name: block.name, id: block.id });
          }
        }

        if (parsed.type === "content_block_delta") {
          if (parsed.delta?.type === "text_delta" && parsed.delta.text) {
            emit({ type: "delta", text: parsed.delta.text });
            accumulatedText += parsed.delta.text;
          }
          if (parsed.delta?.type === "input_json_delta") {
            currentToolInputJson += parsed.delta.partial_json || "";
          }
        }

        if (parsed.type === "content_block_stop") {
          if (currentBlockType === "text") {
            textParts.push(accumulatedText);
            accumulatedText = "";
          } else if (currentBlockType === "tool_use" && toolUses.length > 0) {
            toolUses[toolUses.length - 1].inputJson = currentToolInputJson;
          }
          currentBlockType = "";
        }

        if (parsed.type === "message_delta") {
          stopReason = parsed.delta?.stop_reason || "";
        }
      } catch {
        // Skip malformed SSE lines
      }
    }
  }

  // Capture any remaining text
  if (accumulatedText) textParts.push(accumulatedText);

  return { textParts, toolUses, stopReason };
}

// ─── The Agent Loop ──────────────────────────────────────────────────
// BYOK: API key in, SSE out. Key never touches disk.

export async function runForgeAgent(
  res: ServerResponse,
  apiKey: string,
  userMessages: Array<{ role: string; content: string }>,
  tools: ForgeTool[],
  model?: string,
) {
  const emit = setupSSE(res);
  emit({ type: "start", provider: "FORGE" });

  const anthropicTools = toolsToAnthropic(tools);
  const useModel = model || DEFAULT_MODEL;

  // Build initial messages
  const messages: any[] = userMessages.map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: String(m.content).slice(0, MAX_MSG_LEN),
  }));

  let status: string = AGENT_STATUS.RUNNING;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // ─── Call Anthropic ────────────────────────────────────────────
    let anthropicRes: Response;
    try {
      anthropicRes = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: useModel,
          max_tokens: 4096,
          stream: true,
          system: FORGE_SYSTEM,
          tools: anthropicTools,
          messages,
        }),
      });
    } catch (err: any) {
      emit({ type: "error", text: `Network error: ${err.message}` });
      res.end();
      return;
    }

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => "Unknown");
      emit({
        type: "error",
        text: `Anthropic ${anthropicRes.status}: ${errText.slice(0, 300)}`,
      });
      res.end();
      return;
    }

    const body = anthropicRes.body as any;
    if (!body?.getReader) {
      emit({ type: "error", text: "No streaming support on this runtime" });
      res.end();
      return;
    }

    // ─── Stream and parse response ─────────────────────────────────
    const { textParts, toolUses, stopReason } = await streamAnthropicResponse(body, emit);

    // ─── End turn — no tool calls ──────────────────────────────────
    if (stopReason !== "tool_use" || toolUses.length === 0) {
      status = AGENT_STATUS.DONE;
      break;
    }

    // ─── Build assistant message (text + tool_use blocks) ──────────
    const assistantContent: any[] = [];
    for (const tp of textParts) {
      if (tp) assistantContent.push({ type: "text", text: tp });
    }
    for (const tu of toolUses) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tu.inputJson);
      } catch {
        input = {};
      }
      assistantContent.push({
        type: "tool_use",
        id: tu.id,
        name: tu.name,
        input,
      });
    }

    messages.push({ role: "assistant", content: assistantContent });

    // ─── Execute tools ─────────────────────────────────────────────
    const toolResults: any[] = [];

    for (const tu of toolUses) {
      const tool = tools.find((t) => t.name === tu.name);
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tu.inputJson);
      } catch {
        input = {};
      }

      let resultText = "";

      if (!tool) {
        resultText = `Unknown tool: ${tu.name}`;
      } else {
        emit({ type: "delta", text: `\n⚙ ${tu.name}...` });
        try {
          const result = await tool.execute("forge-agent", input);
          resultText = result?.content?.[0]?.text || JSON.stringify(result);
          emit({ type: "delta", text: " done\n" });
        } catch (err: any) {
          resultText = `Tool error: ${err.message}`;
          emit({ type: "delta", text: ` error: ${err.message}\n` });
        }
      }

      emit({
        type: "tool_result",
        name: tu.name,
        id: tu.id,
        preview: resultText.slice(0, 200),
      });

      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: resultText.slice(0, 30000), // Cap tool output
      });
    }

    // Add tool results as user message (Anthropic format)
    messages.push({ role: "user", content: toolResults });

    // Loop continues — Claude will respond to tool results
  }

  if (status !== AGENT_STATUS.DONE) {
    emit({ type: "delta", text: "\n\n[Reached max tool turns]" });
  }

  emit({ type: "done" });
  res.end();
}
