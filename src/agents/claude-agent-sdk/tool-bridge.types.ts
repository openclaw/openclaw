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
  /** Model to use. */
  model?: string;
  /** Additional directories the agent can access. */
  additionalDirectories?: string[];
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
// MCP Server tool registration (shape of McpServer.tool() from the SDK)
// ---------------------------------------------------------------------------

/**
 * Minimal interface for the McpServer class from `@modelcontextprotocol/sdk`.
 * We only use the `tool()` registration method and the constructor.
 */
export interface McpServerLike {
  tool(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<McpCallToolResult>,
  ): void;
}

/**
 * Constructor shape for new McpServer({ name, version }).
 */
export type McpServerConstructor = new (opts: { name: string; version: string }) => McpServerLike;
