/**
 * MCP server configuration for the telegram-agentic plugin.
 *
 * These entries should be added to the gateway's `mcp.servers` config
 * in openclaw.json. They are NOT auto-registered by the plugin — the
 * gateway must be configured to spawn them.
 *
 * Example openclaw.json addition:
 *
 * ```json5
 * {
 *   mcp: {
 *     servers: {
 *       "fleet-tools": {
 *         command: "python3",
 *         args: ["-m", "mcp_servers.fleet_tools.server"],
 *         cwd: "/path/to/extensions/telegram-agentic/mcp-servers",
 *         env: { PYTHONPATH: "/path/to/extensions/telegram-agentic/mcp-servers" }
 *       },
 *       "knowledge-tools": {
 *         command: "python3",
 *         args: ["-m", "mcp_servers.knowledge_tools.server"],
 *         cwd: "/path/to/extensions/telegram-agentic/mcp-servers",
 *         env: {
 *           PYTHONPATH: "/path/to/extensions/telegram-agentic/mcp-servers",
 *           KNOWLEDGE_API_URL: "http://100.119.126.67:8890"
 *         }
 *       },
 *       "delegation-tools": {
 *         command: "python3",
 *         args: ["-m", "mcp_servers.delegation_tools.server"],
 *         cwd: "/path/to/extensions/telegram-agentic/mcp-servers",
 *         env: {
 *           PYTHONPATH: "/path/to/extensions/telegram-agentic/mcp-servers",
 *           ARCHON_API_URL: "http://100.69.32.10:8181"
 *         }
 *       },
 *       "pipeline-tools": {
 *         command: "python3",
 *         args: ["-m", "mcp_servers.pipeline_tools.server"],
 *         cwd: "/path/to/extensions/telegram-agentic/mcp-servers",
 *         env: { PYTHONPATH: "/path/to/extensions/telegram-agentic/mcp-servers" }
 *       },
 *       "self-tools": {
 *         command: "python3",
 *         args: ["-m", "mcp_servers.self_tools.server"],
 *         cwd: "/path/to/extensions/telegram-agentic/mcp-servers",
 *         env: {
 *           PYTHONPATH: "/path/to/extensions/telegram-agentic/mcp-servers",
 *           PLUGIN_SOURCE_ROOT: "/path/to/extensions/telegram-agentic"
 *         }
 *       }
 *     }
 *   }
 * }
 * ```
 */

export interface McpServerEntry {
	command: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
}

/**
 * Generate MCP server config entries for all fleet MCP servers.
 * Call this to get the config block for openclaw.json.
 */
export function generateMcpServersConfig(mcpServersRoot: string): Record<string, McpServerEntry> {
	const pythonPath = mcpServersRoot;

	return {
		"fleet-tools": {
			command: "python3",
			args: [`${mcpServersRoot}/fleet-tools/server.py`],
			env: { PYTHONPATH: pythonPath },
		},
		"knowledge-tools": {
			command: "python3",
			args: [`${mcpServersRoot}/knowledge-tools/server.py`],
			env: {
				PYTHONPATH: pythonPath,
				KNOWLEDGE_API_URL: "http://100.119.126.67:8890",
			},
		},
		"delegation-tools": {
			command: "python3",
			args: [`${mcpServersRoot}/delegation-tools/server.py`],
			env: {
				PYTHONPATH: pythonPath,
				ARCHON_API_URL: "http://100.69.32.10:8181",
			},
		},
		"pipeline-tools": {
			command: "python3",
			args: [`${mcpServersRoot}/pipeline-tools/server.py`],
			env: { PYTHONPATH: pythonPath },
		},
		"self-tools": {
			command: "python3",
			args: [`${mcpServersRoot}/self-tools/server.py`],
			env: {
				PYTHONPATH: pythonPath,
				PLUGIN_SOURCE_ROOT: mcpServersRoot.replace("/mcp-servers", ""),
			},
		},
	};
}
