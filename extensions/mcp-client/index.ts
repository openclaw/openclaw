/**
 * OpenClaw Generic MCP Client Plugin
 *
 * Connects to any Model Context Protocol server (filesystem, database, APIs, etc.)
 * Supports multiple simultaneous MCP server connections.
 *
 * Compatible with all standard MCP servers:
 * - Filesystem (mcp-server-filesystem)
 * - GitHub (mcp-server-github)
 * - Postgres (mcp-server-postgres)
 * - Slack (mcp-server-slack)
 * - Skyline API Gateway (skyline-mcp)
 * - And any other MCP-compliant server
 */

import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk";
import { spawn, type ChildProcess, exec } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";

const execAsync = promisify(exec);

interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  toolPrefix?: string;
  autoReconnect?: boolean;
  rateLimit?: {
    maxConcurrent?: number; // Max concurrent calls (default: 10)
    maxPerMinute?: number; // Max calls per minute (default: 60)
  };
}

interface MCPClientConfig {
  enabled?: boolean;
  servers?: Record<string, MCPServerConfig>;
}

interface MCPMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

interface ServerStatus {
  serverName: string;
  status: "connected" | "failed";
  toolCount: number;
  error?: string;
  config: MCPServerConfig;
}

class MCPClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private messageId = 1;
  private pendingCalls = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
    }
  >();
  private buffer = "";
  private tools: MCPTool[] = [];
  private resources: MCPResource[] = [];
  private prompts: MCPPrompt[] = [];
  private isHealthy = true;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private lastHealthCheck: number = 0;
  private consecutiveFailures = 0;

  // Rate limiting
  private activeCalls = 0;
  private callHistory: number[] = []; // Timestamps of calls in last minute
  private maxConcurrent: number;
  private maxPerMinute: number;

  constructor(
    private serverName: string,
    private config: MCPServerConfig,
    private logger: OpenClawPluginApi["logger"],
  ) {
    super();

    // Initialize rate limits
    this.maxConcurrent = config.rateLimit?.maxConcurrent ?? 10;
    this.maxPerMinute = config.rateLimit?.maxPerMinute ?? 60;
  }

  async start(): Promise<void> {
    this.logger.info(
      `[mcp-client] [${this.serverName}] starting MCP server: ${this.config.command}`,
    );

    // PRE-FLIGHT CHECK: Verify command exists before spawning
    // This prevents uncaught ENOENT exceptions from ChildProcess
    const { execSync } = await import("node:child_process");
    try {
      execSync(`command -v ${this.config.command} || which ${this.config.command}`, {
        stdio: "ignore",
        timeout: 1000,
      });
    } catch {
      const error = new Error(
        `Command not found: ${this.config.command}. Install it or check your PATH.`,
      );
      this.isHealthy = false;
      this.logger.error(`[mcp-client] [${this.serverName}] ${error.message}`);
      throw error;
    }

    // Spawn MCP server binary
    this.process = spawn(this.config.command, this.config.args || [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...this.config.env,
      },
    });

    // Create error promise for runtime errors
    const spawnError = new Promise<never>((_, reject) => {
      this.process!.on("error", (err) => {
        this.isHealthy = false;
        this.logger.error(`[mcp-client] [${this.serverName}] process error: ${err.message}`);
        this.emit("error", err);
        reject(err);
      });
    });

    // Handle stdout (MCP messages)
    this.process.stdout?.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    // Handle stderr (logs)
    this.process.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().trim().split("\n");
      for (const line of lines) {
        if (line.includes("Error") || line.includes("error")) {
          this.logger.error(`[mcp-client] [${this.serverName}] ${line}`);
        } else {
          this.logger.debug(`[mcp-client] [${this.serverName}] ${line}`);
        }
      }
    });

    // Handle process exit
    this.process.on("exit", (code, signal) => {
      this.isHealthy = false;
      this.logger.info(
        `[mcp-client] [${this.serverName}] process exited (code: ${code}, signal: ${signal})`,
      );
      this.emit("exit", { code, signal });

      if (this.config.autoReconnect && code !== 0) {
        this.logger.info(`[mcp-client] [${this.serverName}] reconnecting in 5 seconds...`);
        setTimeout(() => {
          this.isHealthy = true;
          this.start().catch((err) => {
            this.logger.error(`[mcp-client] [${this.serverName}] reconnect failed: ${err.message}`);
          });
        }, 5000);
      }
    });

    // Initialize MCP protocol with timeout
    const initPromise = (async () => {
      await this.initialize();
      await this.fetchTools();
      await this.fetchResources();
      await this.fetchPrompts();
    })();

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Initialization timeout (10s)")), 10000);
    });

    try {
      // Race between initialization, timeout, and spawn errors
      await Promise.race([initPromise, timeoutPromise, spawnError]);

      this.logger.info(
        `[mcp-client] [${this.serverName}] connected (${this.tools.length} tools loaded)`,
      );

      // Start health monitoring (check every 60 seconds)
      this.startHealthMonitoring();
    } catch (err) {
      this.isHealthy = false;
      this.stop(); // Clean up the failed process
      throw err;
    }
  }

  private startHealthMonitoring(): void {
    // Health check every 60 seconds
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck().catch((err) => {
        this.logger.warn(`[mcp-client] [${this.serverName}] health check failed: ${err.message}`);
      });
    }, 60000);
  }

  private async performHealthCheck(): Promise<void> {
    if (!this.isHealthy || !this.process) {
      return;
    }

    try {
      // Simple health check: try to list tools (lightweight operation)
      const startTime = Date.now();
      await Promise.race([
        this.call("tools/list"),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Health check timeout")), 5000),
        ),
      ]);

      const duration = Date.now() - startTime;
      this.lastHealthCheck = Date.now();
      this.consecutiveFailures = 0;

      if (duration > 2000) {
        this.logger.warn(`[mcp-client] [${this.serverName}] health check slow: ${duration}ms`);
      }
    } catch (err: any) {
      this.consecutiveFailures++;
      this.logger.error(
        `[mcp-client] [${this.serverName}] health check failed (${this.consecutiveFailures}/3): ${err.message}`,
      );

      // After 3 consecutive failures, mark as unhealthy
      if (this.consecutiveFailures >= 3) {
        this.isHealthy = false;
        this.logger.error(
          `[mcp-client] [${this.serverName}] marked unhealthy after 3 failed checks`,
        );
        this.emit("unhealthy");

        // Attempt restart if auto-reconnect is enabled
        if (this.config.autoReconnect) {
          this.logger.info(`[mcp-client] [${this.serverName}] attempting restart...`);
          this.stop();
          setTimeout(() => {
            this.start().catch((err) => {
              this.logger.error(`[mcp-client] [${this.serverName}] restart failed: ${err.message}`);
            });
          }, 5000);
        }
      }
    }
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message: MCPMessage = JSON.parse(line);

        if (message.id !== undefined) {
          // Response to a request
          const pending = this.pendingCalls.get(Number(message.id));
          if (pending) {
            this.pendingCalls.delete(Number(message.id));
            if (message.error) {
              pending.reject(new Error(`MCP Error: ${message.error.message}`));
            } else {
              pending.resolve(message.result);
            }
          }
        }
      } catch (err) {
        this.logger.error(`[mcp-client] [${this.serverName}] failed to parse message: ${line}`);
      }
    }
  }

  private call(method: string, params?: any): Promise<any> {
    if (!this.isHealthy) {
      return Promise.reject(new Error(`Server ${this.serverName} is not healthy`));
    }

    const id = this.messageId++;
    const message: MCPMessage = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    this.process?.stdin?.write(JSON.stringify(message) + "\n");

    return new Promise((resolve, reject) => {
      this.pendingCalls.set(id, { resolve, reject });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingCalls.has(id)) {
          this.pendingCalls.delete(id);
          reject(new Error(`Request timeout for method: ${method}`));
        }
      }, 30000);
    });
  }

  private async initialize(): Promise<void> {
    await this.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "openclaw-mcp-client",
        version: "1.0.0",
      },
    });
  }

  private async fetchTools(): Promise<void> {
    const response = await this.call("tools/list");
    this.tools = response.tools || [];
  }

  private async fetchResources(): Promise<void> {
    try {
      const response = await this.call("resources/list");
      this.resources = response.resources || [];
      if (this.resources.length > 0) {
        this.logger.info(
          `[mcp-client] [${this.serverName}] loaded ${this.resources.length} resources`,
        );
      }
    } catch (err: any) {
      // Resources are optional, don't fail if not supported
      this.logger.debug(
        `[mcp-client] [${this.serverName}] resources not supported: ${err.message}`,
      );
    }
  }

  private async fetchPrompts(): Promise<void> {
    try {
      const response = await this.call("prompts/list");
      this.prompts = response.prompts || [];
      if (this.prompts.length > 0) {
        this.logger.info(`[mcp-client] [${this.serverName}] loaded ${this.prompts.length} prompts`);
      }
    } catch (err: any) {
      // Prompts are optional, don't fail if not supported
      this.logger.debug(`[mcp-client] [${this.serverName}] prompts not supported: ${err.message}`);
    }
  }

  getTools(): MCPTool[] {
    return this.tools;
  }

  getResources(): MCPResource[] {
    return this.resources;
  }

  getPrompts(): MCPPrompt[] {
    return this.prompts;
  }

  async readResource(uri: string): Promise<any> {
    const response = await this.call("resources/read", { uri });
    return response;
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<any> {
    const response = await this.call("prompts/get", { name, arguments: args });
    return response;
  }

  getHealth(): boolean {
    return this.isHealthy;
  }

  async callTool(name: string, args: Record<string, any>): Promise<any> {
    // Check rate limits before making call
    await this.checkRateLimit();

    this.activeCalls++;
    const callTimestamp = Date.now();
    this.callHistory.push(callTimestamp);

    try {
      const response = await this.call("tools/call", {
        name,
        arguments: args,
      });

      // MCP returns: { content: [{ type: "text", text: "..." }] }
      if (response.content && Array.isArray(response.content)) {
        const textContent = response.content.find((c: any) => c.type === "text");
        if (textContent?.text) {
          try {
            return JSON.parse(textContent.text);
          } catch {
            return textContent.text;
          }
        }
      }

      return response;
    } finally {
      this.activeCalls--;
      // Clean up old history (older than 1 minute)
      const oneMinuteAgo = Date.now() - 60000;
      this.callHistory = this.callHistory.filter((t) => t > oneMinuteAgo);
    }
  }

  private async checkRateLimit(): Promise<void> {
    // Check concurrent limit
    if (this.activeCalls >= this.maxConcurrent) {
      this.logger.warn(
        `[mcp-client] [${this.serverName}] rate limit: concurrent calls (${this.activeCalls}/${this.maxConcurrent})`,
      );
      throw new Error(
        `Rate limit exceeded: too many concurrent calls (${this.activeCalls}/${this.maxConcurrent})`,
      );
    }

    // Check per-minute limit
    const oneMinuteAgo = Date.now() - 60000;
    const recentCalls = this.callHistory.filter((t) => t > oneMinuteAgo).length;

    if (recentCalls >= this.maxPerMinute) {
      this.logger.warn(
        `[mcp-client] [${this.serverName}] rate limit: calls per minute (${recentCalls}/${this.maxPerMinute})`,
      );
      throw new Error(
        `Rate limit exceeded: too many calls per minute (${recentCalls}/${this.maxPerMinute})`,
      );
    }
  }

  getMetrics() {
    return {
      activeCalls: this.activeCalls,
      callsLastMinute: this.callHistory.filter((t) => t > Date.now() - 60000).length,
      isHealthy: this.isHealthy,
      lastHealthCheck: this.lastHealthCheck,
      consecutiveFailures: this.consecutiveFailures,
      toolCount: this.tools.length,
    };
  }

  stop(): void {
    this.isHealthy = false;

    // Stop health monitoring
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Kill process
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }

    // Reject pending calls
    for (const [id, { reject }] of this.pendingCalls) {
      reject(new Error("MCP client stopped"));
    }
    this.pendingCalls.clear();
  }

  private async checkCommandExists(command: string): Promise<boolean> {
    // Extract base command (without args) in case it's a complex command
    const baseCommand = command.split(/\s+/)[0];

    try {
      // Use 'which' on Unix-like systems, 'where' on Windows
      const whichCommand = process.platform === "win32" ? "where" : "which";
      await execAsync(`${whichCommand} ${baseCommand}`, { timeout: 2000 });
      return true;
    } catch {
      // Command not found or which/where failed
      return false;
    }
  }
}

