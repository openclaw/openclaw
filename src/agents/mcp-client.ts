import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseMcpServers, resolveUniqueMcpName, type McpServerConfig } from "./mcp-common.js";

const log = createSubsystemLogger("agent/mcp");

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const MCP_PROTOCOL_VERSION = "2024-11-05";

type McpRequestOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanupAbort?: () => void;
};

type JsonRpcErrorObject = {
  code?: unknown;
  message?: unknown;
  data?: unknown;
};

type JsonRpcEnvelope = {
  id?: unknown;
  result?: unknown;
  error?: unknown;
};

export type McpToolDescriptor = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpToolHandle = {
  /** Unique tool name exposed to the embedded runner. */
  name: string;
  /** Original MCP tool name (before uniquifying). */
  mcpName: string;
  serverName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  call: (params: Record<string, unknown>, opts?: McpRequestOptions) => Promise<unknown>;
};

type McpClient = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  listTools: (opts?: McpRequestOptions) => Promise<McpToolDescriptor[]>;
  callTool: (name: string, args: Record<string, unknown>, opts?: McpRequestOptions) => Promise<unknown>;
};

export type McpRuntime = {
  tools: McpToolHandle[];
  cleanup: () => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return String(error);
}

function toJsonRpcError(error: unknown): JsonRpcErrorObject | null {
  return isRecord(error) ? (error as JsonRpcErrorObject) : null;
}

function formatJsonRpcError(error: unknown): string {
  const rpcErr = toJsonRpcError(error);
  if (!rpcErr) {
    return typeof error === "string" ? error : "JSON-RPC error";
  }
  const code = typeof rpcErr.code === "number" ? ` (${rpcErr.code})` : "";
  const message = typeof rpcErr.message === "string" ? rpcErr.message : "JSON-RPC error";
  return `${message}${code}`;
}

function normalizeToolsPayload(payload: unknown): McpToolDescriptor[] {
  if (!isRecord(payload) || !Array.isArray(payload.tools)) {
    return [];
  }

  const tools: McpToolDescriptor[] = [];
  for (const raw of payload.tools) {
    if (!isRecord(raw)) {
      continue;
    }
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name) {
      continue;
    }
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    const inputSchema = isRecord(raw.inputSchema) ? raw.inputSchema : undefined;
    tools.push({
      name,
      ...(description ? { description } : {}),
      ...(inputSchema ? { inputSchema } : {}),
    });
  }

  return tools;
}

function parseJsonRpcEnvelope(raw: unknown): JsonRpcEnvelope {
  if (!isRecord(raw)) {
    throw new Error("MCP response was not a JSON object");
  }
  return {
    id: raw.id,
    result: raw.result,
    error: raw.error,
  };
}

function parseSseFrames(raw: string): string[] {
  const frames: string[] = [];
  const lines = raw.split(/\r?\n/);
  let dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
      continue;
    }
    if (line.trim().length === 0) {
      if (dataLines.length > 0) {
        frames.push(dataLines.join("\n"));
        dataLines = [];
      }
    }
  }

  if (dataLines.length > 0) {
    frames.push(dataLines.join("\n"));
  }

  return frames;
}

function parseHttpJsonRpcBody(rawBody: string): JsonRpcEnvelope {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    throw new Error("MCP HTTP response body was empty");
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return parseJsonRpcEnvelope(JSON.parse(trimmed));
  }

  const frames = parseSseFrames(trimmed);
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i]?.trim();
    if (!frame || frame === "[DONE]") {
      continue;
    }
    return parseJsonRpcEnvelope(JSON.parse(frame));
  }

  throw new Error("MCP HTTP response did not contain JSON-RPC payload");
}

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  const resolved = Number.isFinite(timeoutMs) ? Number(timeoutMs) : DEFAULT_MCP_TIMEOUT_MS;
  return Math.max(1, resolved);
}

async function awaitProcessSpawn(
  proc: ChildProcessWithoutNullStreams,
  serverName: string,
): Promise<void> {
  if (proc.pid) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(new Error(`Failed to start MCP server ${serverName}: ${error.message}`));
    };
    const cleanup = () => {
      proc.off("spawn", onSpawn);
      proc.off("error", onError);
    };

    proc.once("spawn", onSpawn);
    proc.once("error", onError);
  });
}

