import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AdaptedMessage, ClaudeSessionConfig, TokenUsage } from "./cli-delegation.types.js";

/**
 * Handle returned by createClaudeSession.
 * Wraps the SDK's Query object with a simpler interface.
 */
export interface ClaudeSessionHandle {
  /** Async iterable of SDK messages */
  messages: AsyncIterable<SDKMessage>;
  /** Interrupt the current turn */
  interrupt(): Promise<void>;
  /** Switch model mid-session */
  setModel(model?: string): Promise<void>;
  /** Shut down the session */
  close(): void;
}

/**
 * Creates a Claude session by delegating to the Claude CLI via the Agent SDK.
 *
 * Authentication is handled entirely by the CLI binary. The calling code
 * does NOT need to provide API keys, OAuth tokens, or any credentials.
 * The CLI reads them from ~/.claude/.
 */
export function createClaudeSession(
  config: ClaudeSessionConfig,
  prompt: string,
): ClaudeSessionHandle {
  const runtime = query({
    prompt,
    options: {
      pathToClaudeCodeExecutable: config.binaryPath,
      cwd: config.cwd,
      ...(config.model ? { model: config.model } : {}),
      ...(config.effort ? { effort: config.effort } : {}),
      ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}),
      ...(config.permissionMode === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(config.resumeSessionId ? { resume: config.resumeSessionId } : {}),
      ...(config.newSessionId ? { sessionId: config.newSessionId } : {}),
      settingSources: config.settingSources ?? ["user", "project", "local"],
      includePartialMessages: true,
      canUseTool: async () => ({ behavior: "allow" as const }),
      env: process.env as Record<string, string>,
      ...(config.cwd ? { additionalDirectories: [config.cwd] } : {}),
    },
  });

  return {
    messages: runtime,
    interrupt: () => runtime.interrupt(),
    setModel: (model) => runtime.setModel(model),
    close: () => runtime.close(),
  };
}

/**
 * Adapt an SDKMessage into OpenClaw's intermediate message format.
 *
 * This is the bridge between the Agent SDK's message stream and
 * OpenClaw's streaming contract.
 */
export function adaptSdkMessage(msg: SDKMessage): AdaptedMessage {
  switch (msg.type) {
    case "stream_event": {
      const event = msg as unknown as { event: Record<string, unknown> };
      const inner = event.event;
      if (inner.type === "content_block_delta") {
        const delta = inner.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          return { kind: "text_delta", text: delta.text };
        }
        if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
          return { kind: "thinking_delta", text: delta.thinking };
        }
      }
      return { kind: "ignored" };
    }

    case "assistant": {
      const content = (msg as unknown as { message?: { content?: unknown[] } }).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") {
            return { kind: "text_delta", text: b.text };
          }
        }
      }
      return { kind: "ignored" };
    }

    case "result": {
      const r = msg as unknown as {
        subtype: string;
        session_id?: string;
        usage?: {
          input_tokens: number;
          output_tokens: number;
          cache_read_input_tokens?: number;
        };
      };
      const usage: TokenUsage | undefined = r.usage
        ? {
            inputTokens: r.usage.input_tokens,
            outputTokens: r.usage.output_tokens,
            cacheReadTokens: r.usage.cache_read_input_tokens,
          }
        : undefined;
      return {
        kind: "result",
        status: r.subtype ?? "completed",
        sessionId: r.session_id,
        usage,
      };
    }

    default:
      return { kind: "ignored" };
  }
}