// Validate server configuration
function validateServerConfig(
  serverName: string,
  config: MCPServerConfig,
): { valid: boolean; error?: string } {
  // Validate server name
  if (!serverName || typeof serverName !== "string") {
    return { valid: false, error: "server name must be a non-empty string" };
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(serverName)) {
    return {
      valid: false,
      error: "server name can only contain letters, numbers, hyphens, and underscores",
    };
  }

  // Validate command
  if (!config.command || typeof config.command !== "string") {
    return { valid: false, error: "missing or invalid 'command' field" };
  }

  if (config.command.trim().length === 0) {
    return { valid: false, error: "'command' cannot be empty" };
  }

  // Validate args
  if (config.args !== undefined) {
    if (!Array.isArray(config.args)) {
      return { valid: false, error: "'args' must be an array" };
    }
    for (let i = 0; i < config.args.length; i++) {
      if (typeof config.args[i] !== "string") {
        return { valid: false, error: `'args[${i}]' must be a string` };
      }
    }
  }

  // Validate env
  if (config.env !== undefined) {
    if (typeof config.env !== "object" || config.env === null || Array.isArray(config.env)) {
      return { valid: false, error: "'env' must be an object" };
    }
    for (const [key, value] of Object.entries(config.env)) {
      if (typeof key !== "string" || typeof value !== "string") {
        return { valid: false, error: `'env.${key}' must be a string value` };
      }
    }
  }

  // Validate toolPrefix
  if (config.toolPrefix !== undefined) {
    if (typeof config.toolPrefix !== "string") {
      return { valid: false, error: "'toolPrefix' must be a string" };
    }
    if (!/^[a-zA-Z0-9_]+$/.test(config.toolPrefix)) {
      return {
        valid: false,
        error: "'toolPrefix' can only contain letters, numbers, and underscores",
      };
    }
  }

  // Validate autoReconnect
  if (config.autoReconnect !== undefined && typeof config.autoReconnect !== "boolean") {
    return { valid: false, error: "'autoReconnect' must be a boolean" };
  }

  return { valid: true };
}