class StdioMcpClient implements McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private lines: ReadlineInterface | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly serverName: string,
    private readonly config: Extract<McpServerConfig, { type: "stdio" }>,
  ) {}

  async start(): Promise<void> {
    if (this.proc) {
      return;
    }

    const env = {
      ...process.env,
      ...(this.config.env ?? {}),
    };

    const proc = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    this.proc = proc;
    this.closed = false;

    proc.on("error", (error) => {
      this.rejectAllPending(
        new Error(`MCP server ${this.serverName} process error: ${toErrorMessage(error)}`),
      );
    });

    proc.on("exit", (code, signal) => {
      if (this.closed) {
        return;
      }
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.rejectAllPending(new Error(`MCP server ${this.serverName} exited (${detail})`));
    });

    proc.stderr.on("data", (chunk) => {
      const text = String(chunk ?? "").trim();
      if (!text) {
        return;
      }
      log.warn(`mcp stderr (${this.serverName}): ${text.slice(0, 500)}`);
    });

    this.lines = createInterface({
      input: proc.stdout,
      crlfDelay: Infinity,
    });

    this.lines.on("line", (line) => {
      this.handleLine(line);
    });

    await awaitProcessSpawn(proc, this.serverName);
    await this.initialize();
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.rejectAllPending(new Error(`MCP server ${this.serverName} stopped`));

    this.lines?.close();
    this.lines = null;

    const proc = this.proc;
    this.proc = null;

    if (!proc) {
      return;
    }

    if (proc.exitCode !== null || proc.signalCode !== null) {
      return;
    }

    const exited = new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
    });

    proc.kill("SIGTERM");

    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 1_000);
      }),
    ]);

    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
      await exited;
    }
  }

  async listTools(opts?: McpRequestOptions): Promise<McpToolDescriptor[]> {
    const result = await this.request("tools/list", {}, opts);
    return normalizeToolsPayload(result);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: McpRequestOptions,
  ): Promise<unknown> {
    return this.request(
      "tools/call",
      {
        name,
        arguments: args,
      },
      opts,
    );
  }

  private async initialize(): Promise<void> {
    try {
      await this.request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: "openclaw",
            version: "embedded",
          },
        },
        { timeoutMs: 15_000 },
      );
    } catch (error) {
      log.warn(`mcp initialize failed (${this.serverName}): ${toErrorMessage(error)}`);
    }

    try {
      this.notify("notifications/initialized", {});
    } catch {
      // Ignore notification failures; some servers are permissive here.
    }
  }

  private notify(method: string, params: unknown) {
    const proc = this.proc;
    if (!proc || this.closed) {
      return;
    }

    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    });

    proc.stdin.write(`${payload}\n`);
  }

  private async request(
    method: string,
    params: unknown,
    opts?: McpRequestOptions,
  ): Promise<unknown> {
    const proc = this.proc;
    if (!proc || this.closed) {
      throw new Error(`MCP server ${this.serverName} is not running`);
    }

    if (opts?.signal?.aborted) {
      throw new Error(`MCP request aborted before send: ${method}`);
    }

    const id = this.nextId;
    this.nextId += 1;
    const timeoutMs = resolveTimeoutMs(opts?.timeoutMs);

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        this.pending.delete(id);
        pending.cleanupAbort?.();
        reject(new Error(`MCP request timed out after ${timeoutMs}ms: ${this.serverName}.${method}`));
      }, timeoutMs);

      const pending: PendingRequest = {
        resolve: (value) => {
          clearTimeout(timer);
          pending.cleanupAbort?.();
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          pending.cleanupAbort?.();
          reject(error);
        },
      };

      if (opts?.signal) {
        const onAbort = () => {
          const current = this.pending.get(id);
          if (!current) {
            return;
          }
          this.pending.delete(id);
          current.reject(new Error(`MCP request aborted: ${this.serverName}.${method}`));
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
        pending.cleanupAbort = () => {
          opts.signal?.removeEventListener("abort", onAbort);
        };
      }

      this.pending.set(id, pending);

      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });

      proc.stdin.write(`${payload}\n`, (error) => {
        if (!error) {
          return;
        }
        const current = this.pending.get(id);
        if (!current) {
          return;
        }
        this.pending.delete(id);
        current.reject(
          new Error(`Failed to write MCP request ${this.serverName}.${method}: ${error.message}`),
        );
      });
    });
  }

  private handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let envelope: JsonRpcEnvelope;
    try {
      envelope = parseJsonRpcEnvelope(JSON.parse(trimmed));
    } catch {
      return;
    }

    const id =
      typeof envelope.id === "number"
        ? envelope.id
        : typeof envelope.id === "string" && /^\d+$/.test(envelope.id)
          ? Number(envelope.id)
          : null;
    if (id === null) {
      return;
    }

    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);

    if (envelope.error !== undefined) {
      pending.reject(new Error(formatJsonRpcError(envelope.error)));
      return;
    }

    pending.resolve(envelope.result);
  }

  private rejectAllPending(reason: Error) {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      pending.reject(reason);
    }
  }
}

class HttpMcpClient implements McpClient {
  private nextId = 1;

  constructor(
    private readonly serverName: string,
    private readonly config: Extract<McpServerConfig, { type: "http" | "sse" }>,
  ) {}

