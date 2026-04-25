import { spawn, ChildProcess } from "child_process";
// src/agents/lmstudio-native-provider.ts
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type StopReason,
  type ToolCall,
} from "@mariozechner/pi-ai";
import { normalizeContextMessages } from "./tool-protocol.js";
import { ToolRuntime } from "./tool-runtime.js";

function now() {
  return Date.now();
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function emptyMessage(model: any): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop" as StopReason,
    timestamp: now(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textMessage(model: any, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop" as StopReason,
    timestamp: now(),
  };
}

// =====================
// PERSISTENT SHELL (PTY)
// =====================
let persistentShell: ChildProcess | null = null;
let shellOutputBuffer = "";
let shellPendingResolve: ((value: string) => void) | null = null;
let shellTimer: NodeJS.Timeout | null = null;

function getPersistentShell(): ChildProcess {
  if (persistentShell) {
    return persistentShell;
  }

  const isWin = process.platform === "win32";
  const shellCmd = isWin ? "bash" : process.env.SHELL || "bash";

  persistentShell = spawn(shellCmd, [], {
    env: { ...process.env, TERM: "xterm-256color" },
    cwd: process.cwd(),
    windowsHide: true,
  });

  persistentShell.stdout?.on("data", (data: Buffer) => {
    shellOutputBuffer += data.toString();
    if (shellTimer) {
      clearTimeout(shellTimer);
    }
    shellTimer = setTimeout(() => {
      if (shellPendingResolve) {
        shellPendingResolve(shellOutputBuffer);
        shellPendingResolve = null;
        shellOutputBuffer = "";
      }
    }, 500);
  });

  persistentShell.stderr?.on("data", (data: Buffer) => {
    shellOutputBuffer += data.toString();
  });

  persistentShell.on("exit", () => {
    persistentShell = null;
  });

  return persistentShell;
}

function execInShell(command: string, timeoutMs = 120000): Promise<string> {
  return new Promise((resolve) => {
    const shell = getPersistentShell();
    shellOutputBuffer = "";

    const timeout = setTimeout(() => {
      if (shellPendingResolve === resolve) {
        shellPendingResolve = null;
        resolve(shellOutputBuffer || "[timeout - no output]");
      }
    }, timeoutMs);

    shellPendingResolve = (output: string) => {
      clearTimeout(timeout);
      resolve(output);
    };

    shell.stdin?.write(command + "\n");
  });
}

// =====================
// LIQUID PARSING
// =====================
function recoverToolCall(raw: string) {
  try {
    const match = raw.match(/(\w+)\((.*)\)/);
    if (!match) {
      return null;
    }
    const name = match[1];
    const argsRaw = match[2];
    try {
      const args = JSON.parse(argsRaw);
      return { name, args };
    } catch {
      return { name, args: { command: argsRaw } };
    }
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractToolCallFromText(text: string): { name: string; args: any } | null {
  const regex = /<\|tool_call_start\|>(\w+)\((.*?)\)<\|tool_call_end\|>/;
  const match = text.match(regex);
  if (!match) {
    return null;
  }
  const name = match[1];
  const argsStr = match[2];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args: Record<string, any> = {};
  const argPairs = argsStr.split(",").map((p) => p.trim());
  for (const pair of argPairs) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex > 0) {
      const key = pair.substring(0, eqIndex).trim();
      let value = pair.substring(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.substring(1, value.length - 1);
      }
      args[key] = value;
    }
  }
  return { name, args };
}

export function parseLiquidResponse(content: string): {
  type: "text" | "tool" | "needs_tool";
  text?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolCalls?: Array<{ name: string; arguments: any }>;
} {
  const trimmed = content.trim();

  if (trimmed.startsWith("FINAL_RESULT:")) {
    const result = trimmed.substring("FINAL_RESULT:".length).trim();
    const firstLine = result.split("\n")[0];
    if (firstLine === "tool_call_required") {
      return { type: "needs_tool", text: firstLine };
    }
    return { type: "text", text: firstLine };
  }

  if (trimmed.startsWith("tool")) {
    const afterTool = trimmed.substring("tool".length).trim();
    const toolMatch = afterTool.match(/(\w+)\((.*)\)/s);
    if (toolMatch) {
      const toolName = toolMatch[1];
      const argsStr = toolMatch[2];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: Record<string, any> = {};
      const argPairs = argsStr.split(",").map((p) => p.trim());
      for (const pair of argPairs) {
        const eqIndex = pair.indexOf("=");
        if (eqIndex > 0) {
          const key = pair.substring(0, eqIndex).trim();
          let value = pair.substring(eqIndex + 1).trim();
          if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
          ) {
            value = value.substring(1, value.length - 1);
          }
          args[key] = value;
        }
      }
      return { type: "tool", toolCalls: [{ name: toolName, arguments: args }] };
    }
  }

  return { type: "text", text: trimmed };
}

