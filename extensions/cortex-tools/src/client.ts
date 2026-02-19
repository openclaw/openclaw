/**
 * HTTP client for communicating with Cortex's REST API.
 *
 * Uses:
 *   GET  /api/v1/tools/schemas                  — discover all available tools
 *   POST /api/v1/tools/{mcp_name}/{tool_name}   — execute a tool
 */

export type CortexTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type CortexToolCallResult = {
  success: boolean;
  data?: unknown;
  error?: string;
  error_code?: string;
  execution_time_ms?: number;
};

export class CortexClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  /**
   * Verify the Cortex instance is reachable.
   * Returns the health status.
   */
  async healthCheck(): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/health`, {
      headers: { "X-API-Key": this.apiKey },
    });
    return response.ok;
  }

  /**
   * Discover all tools from the Cortex REST API.
   * Maps the REST response (input_schema) to the CortexTool type (inputSchema).
   */
  async listTools(): Promise<CortexTool[]> {
    const response = await fetch(`${this.baseUrl}/api/v1/tools/schemas`, {
      headers: {
        "X-API-Key": this.apiKey,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Cortex tool discovery failed (${response.status}): ${text}`);
    }

    const json = (await response.json()) as
      | {
          tools: Array<{
            name: string;
            description: string;
            input_schema: Record<string, unknown>;
          }>;
        }
      | Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;

    const tools = Array.isArray(json) ? json : json.tools;

    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
    }));
  }

  /**
   * Execute a tool on Cortex via the REST API.
   *
   * Tool names are in the format `{mcp_name}__{tool_name}` (e.g. `github__list_repositories`).
   * This method splits the name and calls POST /api/v1/tools/{mcp_name}/{tool_name}.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<CortexToolCallResult> {
    const separatorIndex = name.indexOf("__");
    if (separatorIndex === -1) {
      throw new Error(`Invalid Cortex tool name "${name}": expected format "mcpName__toolName"`);
    }

    const mcpName = name.slice(0, separatorIndex);
    const toolName = name.slice(separatorIndex + 2);

    const response = await fetch(
      `${this.baseUrl}/api/v1/tools/${encodeURIComponent(mcpName)}/${encodeURIComponent(toolName)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
        },
        body: JSON.stringify({ params: args }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Cortex tool execution failed (${response.status}): ${text}`);
    }

    return (await response.json()) as CortexToolCallResult;
  }
}
