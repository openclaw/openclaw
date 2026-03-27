import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 helpers
// ---------------------------------------------------------------------------

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export function createJsonRpcRequest(
  method: string,
  params: Record<string, unknown>,
  id: number,
): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

export function parseJsonRpcResponse(raw: string): JsonRpcResponse {
  const parsed = JSON.parse(raw) as JsonRpcResponse;
  if (parsed.jsonrpc !== "2.0" || typeof parsed.id !== "number") {
    throw new Error(`Invalid JSON-RPC response: ${raw.slice(0, 200)}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// MCP Tool descriptor (as returned by tools/list)
// ---------------------------------------------------------------------------

export type McpToolDescriptor = {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type JarvisMcpClientOptions = {
  pythonCommand: string;
  jarvisPath: string;
  startupTimeoutMs?: number;
  logger?: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
};

type PendingEntry = {
  resolve: (v: JsonRpcResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class JarvisMcpClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  private buffer = "";
  private opts: JarvisMcpClientOptions;
  private alive = false;

  constructor(opts: JarvisMcpClientOptions) {
    super();
    this.opts = opts;
  }

  /** Spawn the Python MCP server, send initialize, return tools/list result. */
  async start(): Promise<McpToolDescriptor[]> {
    const { pythonCommand, jarvisPath, startupTimeoutMs = 15_000 } = this.opts;

    this.child = spawn(pythonCommand, ["-m", "mcp_server"], {
      cwd: jarvisPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      windowsHide: true,
    });

    this.child.stdout?.on("data", (chunk: Buffer) => this.onData(String(chunk)));

    this.child.stderr?.on("data", (chunk: Buffer) => {
      const line = String(chunk).trim();
      if (line) this.opts.logger?.warn(`[jarvis-mcp stderr] ${line}`);
    });

    this.child.once("exit", (code) => {
      this.alive = false;
      this.rejectAllPending(new Error(`Jarvis MCP server exited with code ${code}`));
      this.emit("exit", code);
    });

    this.child.once("error", (err) => {
      this.alive = false;
      this.rejectAllPending(err);
      this.emit("error", err);
    });

    // MCP initialize handshake
    const initResult = await this.sendRequest(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "openclaw-jarvis-bridge", version: "1.0.0" },
      },
      startupTimeoutMs,
    );

    if (!initResult.result) {
      throw new Error(`MCP initialize failed: ${JSON.stringify(initResult.error)}`);
    }

    // Send initialized notification (no response expected)
    this.sendNotification("notifications/initialized", {});

    this.alive = true;

    // Discover tools
    const toolsResult = await this.sendRequest("tools/list", {}, 10_000);
    const tools = (toolsResult.result as { tools?: McpToolDescriptor[] })?.tools ?? [];
    return tools;
  }

  /** Call a tool by name with arguments. */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.alive) {
      throw new Error("Jarvis MCP server is not running.");
    }
    const resp = await this.sendRequest("tools/call", { name, arguments: args }, 120_000);
    if (resp.error) {
      throw new Error(`MCP tool ${name} error: ${resp.error.message}`);
    }
    return resp.result;
  }

  /** List available tools (re-fetches from the server). */
  async listTools(): Promise<McpToolDescriptor[]> {
    if (!this.alive) return [];
    const resp = await this.sendRequest("tools/list", {}, 10_000);
    return (resp.result as { tools?: McpToolDescriptor[] })?.tools ?? [];
  }

  /** Gracefully shut down the MCP server. */
  stop(): void {
    this.alive = false;
    this.rejectAllPending(new Error("Client stopped"));
    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // Already dead.
      }
      this.child = null;
    }
  }

  get isAlive(): boolean {
    return this.alive;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const req = createJsonRpcRequest(method, params, id);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeMessage(req);
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    const msg = { jsonrpc: "2.0" as const, method, params };
    this.writeMessage(msg);
  }

  private writeMessage(msg: unknown): void {
    const body = JSON.stringify(msg);
    // FastMCP 3.x stdio transport uses newline-delimited JSON (no Content-Length framing).
    this.child?.stdin?.write(body + "\n");
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // FastMCP 3.x uses newline-delimited JSON on stdout.
    while (true) {
      const newlineIdx = this.buffer.indexOf("\n");
      if (newlineIdx === -1) break;

      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const msg = JSON.parse(line) as {
          jsonrpc: string;
          id?: number;
          method?: string;
          result?: unknown;
          error?: unknown;
        };
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          clearTimeout(entry.timer);
          entry.resolve(msg as JsonRpcResponse);
        }
        // Notifications from server (no id) are ignored for now.
      } catch {
        // Skip non-JSON lines (e.g., FastMCP banner or log output on stdout).
      }
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}