// =====================
// SYSTEM PROMPT (maximal kurz, null Toleranz für Gelaber)
// =====================
const SYSTEM_PROMPT = `Nur Werkzeuge aus der Liste benutzen. Keine eigenen Werkzeuge erfinden.
Endungen: .py .sh .js .txt .md sind lokale DATEIEN, NIE als Tool-Namen verwenden.
Datei ausführen → shell "python datei.py". Datei löschen → shell "rm datei.txt".
Antworte in genau EINEM Satz. Kein Goal/Progress. Keine Erklärungen.`;

// =====================
// HELPER: Stream-Protokoll
// =====================
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sendTextBlock(stream: any, model: any, text: string, isFinal = false): AssistantMessage {
  const partial = emptyMessage(model);

  stream.push({ type: "text_start", contentIndex: 0, partial });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial });

  if (isFinal) {
    const msg = textMessage(model, text);
    stream.push({ type: "done", reason: "stop", message: msg });
  }

  return textMessage(model, text);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function endStreamWithError(stream: any, model: any, errorText: string): void {
  const msg = textMessage(model, errorText);
  stream.push({ type: "text_start", contentIndex: 0, partial: emptyMessage(model) });
  stream.push({
    type: "text_delta",
    contentIndex: 0,
    delta: errorText,
    partial: emptyMessage(model),
  });
  stream.push({
    type: "text_end",
    contentIndex: 0,
    content: errorText,
    partial: emptyMessage(model),
  });
  stream.push({ type: "done", reason: "stop", message: msg });
  stream.end();
}

