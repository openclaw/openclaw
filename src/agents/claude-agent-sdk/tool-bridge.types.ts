/**
 * Local type definitions for interop with the Claude Agent SDK and MCP SDK.
 *
 * These are compatible with the runtime shapes but do not require the packages
 * to be installed at build time (both are optional, lazy-loaded integrations).
 */

// ---------------------------------------------------------------------------
// MCP CallToolResult (from @modelcontextprotocol/sdk/types.js)
// ---------------------------------------------------------------------------

export type McpTextContent = {
  type: "text";
  text: string;
};

export type McpImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

export type McpResourceContent = {
  type: "resource";
  uri: string;
  text?: string;
  blob?: string;
};

export type McpContentBlock = McpTextContent | McpImageContent | McpResourceContent;

export type McpCallToolResult = {
  content: McpContentBlock[];
  isError?: boolean;
};

// ---------------------------------------------------------------------------
// MCP Server config shapes (passed to SDK query() → options.mcpServers)
// ---------------------------------------------------------------------------

/** In-process MCP server created via createSdkMcpServer() or new McpServer(). */
export type McpSdkServerConfig = {
  type: "sdk";
  name: string;
  /** The McpServer instance — typed as `unknown` to avoid importing the class. */
  instance: unknown;
};

// ---------------------------------------------------------------------------
// Claude Agent SDK query() options (subset we use)
// ---------------------------------------------------------------------------

export type SdkRunnerQueryOptions = {
  /** MCP servers to expose to the agent. */
  mcpServers?: Record<string, McpSdkServerConfig>;
  /** Tool allow list (pattern: "mcp__{server}__{tool}"). */
  allowedTools?: string[];
  /** Tool deny list. */
  disallowedTools?: string[];
  /** Built-in Claude Code tools to enable (or a preset). */
  tools?: string[] | { type: "preset"; preset: string };
  /** Environment variables for the SDK runtime (auth, base URL, timeout). */
  env?: Record<string, string>;
  /** Permission mode. */
  permissionMode?: string;
  /** Working directory. */
  cwd?: string;
  /** System prompt configuration. */
  systemPrompt?: string | { type: "preset"; preset: string };
  /** Max agent turns before stopping. */
  maxTurns?: number;
  /** Model to use (e.g., "sonnet", "opus", "haiku", or full model ID). */
  model?: string;
  /** Token budget for extended thinking (0 = disabled). */
  thinkingBudget?: number;
  /** Resume a previous Claude Code session by ID (native session continuity). */
  resume?: string;
  /** Additional directories the agent can access. */
  additionalDirectories?: string[];
  /** Where to load Claude Code settings from ("project", etc.). */
  settingSources?: string[];
  /** Include partial message events in the SDK stream. */
  includePartialMessages?: boolean;
  /** Claude Code hook callbacks. */
  hooks?: Record<string, unknown>;
  /** Path to the Claude Code executable to run. */
  pathToClaudeCodeExecutable?: string;
};

// ---------------------------------------------------------------------------
// Claude Agent SDK event shapes (defensive — events are untyped at runtime)
// ---------------------------------------------------------------------------

export type SdkResultEvent = {
  type: "result";
  subtype?: "success" | "error";
  result?: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// MCP Server tool registration (shape of McpServer.registerTool() from the SDK)
// ---------------------------------------------------------------------------

/**
 * MCP tool handler extra context passed as second argument to tool handlers.
 * Contains abort signal, metadata, and session info from the MCP request.
 */
export type McpToolHandlerExtra = {
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Metadata from the original request (_meta field). */
  _meta?: Record<string, unknown>;
  /** Session ID if available. */
  sessionId?: string;
  /** JSON-RPC request ID. */
  requestId?: number;
};

/**
 * Tool registration config for McpServer.registerTool().
 */
export type McpToolConfig = {
  description?: string;
  /** Zod schema for input validation. MCP SDK requires Zod, not JSON Schema. */
  inputSchema?: unknown;
};

/**
 * Tool handler function signature for MCP SDK.
 * When inputSchema is provided, handler receives (args, extra).
 */
export type McpToolHandlerFn = (
  args: Record<string, unknown>,
  extra: McpToolHandlerExtra,
) => Promise<McpCallToolResult>;

/**
 * Minimal interface for the McpServer class from `@modelcontextprotocol/sdk`.
 * We use the `registerTool()` method (the recommended API, not deprecated `tool()`).
 */
export interface McpServerLike {
  registerTool(name: string, config: McpToolConfig, handler: McpToolHandlerFn): void;
}

/**
 * Constructor shape for new McpServer({ name, version }).
 */
export type McpServerConstructor = new (opts: { name: string; version: string }) => McpServerLike;
