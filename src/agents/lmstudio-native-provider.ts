// src/agents/lmstudio-native-provider.ts
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type StopReason,
  type ToolCall,
} from "@mariozechner/pi-ai";

import { spawn, ChildProcess } from "child_process";
import { ToolRuntime } from "./tool-runtime.js";
import {
  normalizeContextMessages,
  safeJsonParse,
} from "./tool-protocol.js";

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
  if (persistentShell) return persistentShell;
  
  const isWin = process.platform === 'win32';
  const shellCmd = isWin ? 'bash' : (process.env.SHELL || 'bash');
  
  persistentShell = spawn(shellCmd, [], {
    env: { ...process.env, TERM: 'xterm-256color' },
    cwd: process.cwd(),
    windowsHide: true,
  });
  
  persistentShell.stdout?.on('data', (data: Buffer) => {
    shellOutputBuffer += data.toString();
    if (shellTimer) clearTimeout(shellTimer);
    shellTimer = setTimeout(() => {
      if (shellPendingResolve) {
        shellPendingResolve(shellOutputBuffer);
        shellPendingResolve = null;
        shellOutputBuffer = "";
      }
    }, 300);
  });
  
  persistentShell.stderr?.on('data', (data: Buffer) => {
    shellOutputBuffer += data.toString();
  });
  
  persistentShell.on('exit', () => {
    persistentShell = null;
  });
  
  return persistentShell;
}

function execInShell(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const shell = getPersistentShell();
    shellOutputBuffer = "";
    
    const timeout = setTimeout(() => {
      if (shellPendingResolve === resolve) {
        shellPendingResolve = null;
        resolve(shellOutputBuffer || "[no output]");
      }
    }, 30000);
    
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
    if (!match) return null;
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

export function extractToolCallFromText(text: string): { name: string; args: any } | null {
  const regex = /<\|tool_call_start\|>(\w+)\((.*?)\)<\|tool_call_end\|>/;
  const match = text.match(regex);
  if (!match) return null;
  const name = match[1];
  const argsStr = match[2];
  const args: Record<string, any> = {};
  const argPairs = argsStr.split(',').map(p => p.trim());
  for (const pair of argPairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex > 0) {
      const key = pair.substring(0, eqIndex).trim();
      let value = pair.substring(eqIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.substring(1, value.length - 1);
      }
      args[key] = value;
    }
  }
  return { name, args };
}

export function parseLiquidResponse(content: string): {
  type: 'text' | 'tool' | 'needs_tool';
  text?: string;
  toolCalls?: Array<{ name: string; arguments: any }>;
} {
  const trimmed = content.trim();
  
  if (trimmed.startsWith('FINAL_RESULT:')) {
    const result = trimmed.substring('FINAL_RESULT:'.length).trim();
    const firstLine = result.split('\n')[0];
    if (firstLine === 'tool_call_required') {
      return { type: 'needs_tool', text: firstLine };
    }
    return { type: 'text', text: firstLine };
  }
  
  if (trimmed.startsWith('tool')) {
    const afterTool = trimmed.substring('tool'.length).trim();
    const toolMatch = afterTool.match(/(\w+)\((.*)\)/s);
    if (toolMatch) {
      const toolName = toolMatch[1];
      const argsStr = toolMatch[2];
      const args: Record<string, any> = {};
      const argPairs = argsStr.split(',').map(p => p.trim());
      for (const pair of argPairs) {
        const eqIndex = pair.indexOf('=');
        if (eqIndex > 0) {
          const key = pair.substring(0, eqIndex).trim();
          let value = pair.substring(eqIndex + 1).trim();
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.substring(1, value.length - 1);
          }
          args[key] = value;
        }
      }
      return { type: 'tool', toolCalls: [{ name: toolName, arguments: args }] };
    }
  }
  
  return { type: 'text', text: trimmed };
}

const SYSTEM_PROMPT = `You have tools. Use them directly. Answer briefly. For complex coding tasks, use the aider skill via bash tool.`;