// =====================
// MAIN PROVIDER
// =====================
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function streamLMStudioNative(model: any, params: any, options?: { apiKey?: string }) {
  const stream = createAssistantMessageEventStream();

  const lastMessage = params.messages?.[params.messages.length - 1];
  const isResetCommand =
    lastMessage?.role === "user" &&
    typeof lastMessage.content === "string" &&
    lastMessage.content.trim().toLowerCase() === "/reset";

  if (isResetCommand) {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    (async () => {
      stream.push({ type: "start", partial: emptyMessage(model) });
      if (persistentShell) {
        persistentShell.kill();
        persistentShell = null;
      }
      sendTextBlock(stream, model, "Session zurückgesetzt.", true);
      stream.end();
    })();
    return stream;
  }

  const explicitTools = params.tools || [];
  const runtime = new ToolRuntime(explicitTools);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runtimeTools: any[] =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    typeof (runtime as any).getAllTools === "function"
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (runtime as any).getAllTools()
      : explicitTools;
  const allTools = [...runtimeTools];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const availableToolNames = new Set(allTools.map((t: any) => t.name));

  const base = model.baseUrl.replace(/\/v1$/, "").replace(/\/$/, "");
  const endpoint = `${base}/v1/messages`;

  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  (async () => {
    let isStreamEnded = false;
    try {
      stream.push({ type: "start", partial: emptyMessage(model) });
      sendTextBlock(stream, model, "Arbeite…", false);

      let messages = normalizeContextMessages(params.messages || []);
      messages = (messages as Array<{ role: string }>).filter((m) => m.role !== "system");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anthropicMessages: Array<any> = [];
      for (const msg of messages) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let content: any = (msg as { content: unknown }).content;
        if (typeof content === "string") {
          /* ok */
        } else if (Array.isArray(content)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hasToolBlocks = content.some((block: any) => {
            const t = block as { type: string };
            return t.type === "tool_use" || t.type === "tool_result";
          });
          if (!hasToolBlocks) {
            const textParts = content
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .filter((block: any) => (block as { type: string }).type === "text")
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .map((block: any) => (block as { text: string }).text);
            content = textParts.join(" ");
          }
        } else if (content === null || content === undefined) {
          content = "";
        } else {
          content = typeof content === "string" ? content : JSON.stringify(content);
        }

        const role = (msg as { role: string }).role;
        if (role === "user" || role === "assistant") {
          anthropicMessages.push({ role, content });
        } else if (role === "tool") {
          const toolMsg = msg as { tool_call_id?: string };
          if (toolMsg.tool_call_id) {
            anthropicMessages.push({
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolMsg.tool_call_id,
                  content: typeof content === "string" ? content : JSON.stringify(content),
                },
              ],
            });
          } else {
            anthropicMessages.push({ role: "user", content: `Result: ${String(content)}` });
          }
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tools = allTools.map((tool: any) => ({
        name: tool.name,
        description: tool.description || "No description",
        input_schema: tool.parameters || { type: "object", properties: {}, required: [] },
      }));

      let toolCallCount = 0;
      const seenToolPatterns = new Set<string>();
      const TIMEOUT_MS = 300000;
      const MAX_TOKENS = 128;
      const MAX_ROUNDS = 8;

      let currentMessages = [...anthropicMessages];
      let round = 0;
      let finalResponseText = "";

      while (round < MAX_ROUNDS && !isStreamEnded) {
        round++;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const requestBody: Record<string, any> = {
          model: model.id,
          max_tokens: MAX_TOKENS,
          messages: currentMessages,
          system: SYSTEM_PROMPT,
        };
        if (tools.length > 0) {
          requestBody.tools = tools;
          requestBody.tool_choice = { type: "auto" };
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": options?.apiKey || "" },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`API error ${res.status}: ${text}`);
        }

        const json = (await res.json()) as { content?: unknown[] };
        const contentBlocks = json.content || [];
        let responseText = "";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toolUseBlocks: any[] = [];
        for (const block of contentBlocks) {
          const b = block as { type: string; text?: string };
          if (b.type === "text" && typeof b.text === "string") {
            responseText += b.text;
          } else if (b.type === "tool_use") {
            toolUseBlocks.push(block);
          }
        }

        if (toolUseBlocks.length === 0 && responseText) {
          const recovered = recoverToolCall(responseText);
          if (recovered && availableToolNames.has(recovered.name)) {
            toolUseBlocks.push({
              name: recovered.name,
              input: recovered.args,
              id: `recovered_${Date.now()}`,
            });
          } else {
            const parsed = parseLiquidResponse(responseText);
            if (parsed.type === "tool" && parsed.toolCalls) {
              for (const tc of parsed.toolCalls) {
                if (availableToolNames.has(tc.name)) {
                  toolUseBlocks.push({
                    name: tc.name,
                    input: tc.arguments,
                    id: `parsed_${Date.now()}_${Math.random()}`,
                  });
                }
              }
              if (toolUseBlocks.length === 0) {
                responseText = parsed.text || responseText;
              }
            } else if (parsed.type === "text") {
              responseText = parsed.text || responseText;
            }
          }
        }

        if (toolUseBlocks.length === 0) {
          finalResponseText = responseText;
          sendTextBlock(stream, model, finalResponseText || "(no response)", true);
          isStreamEnded = true;
          break;
        }

        toolCallCount++;
        if (toolCallCount > 8) {
          endStreamWithError(stream, model, "Too many tool calls");
          isStreamEnded = true;
          break;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const signature = JSON.stringify(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          toolUseBlocks.map((t: any) => t.name + JSON.stringify(t.input)),
        );
        if (seenToolPatterns.has(signature)) {
          endStreamWithError(stream, model, "Repeated tool loop");
          isStreamEnded = true;
          break;
        }
        seenToolPatterns.add(signature);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const assistantContentBlocks: any[] = [];
        if (responseText) {
          assistantContentBlocks.push({ type: "text", text: responseText });
        }
        for (const toolUse of toolUseBlocks) {
          assistantContentBlocks.push({
            type: "tool_use",
            id: toolUse.id || `call_${Date.now()}`,
            name: toolUse.name,
            input: toolUse.input || {},
          });
        }
        currentMessages.push({ role: "assistant", content: assistantContentBlocks });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toolResults: any[] = [];
        for (const toolUse of toolUseBlocks) {
          const name = toolUse.name;
          const toolUseId = toolUse.id || `call_${Date.now()}`;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let args: Record<string, any> = toolUse.input || {};
          if (args.path) {
            args.path = args.path.replace(/\\/g, "/");
          }
          if (args.file_path) {
            args.file_path = args.file_path.replace(/\\/g, "/");
          }
          if (args.directory) {
            args.directory = args.directory.replace(/\\/g, "/");
          }

          const toolCall: ToolCall = { id: toolUseId, type: "toolCall", name, arguments: args };
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: emptyMessage(model) });

          let result;
          try {
            if (name === "shell" && args.command) {
              result = { success: true, data: await execInShell(args.command, 120000) };
            } else {
              result = await runtime.run(name, args, toolCall.id);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (err: any) {
            result = { success: false, data: `ERROR: ${String(err)}` };
          }

          const content = result?.data ?? "ERROR: Unknown failure";
          stream.push({
            type: "toolcall_end",
            contentIndex: 0,
            toolCall,
            partial: emptyMessage(model),
          });
          sendTextBlock(stream, model, `${name} erledigt.`, false);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUseId,
            content: String(content),
          });
        }
        if (toolResults.length > 0) {
          currentMessages.push({ role: "user", content: toolResults });
        }
      }

      if (round >= MAX_ROUNDS && !isStreamEnded) {
        sendTextBlock(stream, model, (finalResponseText || "") + "\n[Max rounds]", true);
        isStreamEnded = true;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      endStreamWithError(stream, model, `Error: ${String(err?.message || err)}`);
      isStreamEnded = true;
    } finally {
      if (!isStreamEnded) {
        try {
          stream.end();
        } catch {
          /* double end */
        }
        isStreamEnded = true;
      }
    }
  })();

  return stream;
}

export const streamSimpleLMStudioNative = streamLMStudioNative;
