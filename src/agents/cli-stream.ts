import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  SimpleStreamOptions,
  StreamFunction,
  TextContent,
  ThinkingContent,
  Usage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai/dist/utils/event-stream.js";
import { randomUUID } from "node:crypto";
/**
 * CLI-backed StreamFn that routes model calls through the Claude Code
 * CLI subprocess with an MCP bridge for tool execution. Drop-in
 * replacement for streamSimple when the provider is a CLI backend.
 *
 * The CLI manages the tool loop internally (calling MCP tools, getting
 * results, continuing the conversation). The returned event stream
 * contains only the final text/thinking output. Tool events are
 * forwarded via the onStreamEvent callback for UI updates.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentStreamEvent } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { CliBackendConfig } from "../config/types.js";
import type { CliStreamEvent } from "./cli-runner/streaming.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildCliArgs,
  normalizeCliModel,
  resolvePromptInput,
  resolveSystemPromptUsage,
} from "./cli-runner/helpers.js";
import { stripSelfTalk } from "./cli-runner/session-history.js";
import { runStreamingCli } from "./cli-runner/streaming.js";
import { startMcpBridge } from "./mcp-bridge/parent.js";

const log = createSubsystemLogger("agent/cli-stream");

const MCP_BRIDGE_SERVER = fileURLToPath(new URL("./mcp-bridge/server.js", import.meta.url));

export type CliStreamFnParams = {
  /** Pi runner tools to expose via the MCP bridge. */
  tools: AnyAgentTool[];
  /** Resolved CLI backend configuration. */
  backend: CliBackendConfig;
  /** Provider identifier (e.g. "claude-cli"). */
  provider: string;
  /** OpenClaw config for session/model resolution. */
  config?: OpenClawConfig;
  /** Workspace directory for ephemeral CWD. */
  workspaceDir: string;
  /** Timeout for the CLI subprocess (ms). */
  timeoutMs: number;
  /** Callback for tool streaming events (UI updates). */
  onStreamEvent?: (event: AgentStreamEvent) => void;
  /** Callback for agent-level events (tool lifecycle, typing). */
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
};

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Serialize Pi SDK messages into a text prompt for the CLI. The CLI
 * receives a single prompt string via -p; the system prompt is passed
 * separately via --system-prompt.
 */
function serializeMessagesToPrompt(context: Context): string {
  const turns: string[] = [];
  for (const msg of context.messages) {
    if (msg.role === "user") {
      const content = msg.content;
      if (typeof content === "string") {
        turns.push(`<user>\n${content}\n</user>`);
      } else if (Array.isArray(content)) {
        const textParts = content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text);
        if (textParts.length > 0) {
          turns.push(`<user>\n${textParts.join("\n")}\n</user>`);
        }
      }
    } else if (msg.role === "assistant") {
      const textParts = msg.content
        .filter((b): b is TextContent => b.type === "text")
        .map((b) => b.text);
      if (textParts.length > 0) {
        turns.push(`<assistant>\n${textParts.join("\n")}\n</assistant>`);
      }
    }
    // Skip toolResult messages — the CLI handles tools internally
  }
  return turns.join("\n\n");
}

/**
 * Create a StreamFn that routes model calls through the Claude Code
 * CLI with Pi runner tools exposed via an MCP bridge.
 */