export function streamLMStudioNative(
  model: any,
  params: any,
  options?: { apiKey?: string }
) {
  const stream = createAssistantMessageEventStream();

  const lastMessage = params.messages?.[params.messages.length - 1];
  const isResetCommand = lastMessage?.role === 'user' && 
    typeof lastMessage.content === 'string' && 
    lastMessage.content.trim().toLowerCase() === '/reset';

  if (isResetCommand) {
    (async () => {
      stream.push({ type: "start", partial: emptyMessage(model) });
      const resetResponse = "Session wurde zurückgesetzt. Wie kann ich dir helfen?";
      stream.push({ type: "text_start", contentIndex: 0, partial: emptyMessage(model) });
      stream.push({ type: "text_delta", contentIndex: 0, delta: resetResponse, partial: emptyMessage(model) });
      stream.push({ type: "text_end", contentIndex: 0, content: resetResponse, partial: emptyMessage(model) });
      stream.push({ type: "done", reason: "stop", message: textMessage(model, resetResponse) });
      stream.end();
    })();
    return stream;
  }

  const allTools = params.tools || [];
  const availableToolNames = new Set(allTools.map((t: any) => t.name));
  const runtime = new ToolRuntime(allTools);

  const base = model.baseUrl.replace(/\/v1$/, "").replace(/\/$/, "");
  const endpoint = `${base}/v1/messages`;

  (async () => {
    try {
      stream.push({ type: "start", partial: emptyMessage(model) });
      
      let messages = normalizeContextMessages(params.messages || []);
      messages = messages.filter(m => m.role !== "system");

      const anthropicMessages: Array<any> = [];
      for (const msg of messages) {
        let content: any = msg.content;
        if (typeof content === 'string') {
          // OK
        } else if (Array.isArray(content)) {
          const textParts = content.filter((p: any) => p.type === 'text').map((p: any) => p.text);
          content = textParts.join(' ');
        } else if (content === null || content === undefined) {
          content = "";
        } else {
          content = String(content);
        }

        if (msg.role === 'user' || msg.role === 'assistant') {
          anthropicMessages.push({ role: msg.role, content: content });
        } else if (msg.role === 'tool') {
          anthropicMessages.push({ role: 'user', content: `Result: ${content}` });
        }
      }

      const tools = allTools.map((tool: any) => ({
        name: tool.name,
        description: tool.description || "No description",
        input_schema: tool.parameters || { type: "object", properties: {}, required: [] },
      }));

      const TIMEOUT_MS = 120000;
      const MAX_ROUNDS = 8;

      let currentMessages = [...anthropicMessages];
      let round = 0;
      let finalResponseText = "";

      while (round < MAX_ROUNDS) {
        round++;
        
        const requestBody: any = {
          model: model.id,
          max_tokens: 512,
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
          headers: {
            "Content-Type": "application/json",
            "x-api-key": options?.apiKey || "",
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`API error ${res.status}: ${text}`);
        }

        const json = await res.json();
        const contentBlocks = json.content || [];
        const stopReason = json.stop_reason;

        let responseText = "";
        const toolUseBlocks: any[] = [];

        for (const block of contentBlocks) {
          if (block.type === 'text') {
            responseText += block.text;
          } else if (block.type === 'tool_use') {
            toolUseBlocks.push(block);
          }
        }

        // Fallback: Versuche Tool-Call aus Text zu parsen
        if (toolUseBlocks.length === 0 && responseText) {
          const recovered = recoverToolCall(responseText);
          if (recovered) {
            toolUseBlocks.push({
              name: recovered.name,
              input: recovered.args,
              id: `recovered_${Date.now()}`
            });
          } else {
            const parsed = parseLiquidResponse(responseText);
            if (parsed.type === 'tool' && parsed.toolCalls) {
              for (const tc of parsed.toolCalls) {
                toolUseBlocks.push({
                  name: tc.name,
                  input: tc.arguments,
                  id: `parsed_${Date.now()}_${Math.random()}`
                });
              }
            } else if (parsed.type === 'text') {
              responseText = parsed.text || responseText;
            }
          }
        }

        if (toolUseBlocks.length === 0) {
          finalResponseText = responseText;
          if (finalResponseText) {
            stream.push({
              type: "text_start",
              contentIndex: 0,
              partial: emptyMessage(model),
            });
            stream.push({
              type: "text_delta",
              contentIndex: 0,
              delta: finalResponseText,
              partial: emptyMessage(model),
            });
            stream.push({
              type: "text_end",
              contentIndex: 0,
              content: finalResponseText,
              partial: emptyMessage(model),
            });
          }
          stream.push({
            type: "done",
            reason: "stop",
            message: textMessage(model, finalResponseText),
          });
          break;
        }

        for (const toolUse of toolUseBlocks) {
          const name = toolUse.name;
          
          if (!availableToolNames.has(name)) {
            const errorMsg = `Tool '${name}' not available.`;
            stream.push({
              type: "text_delta",
              contentIndex: 0,
              delta: errorMsg,
              partial: emptyMessage(model),
            });
            currentMessages.push({
              role: "assistant",
              content: `Tried to call '${name}' but unavailable.`
            });
            currentMessages.push({
              role: "user", 
              content: errorMsg
            });
            continue;
          }

          let args = toolUse.input || {};
          if (args.path) args.path = args.path.replace(/\\/g, '/');
          if (args.file_path) args.file_path = args.file_path.replace(/\\/g, '/');
          if (args.directory) args.directory = args.directory.replace(/\\/g, '/');

          const toolCall: ToolCall = {
            id: toolUse.id || `call_${Date.now()}`,
            type: "toolCall",
            name,
            arguments: args,
          };

          stream.push({
            type: "toolcall_start",
            contentIndex: 0,
            partial: emptyMessage(model),
          });

          let result;
          try {
            if (name === 'shell' && args.command) {
              // Persistente Shell nutzen statt runtime.run
              const output = await execInShell(args.command);
              result = { success: true, data: output };
            } else {
              result = await runtime.run(name, args, toolCall.id);
            }
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

          currentMessages.push({
            role: "assistant",
            content: [{ type: "tool_use", id: toolCall.id, name: name, input: args }]
          });
          
          currentMessages.push({
            role: "user",
            content: [{ type: "tool_result", tool_use_id: toolCall.id, content: String(content) }]
          });
        }
      }

      if (round >= MAX_ROUNDS && finalResponseText) {
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: finalResponseText + "\n[Max rounds reached]",
          partial: emptyMessage(model),
        });
        stream.push({
          type: "done",
          reason: "stop",
          message: textMessage(model, finalResponseText),
        });
      }

    } catch (err: any) {
      const errorText = String(err?.message || err);
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: `Error: ${errorText}`,
        partial: emptyMessage(model),
      });
      stream.push({ type: "done", reason: "stop", message: textMessage(model, errorText) });
    } finally {
      stream.end();
    }
  })();

  return stream;
}