export default function register(api: OpenClawPluginApi) {
  const config = api.pluginConfig as MCPClientConfig | undefined;

  // Graceful disable if not configured
  if (!config?.enabled) {
    api.logger.info("[mcp-client] plugin disabled (set enabled: true to activate)");
    return;
  }

  // Validate servers config
  if (!config.servers || Object.keys(config.servers).length === 0) {
    api.logger.error("[mcp-client] no MCP servers configured");
    return;
  }

  const mcpClients = new Map<string, MCPClient>();
  const serverStatuses: ServerStatus[] = [];
  const mcpToolRegistry = new Map<string, string>(); // toolName → serverName
  const processCleanupHandlers: Array<() => void> = [];

  // Register global cleanup handler
  const globalCleanup = () => {
    api.logger.info("[mcp-client] performing cleanup...");
    for (const handler of processCleanupHandlers) {
      try {
        handler();
      } catch (err: any) {
        api.logger.error(`[mcp-client] cleanup error: ${err.message}`);
      }
    }
  };

  // Register cleanup on process exit
  process.on("SIGTERM", globalCleanup);
  process.on("SIGINT", globalCleanup);
  process.on("exit", globalCleanup);

  const service: OpenClawPluginService = {
    id: "mcp-client",
    start: async () => {
      const serverEntries = Object.entries(config.servers!);
      api.logger.info(`[mcp-client] starting ${serverEntries.length} MCP servers...`);

      // Start each MCP server with error isolation
      for (const [serverName, serverConfig] of serverEntries) {
        // Validate configuration first
        const validation = validateServerConfig(serverName, serverConfig);
        if (!validation.valid) {
          const error = `config validation failed: ${validation.error}`;
          api.logger.error(`[mcp-client] [${serverName}] ${error}`);
          serverStatuses.push({
            serverName,
            status: "failed",
            toolCount: 0,
            error,
            config: serverConfig,
          });
          continue; // Skip this server, continue with others
        }

        const client = new MCPClient(serverName, serverConfig, api.logger);

        try {
          // Wait for connection (with timeout)
          await client.start();

          // Register all tools from this server
          // Default to "ext_" prefix to avoid collisions with native OpenClaw tools
          const toolPrefix = serverConfig.toolPrefix ?? "ext_";
          const tools = client.getTools();

          for (const tool of tools) {
            const toolName = `${toolPrefix}${tool.name.replace(/[^a-zA-Z0-9_]/g, "_")}`;

            // Check for MCP-to-MCP collision (FATAL for this server only)
            if (mcpToolRegistry.has(toolName)) {
              const conflictingServer = mcpToolRegistry.get(toolName);
              const error = `tool collision: '${toolName}' conflicts with server '${conflictingServer}'`;
              api.logger.error(
                `[mcp-client] [${serverName}] FATAL: ${error}\n` +
                  `  Fix: Set unique 'toolPrefix' for one of these servers in openclaw.json`,
              );

              // Stop this server and mark as failed
              client.stop();
              serverStatuses.push({
                serverName,
                status: "failed",
                toolCount: 0,
                error,
                config: serverConfig,
              });

              throw new Error(error); // Break out of tool loop, continue with next server
            }

            // Track this tool
            mcpToolRegistry.set(toolName, serverName);

            api.registerTool({
              name: toolName,
              description: tool.description || `${serverName} MCP tool: ${tool.name}`,
              parameters: tool.inputSchema,
              async execute(_toolCallId: string, args: Record<string, any>) {
                try {
                  const result = await client.callTool(tool.name, args);
                  return {
                    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
                    details: result,
                  };
                } catch (err: any) {
                  api.logger.error(
                    `[mcp-client] [${serverName}] tool ${toolName} failed: ${err.message}`,
                  );
                  throw err;
                }
              },
            });
          }

          mcpClients.set(serverName, client);
          serverStatuses.push({
            serverName,
            status: "connected",
            toolCount: tools.length,
            config: serverConfig,
          });

          // Register cleanup handler for this client
          processCleanupHandlers.push(() => {
            api.logger.debug(`[mcp-client] [${serverName}] cleanup triggered`);
            client.stop();
          });

          api.logger.info(`[mcp-client] [${serverName}] registered ${tools.length} tools ✅`);
        } catch (err: any) {
          // Error isolation: log and continue with next server
          const error = err.message || String(err);
          api.logger.error(`[mcp-client] [${serverName}] failed to start: ${error}`);

          // Track failed server if not already added
          if (!serverStatuses.find((s) => s.serverName === serverName)) {
            serverStatuses.push({
              serverName,
              status: "failed",
              toolCount: 0,
              error,
              config: serverConfig,
            });
          }

          // Continue with next server (don't throw)
        }
      }

      const totalTools = Array.from(mcpClients.values()).reduce(
        (sum, client) => sum + client.getTools().length,
        0,
      );
      const successCount = serverStatuses.filter((s) => s.status === "connected").length;
      const failCount = serverStatuses.filter((s) => s.status === "failed").length;

      if (successCount > 0) {
        api.logger.info(
          `[mcp-client] connected to ${successCount}/${serverEntries.length} servers (${totalTools} total tools)` +
            (failCount > 0 ? ` ⚠️  ${failCount} failed` : " ✅"),
        );
      } else {
        api.logger.error(`[mcp-client] all ${serverEntries.length} servers failed to start`);
      }
    },
    stop: async () => {
      api.logger.info("[mcp-client] stopping all MCP servers...");

      // Remove global cleanup handlers
      process.off("SIGTERM", globalCleanup);
      process.off("SIGINT", globalCleanup);
      process.off("exit", globalCleanup);

      // Stop all clients
      for (const [serverName, client] of mcpClients) {
        api.logger.info(`[mcp-client] [${serverName}] stopping...`);
        client.stop();
      }

      mcpClients.clear();
      serverStatuses.length = 0;
      mcpToolRegistry.clear();
      processCleanupHandlers.length = 0;

      api.logger.info("[mcp-client] all servers stopped");
    },
  };

  api.registerService(service);

  // Register hot reload command
  api.registerCommand({
    name: "mcp-reload",
    description: "Hot reload MCP servers without restarting gateway",
    handler: async (args: { add?: string; remove?: string; restart?: string }) => {
      const lines = ["# MCP Hot Reload", ""];

      // Add new server
      if (args.add) {
        lines.push(`❌ Add functionality not yet implemented`);
        lines.push(`Requested: Add server '${args.add}'`);
        lines.push("");
      }

      // Remove server
      if (args.remove) {
        const serverName = args.remove;
        const client = mcpClients.get(serverName);

        if (!client) {
          lines.push(`❌ Server '${serverName}' not found`);
        } else {
          client.stop();
          mcpClients.delete(serverName);

          // Remove tools
          for (const [toolName, server] of mcpToolRegistry.entries()) {
            if (server === serverName) {
              mcpToolRegistry.delete(toolName);
            }
          }

          // Update status
          const statusIndex = serverStatuses.findIndex((s) => s.serverName === serverName);
          if (statusIndex >= 0) {
            serverStatuses.splice(statusIndex, 1);
          }

          lines.push(`✅ Removed server '${serverName}'`);
          lines.push(`- Tools unregistered`);
          lines.push(`- Process stopped`);
        }
        lines.push("");
      }

      // Restart server
      if (args.restart) {
        const serverName = args.restart;
        const serverConfig = config.servers?.[serverName];

        if (!serverConfig) {
          lines.push(`❌ Server '${serverName}' not found in config`);
        } else {
          // Stop existing
          const existingClient = mcpClients.get(serverName);
          if (existingClient) {
            existingClient.stop();
            mcpClients.delete(serverName);
          }

          // Start new
          const client = new MCPClient(serverName, serverConfig, api.logger);
          try {
            await client.start();
            mcpClients.set(serverName, client);

            lines.push(`✅ Restarted server '${serverName}'`);
            lines.push(`- Tools: ${client.getTools().length}`);
            lines.push(`- Resources: ${client.getResources().length}`);
            lines.push(`- Prompts: ${client.getPrompts().length}`);
          } catch (err: any) {
            lines.push(`❌ Failed to restart '${serverName}': ${err.message}`);
          }
        }
        lines.push("");
      }

      if (!args.add && !args.remove && !args.restart) {
        lines.push("**Usage:**");
        lines.push("- `/mcp-reload --remove=skyline` - Remove a server");
        lines.push("- `/mcp-reload --restart=skyline` - Restart a server");
        lines.push("");
      }

      return { text: lines.join("\n") };
    },
  });

  // Register metrics endpoint
  api.registerCommand({
    name: "mcp-metrics",
    description: "Show MCP client metrics and performance data",
    handler: async () => {
      if (mcpClients.size === 0) {
        return { text: "❌ No MCP servers connected" };
      }

      const lines = [`# MCP Client Metrics`, "", `**Timestamp:** ${new Date().toISOString()}`, ""];

      for (const [serverName, client] of mcpClients) {
        const metrics = client.getMetrics();
        const config = serverStatuses.find((s) => s.serverName === serverName)?.config;

        lines.push(`## ${serverName}`);
        lines.push(`- **Health:** ${metrics.isHealthy ? "✅ Healthy" : "❌ Unhealthy"}`);
        lines.push(`- **Active Calls:** ${metrics.activeCalls}`);
        lines.push(`- **Calls (Last Minute):** ${metrics.callsLastMinute}`);
        lines.push(`- **Tool Count:** ${metrics.toolCount}`);
        lines.push(
          `- **Last Health Check:** ${metrics.lastHealthCheck ? new Date(metrics.lastHealthCheck).toLocaleString() : "Never"}`,
        );
        lines.push(`- **Consecutive Failures:** ${metrics.consecutiveFailures}`);

        if (config?.rateLimit) {
          lines.push(
            `- **Rate Limits:** ${config.rateLimit.maxConcurrent ?? 10} concurrent, ${config.rateLimit.maxPerMinute ?? 60}/min`,
          );
        }

        lines.push("");
      }

      return { text: lines.join("\n") };
    },
  });

  // Register improved status command
  api.registerCommand({
    name: "mcp",
    description: "Check MCP client status and list all tools",
    handler: async () => {
      if (serverStatuses.length === 0) {
        return { text: "❌ MCP Client: No servers configured" };
      }

      const lines = [
        `# MCP Client Status`,
        "",
        `**Servers:** ${serverStatuses.length} configured, ${mcpClients.size} connected`,
        "",
      ];

      // Connected servers
      const connected = serverStatuses.filter((s) => s.status === "connected");
      if (connected.length > 0) {
        lines.push(`## ✅ Connected Servers (${connected.length})`);
        lines.push("");

        for (const status of connected) {
          const client = mcpClients.get(status.serverName);
          const tools = client?.getTools() || [];
          const prefix = status.config.toolPrefix ?? "ext_";

          lines.push(`### ${status.serverName}`);
          lines.push(`- **Command:** \`${status.config.command}\``);
          lines.push(`- **Prefix:** \`${prefix}\``);
          lines.push(`- **Tools:** ${tools.length}`);
          lines.push("");

          // List all tools
          for (const tool of tools) {
            const toolName = `${prefix}${tool.name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
            lines.push(`  - \`${toolName}\`: ${tool.description || "(no description)"}`);
          }
          lines.push("");
        }
      }

      // Failed servers
      const failed = serverStatuses.filter((s) => s.status === "failed");
      if (failed.length > 0) {
        lines.push(`## ❌ Failed Servers (${failed.length})`);
        lines.push("");

        for (const status of failed) {
          lines.push(`### ${status.serverName}`);
          lines.push(`- **Command:** \`${status.config.command}\``);
          lines.push(`- **Error:** ${status.error}`);
          lines.push("");
        }
      }

      return { text: lines.join("\n") };
    },
  });

  api.logger.info("[mcp-client] plugin registered successfully");
}
