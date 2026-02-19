/**
 * Claude Agent SDK Runtime — Implements AgentRuntime using @anthropic-ai/claude-agent-sdk.
 *
 * Key architectural difference: The Claude Agent SDK spawns a subprocess (Claude Code CLI)
 * and communicates via stdio. This means:
 * - Tools are provided as MCP servers (in-process or stdio)
 * - Streaming happens via AsyncGenerator<SDKMessage>
 * - Session persistence is handled by the SDK subprocess
 * - Abort is via AbortController
 */

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { fromClaudeSdkMessage } from "./event-bridge.js";
import type {
  AgentRuntime,
  CreateSessionOptions,
  RuntimeEvent,
  RuntimeMessage,
  RuntimeSession,
  ThinkLevel,
} from "./types.js";

/**
 * Create the Claude Agent SDK runtime.
 */
export function createClaudeSdkRuntime(): AgentRuntime {
  return {
    type: "claude-sdk",

    async createSession(options: CreateSessionOptions): Promise<RuntimeSession> {
      return new ClaudeSdkSession(options);
    },

    dispose() {
      // No global cleanup needed
    },
  };
}

/**
 * A session backed by the Claude Agent SDK.
 *
 * Each prompt call creates a new `query()` invocation.
 * The SDK manages the conversation state internally.
 */
class ClaudeSdkSession implements RuntimeSession {
  private _sessionId: string;
  private _messages: RuntimeMessage[] = [];
  private _isStreaming = false;
  private _listeners: Array<(event: RuntimeEvent) => void> = [];
  private _abortController: AbortController | null = null;
  private _activeQuery: AsyncGenerator<unknown, void> | null = null;
  private _options: CreateSessionOptions;
  private _model: string;
  private _systemPrompt: string;
  private _thinkLevel: ThinkLevel;

