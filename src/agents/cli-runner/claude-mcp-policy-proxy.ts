/**
 * Rewrites Claude external MCP entries through an OpenClaw-owned policy proxy.
 */
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import WebSocket, { type RawData } from "ws";
import { isBunRuntime } from "../../daemon/runtime-binary.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { MAX_PLUGIN_APPROVAL_TIMEOUT_MS } from "../../infra/plugin-approvals.js";
import { resolveMcpTransportConfig } from "../mcp-transport-config.js";
import { resolveMcpTransport } from "../mcp-transport.js";
import { normalizeStringRecord } from "./bundle-mcp-adapter-shared.js";
import type { ClaudeMcpProxyServerPolicy } from "./claude-live-tool-policy.js";

const require = createRequire(import.meta.url);
const CLAUDE_MCP_ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
export const CLAUDE_MCP_POLICY_RELAY_TIMEOUT_MS = MAX_PLUGIN_APPROVAL_TIMEOUT_MS + 10_000;

function normalizeStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : undefined;
}

function expandClaudeMcpEnvValue(
  value: string,
  env: Record<string, string>,
  field: string,
): string {
  return value.replace(CLAUDE_MCP_ENV_PATTERN, (_match, name: string, fallback?: string) => {
    const resolved = env[name];
    if (resolved !== undefined && resolved !== "") {
      return resolved;
    }
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`Claude MCP server ${field} references missing environment variable ${name}`);
  });
}

function prepareUpstreamServer(
  server: Record<string, unknown>,
  env: Record<string, string>,
): Record<string, unknown> {
  const next = { ...server };
  for (const field of ["command", "url"] as const) {
    if (typeof next[field] === "string") {
      next[field] = expandClaudeMcpEnvValue(next[field], env, field);
    }
  }
  const args = normalizeStringArray(next.args);
  if (args) {
    next.args = args.map((value, index) => expandClaudeMcpEnvValue(value, env, `args[${index}]`));
  }
  if (isRecord(next.env)) {
    next.env = Object.fromEntries(
      Object.entries(next.env).map(([name, value]) => [
        name,
        typeof value === "string" ? expandClaudeMcpEnvValue(value, env, `env.${name}`) : value,
      ]),
    );
  }
  const headers = normalizeStringRecord(server.headers);
  if (!headers) {
    return next;
  }
  return {
    ...next,
    headers: Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        expandClaudeMcpEnvValue(value, env, `headers.${name}`),
      ]),
    ),
  };
}

type ClaudeMcpProxyTransport = {
  transport: Transport;
  connectionTimeoutMs: number;
  requestTimeoutMs: number;
  supportsParallelToolCalls: boolean;
  detachStderr?: () => void;
};

function decodeWebSocketData(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString();
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString();
  }
  return data.toString();
}