export function createCliStreamFn(params: CliStreamFnParams): StreamFunction {
  const { tools, backend, timeoutMs, onStreamEvent, onAgentEvent } = params;

  // The returned function matches the Pi SDK StreamFn signature
  return function cliStreamFn(
    _model,
    context: Context,
    _options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    log.info(
      `cliStreamFn called: tools=${tools.length} backend=${backend.command} messages=${context.messages.length}`,
    );
    const stream = createAssistantMessageEventStream();

    // Run the CLI subprocess asynchronously; push events into the
    // stream as they arrive.
    void runCliWithMcp(stream, context).catch((err) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`CLI stream failed: ${errorMsg}`);
      const errorMessage = buildPartialMessage([], errorMsg);
      stream.push({ type: "error", reason: "error", error: errorMessage });
    });

    return stream;
  };

  async function runCliWithMcp(
    stream: AssistantMessageEventStream,
    context: Context,
  ): Promise<void> {
    // Set up MCP bridge with Pi runner tools
    const socketId = randomUUID().slice(0, 8);
    const socketPath = path.join(os.tmpdir(), `openclaw-mcp-${socketId}.sock`);
    const bridge = await startMcpBridge({
      tools,
      socketPath,
    });

    // Write temp MCP config file
    const mcpConfigPath = path.join(os.tmpdir(), `openclaw-mcp-config-${socketId}.json`);
    const mcpConfig = {
      mcpServers: {
        openclaw: {
          command: process.execPath,
          args: [MCP_BRIDGE_SERVER],
          env: { OPENCLAW_MCP_SOCKET: socketPath },
        },
      },
    };
    await fs.writeFile(mcpConfigPath, JSON.stringify(mcpConfig), "utf-8");
    log.info(
      `MCP bridge started: socket=${socketPath} config=${mcpConfigPath} server=${MCP_BRIDGE_SERVER}`,
    );

    try {
      // Build CLI args: start with base args, modify for streaming + MCP
      const modelId = normalizeCliModel("default", backend);
      const systemPrompt = resolveSystemPromptUsage({
        backend,
        isNewSession: true,
        systemPrompt: context.systemPrompt,
      });
      const prompt = serializeMessagesToPrompt(context);
      const { argsPrompt } = resolvePromptInput({ backend, prompt });

      const baseArgs = [...(backend.args ?? [])];
      const args = buildCliArgs({
        backend,
        baseArgs,
        modelId,
        systemPrompt,
        promptArg: argsPrompt,
        useResume: false,
      });

      // Transform args for streaming mode:
      // 1. Replace --output-format json → stream-json
      // 2. Add --verbose
      // 3. Keep --tools "" (disable native CLI tools)
      // 4. Add MCP config for Pi runner tools
      const streamArgs: string[] = [];
      let skip = false;
      for (let i = 0; i < args.length; i++) {
        if (skip) {
          skip = false;
          continue;
        }
        // Replace json → stream-json
        if (args[i] === "json" && i > 0 && args[i - 1] === "--output-format") {
          streamArgs.push("stream-json");
          continue;
        }
        streamArgs.push(args[i]);
      }
      streamArgs.push("--verbose");
      streamArgs.push("--mcp-config", mcpConfigPath);
      streamArgs.push("--strict-mcp-config");

      // Build env (apply backend overrides and clearEnv)
      const env = { ...process.env, ...backend.env };
      for (const key of backend.clearEnv ?? []) {
        delete env[key];
      }

      // Use an ephemeral CWD to prevent the CLI from loading
      // project-level context (.claude/, CLAUDE.md, auto-memory)
      const ephemeralDir = path.join(os.tmpdir(), `openclaw-cli-stream-${socketId}`);
      await fs.mkdir(ephemeralDir, { recursive: true });

      // Collect text and thinking content from streaming events
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      let contentIndex = 0;
      let textStarted = false;
      let thinkingStarted = false;
      let cliUsage:
        | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
        | undefined;
      // Track tool names by callId so we can include them in result events
      const toolNameByCallId = new Map<string, string>();
      // Capture CLI errors so we can report them to the user
      let cliErrorMessage: string | undefined;

      // Emit the start event
      const partial = buildPartialMessage([], undefined);
      stream.push({ type: "start", partial });

      const result = await runStreamingCli({
        command: backend.command,
        args: streamArgs,
        cwd: ephemeralDir,
        env,
        timeoutMs,
        onEvent: (event: CliStreamEvent) => {
          handleStreamEvent(event);
        },
      });

      function handleStreamEvent(event: CliStreamEvent) {
        switch (event.type) {
          case "text": {
            if (!textStarted) {
              textStarted = true;
              stream.push({
                type: "text_start",
                contentIndex,
                partial: buildPartialMessage(textParts, undefined),
              });
            }
            textParts.push(event.text);
            stream.push({
              type: "text_delta",
              contentIndex,
              delta: event.text,
              partial: buildPartialMessage(textParts, undefined),
            });
            break;
          }
          case "thinking": {
            if (!thinkingStarted) {
              thinkingStarted = true;
              // End text block if open
              if (textStarted) {
                stream.push({
                  type: "text_end",
                  contentIndex,
                  content: textParts.join(""),
                  partial: buildPartialMessage(textParts, undefined),
                });
                contentIndex++;
                textStarted = false;
              }
              stream.push({
                type: "thinking_start",
                contentIndex,
                partial: buildPartialMessage(textParts, undefined),
              });
            }
            thinkingParts.push(event.text);
            stream.push({
              type: "thinking_delta",
              contentIndex,
              delta: event.text,
              partial: buildPartialMessage(textParts, undefined),
            });
            break;
          }
          case "tool_start": {
            // Do NOT emit text_end here. Pre-tool narration text
            // ("Let me check...", "Now let me look at...") is
            // internal agent reasoning, not final output. Leaving
            // the text block open lets the embedded subscribe
            // handler's onBlockReplyDiscard discard it as mid-stream
            // hedging rather than flushing it to the user.
            if (textStarted) {
              textStarted = false;
            }
            // Track name so we can include it in the result event
            toolNameByCallId.set(event.toolCallId, event.toolName);
            // Forward tool events for UI feedback but don't push
            // to the AssistantMessageEventStream
            onStreamEvent?.({
              type: "tool_start",
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              input: event.input,
            });
            onAgentEvent?.({
              stream: "tool",
              data: {
                phase: "start",
                name: event.toolName,
                toolCallId: event.toolCallId,
                args: event.input ?? {},
              },
            });
            break;
          }
          case "tool_result": {
            const toolName = toolNameByCallId.get(event.toolCallId) ?? "";
            onStreamEvent?.({
              type: "tool_result",
              toolCallId: event.toolCallId,
              toolName,
              isError: event.isError,
              outputPreview: event.outputPreview,
              lineCount: event.lineCount,
            });
            onAgentEvent?.({
              stream: "tool",
              data: {
                phase: "result",
                name: toolName,
                toolCallId: event.toolCallId,
                isError: event.isError,
                outputPreview: event.outputPreview,
                lineCount: event.lineCount,
              },
            });
            break;
          }
          case "result": {
            if (event.usage) {
              cliUsage = event.usage;
            }
            break;
          }
          case "error": {
            log.warn(`CLI stream error: ${event.message}`);
            cliErrorMessage = event.message;
            break;
          }
        }
      }

      // Close any open content blocks
      if (thinkingStarted) {
        stream.push({
          type: "thinking_end",
          contentIndex,
          content: thinkingParts.join(""),
          partial: buildPartialMessage(textParts, undefined),
        });
        contentIndex++;
      }
      if (textStarted) {
        stream.push({
          type: "text_end",
          contentIndex,
          content: textParts.join(""),
          partial: buildPartialMessage(textParts, undefined),
        });
        contentIndex++;
      }

      // If we got a result text but no streaming text events, emit
      // the result as a single text block
      if (!textParts.length && result.text) {
        stream.push({
          type: "text_start",
          contentIndex,
          partial: buildPartialMessage([result.text], undefined),
        });
        stream.push({
          type: "text_delta",
          contentIndex,
          delta: result.text,
          partial: buildPartialMessage([result.text], undefined),
        });
        stream.push({
          type: "text_end",
          contentIndex,
          content: result.text,
          partial: buildPartialMessage([result.text], undefined),
        });
      }

      // Build final message and emit done. Strip any self-talk
      // (fabricated [User]/[Assistant] continuation turns) from the
      // collected text before building the final message.
      const rawText = textParts.length > 0 ? textParts.join("") : result.text;
      const finalText = rawText ? stripSelfTalk(rawText) : rawText;
      const usage = cliUsage
        ? {
            input: cliUsage.input ?? 0,
            output: cliUsage.output ?? 0,
            cacheRead: cliUsage.cacheRead ?? 0,
            cacheWrite: cliUsage.cacheWrite ?? 0,
            totalTokens: (cliUsage.input ?? 0) + (cliUsage.output ?? 0),
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          }
        : emptyUsage();

      // Propagate CLI errors: when the CLI exits with a non-zero code
      // and produced no text, report it as an error so the user sees
      // the failure instead of a silent no-response.
      const isCliError = result.exitCode !== 0 && !finalText;
      const errorMessage = isCliError
        ? cliErrorMessage || result.stderr || `CLI exited with code ${result.exitCode}`
        : undefined;

      const finalMessage: AssistantMessage = {
        role: "assistant",
        content: [
          ...(thinkingParts.length > 0
            ? [{ type: "thinking" as const, thinking: thinkingParts.join("") }]
            : []),
          ...(finalText ? [{ type: "text" as const, text: finalText }] : []),
        ],
        api: "messages" as AssistantMessage["api"],
        provider: "anthropic" as AssistantMessage["provider"],
        model: "cli",
        usage,
        stopReason: isCliError ? "error" : "stop",
        errorMessage,
        timestamp: Date.now(),
      };

      if (isCliError) {
        stream.push({ type: "error", reason: "error", error: finalMessage });
      } else {
        stream.push({ type: "done", reason: "stop", message: finalMessage });
      }

      // Clean up ephemeral directory
      await fs.rm(ephemeralDir, { recursive: true, force: true }).catch(() => {});
    } finally {
      // Clean up MCP bridge and temp config
      await bridge.cleanup();
      await fs.unlink(mcpConfigPath).catch(() => {});
    }
  }
}

function buildPartialMessage(
  textParts: string[],
  errorMessage: string | undefined,
): AssistantMessage {
  const content: (TextContent | ThinkingContent)[] = [];
  if (textParts.length > 0) {
    content.push({ type: "text", text: textParts.join("") });
  }
  return {
    role: "assistant",
    content,
    api: "messages" as AssistantMessage["api"],
    provider: "anthropic" as AssistantMessage["provider"],
    model: "cli",
    usage: emptyUsage(),
    stopReason: "stop",
    errorMessage,
    timestamp: Date.now(),
  };
}