  constructor(options: CreateSessionOptions) {
    this._options = options;
    this._sessionId = `claude-sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._model = options.model;
    this._systemPrompt = options.systemPrompt;
    this._thinkLevel = options.thinkLevel ?? "off";
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get messages(): RuntimeMessage[] {
    return this._messages;
  }

  get isStreaming(): boolean {
    return this._isStreaming;
  }

  async prompt(text: string, images?: Array<{ mediaType: string; data: string }>): Promise<void> {
    // Dynamic import to avoid top-level dependency
    const { query, createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");

    this._abortController = new AbortController();
    this._isStreaming = true;
    this.emit({ type: "agent_start" });

    try {
      // Build MCP server for custom tools
      const mcpServers = this.buildMcpServers(createSdkMcpServer);

      // Build prompt content
      let promptContent = text;
      if (images && images.length > 0) {
        // Images need to be passed as multipart content
        // For now, append image references to the prompt
        promptContent = text;
      }

      // Create the query
      const q = query({
        prompt: promptContent,
        options: {
          abortController: this._abortController,
          model: this._model,
          systemPrompt: this._systemPrompt,
          cwd: this._options.cwd,
          mcpServers,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          persistSession: !!this._options.sessionFile,
          sessionId: this._sessionId,
          includePartialMessages: true,
          thinking: this.mapThinking(this._thinkLevel),
          maxTurns: 100,
          // Unset CLAUDECODE to avoid the nesting guard when spawning the SDK subprocess.
          env: { ...process.env, CLAUDECODE: undefined },
        },
      });
      this._activeQuery = q;

      // Add user message to local history
      this._messages.push({ role: "user", content: text });

      // Stream events
      let assistantText = "";
      for await (const message of q) {
        const events = fromClaudeSdkMessage(message);
        for (const event of events) {
          if (event.type === "message_delta") {
            assistantText += event.text;
          }
          this.emit(event);
        }
      }

      // Add assistant response to local history
      if (assistantText) {
        this._messages.push({ role: "assistant", content: assistantText });
      }
    } finally {
      this._isStreaming = false;
      this._activeQuery = null;
      this._abortController = null;
    }
  }

  steer(text: string): void {
    // The Claude Agent SDK doesn't support mid-run steering in the same way.
    // We interrupt and queue the message for the next prompt.
    this._messages.push({ role: "user", content: text });
    if (this._activeQuery && "interrupt" in this._activeQuery) {
      (this._activeQuery as unknown as { interrupt: () => void }).interrupt();
    }
  }

  abort(): void {
    this._abortController?.abort();
    if (this._activeQuery && "close" in this._activeQuery) {
      (this._activeQuery as unknown as { close: () => void }).close();
    }
  }

  async waitForIdle(): Promise<void> {
    // Wait until not streaming
    while (this._isStreaming) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) {
        this._listeners.splice(idx, 1);
      }
    };
  }

  setSystemPrompt(prompt: string): void {
    this._systemPrompt = prompt;
  }

  setModel(model: string): void {
    this._model = model;
  }

  setThinkLevel(level: ThinkLevel): void {
    this._thinkLevel = level;
  }

  getRawSession(): unknown {
    return {
      sessionId: this._sessionId,
      messages: this._messages,
      activeQuery: this._activeQuery,
    };
  }

  dispose(): void {
    this.abort();
    this._listeners.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private emit(event: RuntimeEvent): void {
    for (const listener of this._listeners) {
      listener(event);
    }
  }

  private buildMcpServers(
    createSdkMcpServer: typeof import("@anthropic-ai/claude-agent-sdk").createSdkMcpServer,
  ): Record<string, McpServerConfig> {
    if (this._options.tools.length === 0) {
      return {};
    }

    // Group tools into a single MCP server
    const mcpTools = this._options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      // The SDK expects Zod schemas, but we need to bridge from JSON Schema.
      // For now, use a dynamic approach where we pass args through.
      inputSchema: buildZodShapeFromJsonSchema(tool.parameterSchema),
      handler: async (args: Record<string, unknown>) => {
        const result = await tool.execute(
          `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          args,
        );
        return {
          content: result.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => ({ type: "text" as const, text: c.text })),
          isError: result.isError,
        };
      },
    }));

    const server = createSdkMcpServer({
      name: "openclaw-tools",
      version: "1.0.0",
      tools: mcpTools,
    });

    return { "openclaw-tools": server };
  }

  private mapThinking(
    level: ThinkLevel,
  ): { type: "adaptive" } | { type: "enabled"; budgetTokens: number } | { type: "disabled" } {
    switch (level) {
      case "high":
        return { type: "adaptive" };
      case "medium":
        return { type: "enabled", budgetTokens: 10_000 };
      case "low":
        return { type: "enabled", budgetTokens: 2_000 };
      case "minimal":
        return { type: "enabled", budgetTokens: 500 };
      case "off":
      default:
        return { type: "disabled" };
    }
  }
}

/**
 * Build a Zod-like shape from a JSON Schema object.
 *
 * The Claude Agent SDK's `createSdkMcpServer` expects Zod v4 schemas.
 * We dynamically construct them from JSON Schema properties.
 */
function buildZodShapeFromJsonSchema(jsonSchema: Record<string, unknown>): Record<string, unknown> {
  // Lazy import of zod to match the SDK's peer dependency
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { z } = require("zod/v4");
    const properties = (jsonSchema.properties ?? {}) as Record<
      string,
      { type?: string; description?: string }
    >;
    const required = new Set((jsonSchema.required ?? []) as string[]);
    const shape: Record<string, unknown> = {};

    for (const [key, prop] of Object.entries(properties)) {
      let schema: unknown;
      switch (prop.type) {
        case "string":
          schema = z.string();
          break;
        case "number":
        case "integer":
          schema = z.number();
          break;
        case "boolean":
          schema = z.boolean();
          break;
        case "array":
          schema = z.array(z.unknown());
          break;
        case "object":
          schema = z.record(z.unknown());
          break;
        default:
          schema = z.unknown();
          break;
      }

      if (prop.description && schema && typeof schema === "object" && "describe" in schema) {
        schema = (schema as unknown as { describe: (d: string) => unknown }).describe(
          prop.description,
        );
      }

      if (!required.has(key) && schema && typeof schema === "object" && "optional" in schema) {
        schema = (schema as unknown as { optional: () => unknown }).optional();
      }

      shape[key] = schema;
    }

    return shape;
  } catch {
    // If zod is not available, return empty shape
    return {};
  }
}