/** Connect an MCP client within the declared transport startup budget. */
export async function connectClaudeMcpProxyClient(
  client: Client,
  transport: Transport,
  timeoutMs: number,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const connect = client.connect(transport);
  try {
    await Promise.race([
      connect,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          void transport.close().catch(() => undefined);
          reject(new Error(`MCP server connection timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

class ClaudeMcpWebSocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  #socket?: WebSocket;

  constructor(
    private readonly url: URL,
    private readonly headers: Record<string, string> | undefined,
  ) {}

  async start(): Promise<void> {
    if (this.#socket) {
      throw new Error("Claude MCP WebSocket transport already started");
    }
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(
        this.url,
        "mcp",
        this.headers ? { headers: this.headers } : undefined,
      );
      this.#socket = socket;
      socket.once("open", resolve);
      socket.once("error", reject);
      socket.on("error", (error) => this.onerror?.(error));
      socket.on("close", () => this.onclose?.());
      socket.on("message", (data: RawData) => {
        try {
          this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(decodeWebSocketData(data))));
        } catch (error) {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  async close(): Promise<void> {
    this.#socket?.close();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Claude MCP WebSocket transport is not connected");
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(message), (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function getPositiveNumber(
  server: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = server[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

function getBoolean(server: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = server[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function resolveClaudeMcpProxyRuntimeSettings(
  serverName: string,
  rawServer: unknown,
): {
  connectionTimeoutMs: number;
  requestTimeoutMs: number;
  supportsParallelToolCalls: boolean;
} | null {
  if (isRecord(rawServer)) {
    const transportType = normalizeLowercaseStringOrEmpty(
      typeof rawServer.type === "string" ? rawServer.type : rawServer.transport,
    );
    if (transportType === "ws" || transportType === "websocket") {
      return {
        connectionTimeoutMs: Math.floor(
          getPositiveNumber(rawServer, ["connectionTimeoutMs"]) ??
            (getPositiveNumber(rawServer, ["connectTimeout", "connect_timeout"]) ?? 30) * 1_000,
        ),
        requestTimeoutMs: Math.floor(
          getPositiveNumber(rawServer, ["requestTimeoutMs"]) ??
            (getPositiveNumber(rawServer, ["timeout"]) ?? 60) * 1_000,
        ),
        supportsParallelToolCalls:
          getBoolean(rawServer, ["supportsParallelToolCalls", "supports_parallel_tool_calls"]) ??
          false,
      };
    }
  }
  const resolved = resolveMcpTransportConfig(serverName, rawServer);
  return resolved
    ? {
        connectionTimeoutMs: resolved.connectionTimeoutMs,
        requestTimeoutMs: resolved.requestTimeoutMs,
        supportsParallelToolCalls: resolved.supportsParallelToolCalls,
      }
    : null;
}

/** Resolve Claude's native MCP transport shapes for the policy proxy. */
export function resolveClaudeMcpProxyTransport(
  serverName: string,
  rawServer: unknown,
): ClaudeMcpProxyTransport | null {
  if (isRecord(rawServer)) {
    const transportType = normalizeLowercaseStringOrEmpty(
      typeof rawServer.type === "string" ? rawServer.type : rawServer.transport,
    );
    if (transportType === "ws" || transportType === "websocket") {
      if (typeof rawServer.url !== "string") {
        return null;
      }
      const url = new URL(rawServer.url);
      if (url.protocol !== "ws:" && url.protocol !== "wss:") {
        return null;
      }
      const settings = resolveClaudeMcpProxyRuntimeSettings(serverName, rawServer);
      if (!settings) {
        return null;
      }
      return {
        transport: new ClaudeMcpWebSocketTransport(url, normalizeStringRecord(rawServer.headers)),
        ...settings,
      };
    }
  }
  return resolveMcpTransport(serverName, rawServer);
}

function resolveProxyRuntime(policyPath: string): {
  args: string[];
  env?: Record<string, string>;
} {
  const packageRoot = resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });
  if (!packageRoot) {
    throw new Error("Claude MCP policy proxy could not resolve the OpenClaw package root");
  }
  const sourceRuntime = fileURLToPath(import.meta.url).endsWith(".ts");
  if (!sourceRuntime) {
    return {
      args: [
        path.join(packageRoot, "dist", "agents", "claude-mcp-policy-proxy.runtime.js"),
        policyPath,
      ],
    };
  }
  const runtimePath = path.join(packageRoot, "src", "agents", "claude-mcp-policy-proxy.runtime.ts");
  if (isBunRuntime(process.execPath)) {
    return { args: [runtimePath, policyPath] };
  }
  const tsxLoader = require.resolve("tsx", { paths: [packageRoot] });
  return {
    args: ["--import", tsxLoader, runtimePath, policyPath],
    // Claude launches MCP servers in the agent workspace. Pin the source
    // tsconfig so tsx can resolve OpenClaw workspace package aliases there.
    env: { TSX_TSCONFIG_PATH: path.join(packageRoot, "tsconfig.json") },
  };
}

/** Replace external Claude MCP entries with policy-enforcing local proxy processes. */
export async function prepareClaudeMcpPolicyProxy(params: {
  mcpConfigPath: string;
  servers: ClaudeMcpProxyServerPolicy[];
  env: Record<string, string>;
  relay: {
    provider: "claude";
    relayId: string;
    generation: string;
  };
}): Promise<void> {
  if (params.servers.length === 0) {
    return;
  }
  const rawConfig = JSON.parse(await fs.readFile(params.mcpConfigPath, "utf-8")) as unknown;
  if (!isRecord(rawConfig) || !isRecord(rawConfig.mcpServers)) {
    throw new Error("Claude MCP policy proxy requires an object mcpServers config");
  }

  const configDir = path.dirname(params.mcpConfigPath);
  const mcpServers = { ...rawConfig.mcpServers };

  for (const [index, policy] of params.servers.entries()) {
    const rawServer = mcpServers[policy.runtimeName];
    if (!isRecord(rawServer)) {
      throw new Error(`Claude MCP policy proxy could not find server ${policy.runtimeName}`);
    }
    const preparedUpstream = prepareUpstreamServer(rawServer, params.env);
    const runtimeSettings = resolveClaudeMcpProxyRuntimeSettings(
      policy.configuredName,
      preparedUpstream,
    );
    if (!runtimeSettings) {
      throw new Error(`Claude MCP policy proxy could not resolve server ${policy.configuredName}`);
    }
    const policyPath = path.join(configDir, `openclaw-claude-mcp-policy-${index}.json`);
    const proxyRuntime = resolveProxyRuntime(policyPath);
    const existingArgs = normalizeStringArray(rawServer.args);
    if (rawServer.command === process.execPath && existingArgs?.at(-1) === policyPath) {
      continue;
    }
    await fs.writeFile(
      policyPath,
      `${JSON.stringify(
        {
          upstream: preparedUpstream,
          policy,
          relay: params.relay,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
    mcpServers[policy.runtimeName] = {
      command: process.execPath,
      args: proxyRuntime.args,
      // MCP stdio launchers commonly sanitize temp-directory variables. The
      // authenticated hook relay registry must resolve to the parent's path.
      env: {
        ...proxyRuntime.env,
        TEMP: tmpdir(),
        TMP: tmpdir(),
        TMPDIR: tmpdir(),
      },
      timeout: CLAUDE_MCP_POLICY_RELAY_TIMEOUT_MS + runtimeSettings.requestTimeoutMs,
      ...(typeof rawServer.alwaysLoad === "boolean" ? { alwaysLoad: rawServer.alwaysLoad } : {}),
    };
  }

  await fs.writeFile(
    params.mcpConfigPath,
    `${JSON.stringify({ ...rawConfig, mcpServers }, null, 2)}\n`,
    { encoding: "utf-8", mode: 0o600 },
  );
}