  async start(): Promise<void> {
    await this.initialize();
  }

  async stop(): Promise<void> {
    // HTTP/SSE transport has no local child process to clean up.
  }

  async listTools(opts?: McpRequestOptions): Promise<McpToolDescriptor[]> {
    const result = await this.request("tools/list", {}, opts);
    return normalizeToolsPayload(result);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: McpRequestOptions,
  ): Promise<unknown> {
    return this.request(
      "tools/call",
      {
        name,
        arguments: args,
      },
      opts,
    );
  }

  private async initialize(): Promise<void> {
    try {
      await this.request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: "openclaw",
            version: "embedded",
          },
        },
        { timeoutMs: 15_000 },
      );
    } catch (error) {
      log.warn(`mcp initialize failed (${this.serverName}): ${toErrorMessage(error)}`);
    }

    try {
      await this.notify("notifications/initialized", {});
    } catch {
      // Ignore initialization notification failures.
    }
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.config.headers ?? {}),
    };

    await fetch(this.config.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
      }),
    });
  }

  private async request(
    method: string,
    params: unknown,
    opts?: McpRequestOptions,
  ): Promise<unknown> {
    if (opts?.signal?.aborted) {
      throw new Error(`MCP request aborted before send: ${method}`);
    }

    const id = this.nextId;
    this.nextId += 1;
    const timeoutMs = resolveTimeoutMs(opts?.timeoutMs);

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`timeout`));
    }, timeoutMs);

    const onAbort = () => {
      controller.abort(new Error("aborted"));
    };
    opts?.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.config.headers ?? {}),
      };

      const response = await fetch(this.config.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params,
        }),
        signal: controller.signal,
      });

      const rawBody = await response.text();
      if (!response.ok) {
        throw new Error(
          `MCP HTTP request failed (${response.status} ${response.statusText}): ${rawBody.slice(0, 500)}`,
        );
      }

      const envelope = parseHttpJsonRpcBody(rawBody);
      if (envelope.error !== undefined) {
        throw new Error(formatJsonRpcError(envelope.error));
      }

      if (envelope.id !== undefined && envelope.id !== id && String(envelope.id) !== String(id)) {
        throw new Error(
          `MCP response id mismatch for ${this.serverName}.${method}: expected ${id}, got ${String(envelope.id)}`,
        );
      }

      return envelope.result;
    } catch (error) {
      if (controller.signal.aborted && !opts?.signal?.aborted) {
        throw new Error(`MCP request timed out after ${timeoutMs}ms: ${this.serverName}.${method}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", onAbort);
    }
  }
}

function createMcpClient(serverName: string, config: McpServerConfig): McpClient {
  if (config.type === "stdio") {
    return new StdioMcpClient(serverName, config);
  }
  return new HttpMcpClient(serverName, config);
}

export async function initMcpRuntime(params: {
  mcpServers?: unknown[];
  existingToolNames?: Iterable<string>;
  toolCallTimeoutMs?: number;
}): Promise<McpRuntime> {
  const parsed = parseMcpServers(params.mcpServers);
  const serverEntries = Object.entries(parsed);

  if (serverEntries.length === 0) {
    return {
      tools: [],
      cleanup: async () => {},
    };
  }

  const activeClients: Array<{ serverName: string; client: McpClient }> = [];
  const toolHandles: McpToolHandle[] = [];
  const nameRegistry = new Set<string>(params.existingToolNames ?? []);

  for (const [serverName, config] of serverEntries) {
    const client = createMcpClient(serverName, config);
    try {
      await client.start();
    } catch (error) {
      log.warn(`mcp server failed to start (${serverName}): ${toErrorMessage(error)}`);
      await client.stop().catch(() => {});
      continue;
    }

    activeClients.push({ serverName, client });

    let tools: McpToolDescriptor[] = [];
    try {
      tools = await client.listTools({ timeoutMs: 15_000 });
    } catch (error) {
      log.warn(`mcp tools/list failed (${serverName}): ${toErrorMessage(error)}`);
      continue;
    }

    for (const tool of tools) {
      const originalName = tool.name.trim();
      if (!originalName) {
        continue;
      }

      const uniqueName = resolveUniqueMcpName(originalName, nameRegistry);
      nameRegistry.add(uniqueName);

      toolHandles.push({
        name: uniqueName,
        mcpName: originalName,
        serverName,
        description: tool.description,
        inputSchema: tool.inputSchema,
        call: async (toolParams, opts) => {
          return client.callTool(originalName, toolParams, {
            timeoutMs: opts?.timeoutMs ?? params.toolCallTimeoutMs,
            signal: opts?.signal,
          });
        },
      });
    }
  }

  return {
    tools: toolHandles,
    cleanup: async () => {
      await Promise.allSettled(activeClients.map((entry) => entry.client.stop()));
    },
  };
}
