import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type {
  CliportDaemon,
  CliportDaemonOptions,
  CliportExecResult,
  CliportRegistry,
  CliportRegistryEntry,
  CliportRequest,
  RateCounter,
} from "./types.js";
import { validateCwd, validatePathLikeArgs } from "./path-guards.js";
import {
  FRAME_STDERR,
  FRAME_STDOUT,
  encodeErrorFrame,
  encodeExitFrame,
  encodeFrame,
} from "./protocol.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_GLOBAL_RATE_LIMIT = 120;
const DEFAULT_MASKED_PATHS = ["memory/private", "memory/users", "config"];
const DEFAULT_SANDBOX_WORKSPACE_ROOT = "/workspace";
const LEGACY_SANDBOX_AGENT_ROOT = "/agent";
const MAX_LINE_LENGTH = 65_536; // 64KB max per request line
const MAX_CONNECTIONS = 50;
const MAX_ARG_LENGTH = 8192; // 8KB per argument
const MAX_TOTAL_ARGS_LENGTH = 65_536; // 64KB total across all args

type AllowedTokenBinding = {
  token: string;
  sessionKey?: string;
  containerName?: string;
};

function readJsonSafe<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readRegistry(registryPath: string): Promise<CliportRegistry> {
  const raw = await fs.readFile(registryPath, "utf-8").catch(() => "");
  const parsed = raw ? readJsonSafe<CliportRegistry>(raw) : null;
  if (!parsed || typeof parsed !== "object") {
    return {
      version: 1,
      clis: {},
      globalRateLimitPerMinute: DEFAULT_GLOBAL_RATE_LIMIT,
      maskedPaths: [...DEFAULT_MASKED_PATHS],
    };
  }
  return {
    version: typeof parsed.version === "number" ? parsed.version : 1,
    clis: parsed.clis && typeof parsed.clis === "object" ? parsed.clis : {},
    globalRateLimitPerMinute:
      typeof parsed.globalRateLimitPerMinute === "number"
        ? parsed.globalRateLimitPerMinute
        : DEFAULT_GLOBAL_RATE_LIMIT,
    maskedPaths:
      Array.isArray(parsed.maskedPaths) &&
      parsed.maskedPaths.every((entry) => typeof entry === "string")
        ? parsed.maskedPaths
        : [...DEFAULT_MASKED_PATHS],
    workspaceRoot: typeof parsed.workspaceRoot === "string" ? parsed.workspaceRoot : undefined,
    sandboxAgentRoot:
      typeof parsed.sandboxAgentRoot === "string" ? parsed.sandboxAgentRoot : undefined,
    timeoutMsDefault:
      typeof parsed.timeoutMsDefault === "number" ? parsed.timeoutMsDefault : undefined,
  };
}

function upsertTokenBinding(
  map: Map<string, AllowedTokenBinding>,
  entry: AllowedTokenBinding,
): void {
  const token = entry.token.trim();
  if (!token) {
    return;
  }
  const existing = map.get(token);
  map.set(token, {
    token,
    sessionKey: entry.sessionKey?.trim() || existing?.sessionKey,
    containerName: entry.containerName?.trim() || existing?.containerName,
  });
}

function parseTokenBinding(value: unknown): AllowedTokenBinding | null {
  if (typeof value === "string") {
    const token = value.trim();
    return token ? { token } : null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const token = typeof record.token === "string" ? record.token.trim() : "";
  if (!token) {
    return null;
  }
  const sessionKey = typeof record.sessionKey === "string" ? record.sessionKey.trim() : "";
  const containerName = typeof record.containerName === "string" ? record.containerName.trim() : "";
  return {
    token,
    sessionKey: sessionKey || undefined,
    containerName: containerName || undefined,
  };
}

function timingSafeStringEquals(left: string, right: string): boolean {
  const lhs = Buffer.from(left, "utf-8");
  const rhs = Buffer.from(right, "utf-8");
  if (lhs.length !== rhs.length) {
    return false;
  }
  return timingSafeEqual(lhs, rhs);
}

function findTokenBinding(
  tokens: Map<string, AllowedTokenBinding>,
  requestToken: string,
): AllowedTokenBinding | null {
  for (const binding of tokens.values()) {
    if (timingSafeStringEquals(binding.token, requestToken)) {
      return binding;
    }
  }
  return null;
}

async function readAllowedTokens(
  stateDir: string,
  defaults?: string[],
): Promise<Map<string, AllowedTokenBinding>> {
  const out = new Map<string, AllowedTokenBinding>();
  for (const token of defaults ?? []) {
    const trimmed = token.trim();
    if (trimmed) {
      upsertTokenBinding(out, { token: trimmed });
    }
  }

  const tokenFile = path.join(stateDir, "cliport", "tokens.json");
  const raw = await fs.readFile(tokenFile, "utf-8").catch(() => "");
  const parsed = raw ? readJsonSafe<Record<string, unknown>>(raw) : null;
  if (!parsed || typeof parsed !== "object") {
    return out;
  }

  const tokens = parsed.tokens;
  if (!Array.isArray(tokens)) {
    return out;
  }

  for (const token of tokens) {
    const binding = parseTokenBinding(token);
    if (!binding) {
      continue;
    }
    upsertTokenBinding(out, binding);
  }

  return out;
}

function tokenBindingMatchesRequest(
  binding: AllowedTokenBinding,
  request: CliportRequest,
): boolean {
  if (
    binding.sessionKey &&
    (!request.sessionKey || !timingSafeStringEquals(binding.sessionKey, request.sessionKey))
  ) {
    return false;
  }
  if (
    binding.containerName &&
    (!request.containerName || !timingSafeStringEquals(binding.containerName, request.containerName))
  ) {
    return false;
  }
  return true;
}

function nowMinute(): number {
  return Math.floor(Date.now() / 60_000);
}

function checkRateLimit(params: {
  key: string;
  limitPerMinute: number;
  state: Map<string, RateCounter>;
}): boolean {
  if (params.limitPerMinute <= 0) {
    return true;
  }

  const minute = nowMinute();
  const current = params.state.get(params.key);
  if (!current || current.windowMinute !== minute) {
    params.state.set(params.key, { windowMinute: minute, count: 1 });
    return true;
  }

  if (current.count >= params.limitPerMinute) {
    return false;
  }

  current.count += 1;
  params.state.set(params.key, current);
  return true;
}

function normalizeRequest(value: unknown): CliportRequest | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.type !== "exec") {
    return null;
  }
  const token = typeof record.token === "string" ? record.token.trim() : "";
  const cli = typeof record.cli === "string" ? record.cli.trim() : "";
  const cwd = typeof record.cwd === "string" ? record.cwd.trim() : "";
  const rawArgs = Array.isArray(record.args)
    ? record.args.filter((entry): entry is string => typeof entry === "string")
    : [];
  // Strip null bytes from arguments and enforce length limits
  const args: string[] = [];
  let totalArgsLength = 0;
  for (const arg of rawArgs) {
    const sanitized = arg.replace(/\0/g, "");
    if (sanitized.length > MAX_ARG_LENGTH) {
      return null;
    }
    totalArgsLength += sanitized.length;
    if (totalArgsLength > MAX_TOTAL_ARGS_LENGTH) {
      return null;
    }
    args.push(sanitized);
  }

  if (!token || !cli || !cwd) {
    return null;
  }

  return {
    type: "exec",
    token,
    cli,
    cwd,
    args,
    sessionKey:
      typeof record.sessionKey === "string" ? record.sessionKey.trim() || undefined : undefined,
    containerName:
      typeof record.containerName === "string"
        ? record.containerName.trim() || undefined
        : undefined,
    timeoutMs: typeof record.timeoutMs === "number" ? record.timeoutMs : undefined,
  };
}

async function appendPorterLog(params: { workspaceDir: string; payload: Record<string, unknown> }) {
  const logsDir = path.join(params.workspaceDir, "logs");
  await fs.mkdir(logsDir, { recursive: true });
  const logPath = path.join(logsDir, "porter.jsonl");
  await fs.appendFile(logPath, `${JSON.stringify(params.payload)}\n`, "utf-8");
}

function buildSpawnEnv(entry: CliportRegistryEntry): NodeJS.ProcessEnv {
  // Start with minimal base environment so CLIs have essential variables
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: process.env.TERM ?? "xterm-256color",
  };
  // Merge registry-specific env (overrides base if set)
  for (const [key, value] of Object.entries(entry.env ?? {})) {
    env[key] = String(value);
  }
  return env;
}

function executeCli(params: {
  request: CliportRequest;
  entry: CliportRegistryEntry;
  hostCwd: string;
  socket: net.Socket;
  timeoutMs: number;
}): Promise<CliportExecResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let timedOut = false;
    const args = [...(params.entry.args ?? []), ...params.request.args];
    const child = spawn(params.entry.command, args, {
      cwd: params.hostCwd,
      env: buildSpawnEnv(params.entry),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let closed = false;
    let killerTimeout: ReturnType<typeof setTimeout> | undefined;

    const killChild = (signal: NodeJS.Signals, escalateAfterMs?: number) => {
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
      if (escalateAfterMs !== undefined && !killerTimeout) {
        killerTimeout = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, escalateAfterMs);
        killerTimeout.unref?.();
      }
    };

    const cleanup = () => {
      if (killerTimeout) {
        clearTimeout(killerTimeout);
        killerTimeout = undefined;
      }
      clearTimeout(timeout);
      params.socket.removeListener("close", closeHandler);
      params.socket.removeListener("error", closeHandler);
    };

    const timeout = setTimeout(
      () => {
        timedOut = true;
        killChild("SIGTERM", 5000);
      },
      Math.max(1, params.timeoutMs),
    );

    const closeHandler = () => {
      killChild("SIGTERM", 1000);
    };

    params.socket.once("close", closeHandler);
    params.socket.once("error", closeHandler);

    child.stdout.on("data", (chunk: Buffer) => {
      if (closed) {
        return;
      }
      const ok = params.socket.write(encodeFrame(FRAME_STDOUT, chunk));
      if (!ok) {
        child.stdout.pause();
        params.socket.once("drain", () => child.stdout.resume());
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (closed) {
        return;
      }
      const ok = params.socket.write(encodeFrame(FRAME_STDERR, chunk));
      if (!ok) {
        child.stderr.pause();
        params.socket.once("drain", () => child.stderr.resume());
      }
    });

    child.on("error", (err) => {
      if (closed) {
        return;
      }
      closed = true;
      cleanup();
      params.socket.write(encodeErrorFrame(`spawn failed: ${err.message}`));
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (closed) {
        return;
      }
      closed = true;
      cleanup();
      params.socket.write(
        encodeExitFrame({
          code,
          signal,
          timedOut,
          durationMs: Date.now() - startedAt,
        }),
      );
      resolve({
        code,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function handleRequest(params: {
  socket: net.Socket;
  request: CliportRequest;
  options: CliportDaemonOptions;
  globalRateState: Map<string, RateCounter>;
  cliRateState: Map<string, RateCounter>;
}) {
  const registry = await readRegistry(params.options.registryPath);
  const tokens = await readAllowedTokens(params.options.stateDir, params.options.defaultTokens);
  const tokenBinding = findTokenBinding(tokens, params.request.token);
  if (!tokenBinding || !tokenBindingMatchesRequest(tokenBinding, params.request)) {
    params.socket.write(encodeErrorFrame("invalid cliport token"));
    return;
  }

  const cli = params.request.cli;
  const entry = registry.clis[cli];
  if (!entry) {
    params.socket.write(encodeErrorFrame(`cli not allowed: ${cli}`));
    return;
  }

  const globalLimit = Math.max(
    1,
    Math.floor(registry.globalRateLimitPerMinute ?? DEFAULT_GLOBAL_RATE_LIMIT),
  );
  if (
    !checkRateLimit({
      key: "global",
      limitPerMinute: globalLimit,
      state: params.globalRateState,
    })
  ) {
    params.socket.write(encodeErrorFrame("cliport global rate limit exceeded"));
    return;
  }

  const perCliLimit = Math.max(1, Math.floor(entry.rateLimitPerMinute ?? globalLimit));
  if (
    !checkRateLimit({
      key: cli,
      limitPerMinute: perCliLimit,
      state: params.cliRateState,
    })
  ) {
    params.socket.write(encodeErrorFrame(`cliport rate limit exceeded for ${cli}`));
    return;
  }

  const workspaceRoot = path.resolve(registry.workspaceRoot ?? params.options.workspaceDir);
  const sandboxRoots = Array.from(
    new Set(
      [registry.sandboxAgentRoot ?? DEFAULT_SANDBOX_WORKSPACE_ROOT, LEGACY_SANDBOX_AGENT_ROOT]
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
  const maskedPaths = registry.maskedPaths ?? DEFAULT_MASKED_PATHS;

  let hostCwd: string;
  let relCwd: string;
  try {
    const cwdResolved = validateCwd({
      sandboxCwd: params.request.cwd,
      sandboxRoots,
      workspaceRoot,
      maskedPaths,
    });
    hostCwd = cwdResolved.hostCwd;
    relCwd = cwdResolved.relPath;
  } catch (err) {
    params.socket.write(
      encodeErrorFrame(`cwd rejected: ${err instanceof Error ? err.message : String(err)}`),
    );
    return;
  }

  try {
    validatePathLikeArgs({
      args: params.request.args,
      hostCwd,
      workspaceRoot,
      maskedPaths,
    });
  } catch (err) {
    params.socket.write(
      encodeErrorFrame(`args rejected: ${err instanceof Error ? err.message : String(err)}`),
    );
    return;
  }

  const serverTimeoutMs = Math.max(
    1,
    Math.floor(entry.timeoutMs ?? registry.timeoutMsDefault ?? DEFAULT_TIMEOUT_MS),
  );
  // Client-supplied timeout cannot exceed server-configured maximum
  const timeoutMs =
    typeof params.request.timeoutMs === "number"
      ? Math.max(1, Math.min(Math.floor(params.request.timeoutMs), serverTimeoutMs))
      : serverTimeoutMs;

  const requestId = randomUUID();
  const startedAt = Date.now();
  try {
    const result = await executeCli({
      request: params.request,
      entry,
      hostCwd,
      socket: params.socket,
      timeoutMs,
    });
    await appendPorterLog({
      workspaceDir: workspaceRoot,
      payload: {
        ts: new Date().toISOString(),
        requestId,
        cli,
        args: params.request.args,
        cwd: relCwd,
        durationMs: result.durationMs,
        timeoutMs,
        timedOut: result.timedOut,
        code: result.code,
        signal: result.signal,
        sessionKey: params.request.sessionKey,
      },
    });
  } catch (err) {
    await appendPorterLog({
      workspaceDir: workspaceRoot,
      payload: {
        ts: new Date().toISOString(),
        requestId,
        cli,
        args: params.request.args,
        cwd: relCwd,
        durationMs: Date.now() - startedAt,
        timeoutMs,
        error: err instanceof Error ? err.message : String(err),
        sessionKey: params.request.sessionKey,
      },
    });
  }
}

export function createCliportDaemon(options: CliportDaemonOptions): CliportDaemon {
  let server: net.Server | undefined;
  let running = false;
  const globalRateState = new Map<string, RateCounter>();
  const cliRateState = new Map<string, RateCounter>();

  return {
    get server() {
      return server;
    },
    isRunning: () => running,
    start: async () => {
      if (running) {
        return;
      }
      await fs.mkdir(path.dirname(options.socketPath), { recursive: true });
      await fs.mkdir(path.dirname(options.registryPath), { recursive: true });
      await fs.rm(options.socketPath, { force: true }).catch(() => undefined);

      server = net.createServer((socket) => {
        let buffer = "";
        let processing = false;
        const queue: string[] = [];

        const processQueue = async () => {
          if (processing) {
            return;
          }
          processing = true;
          try {
            while (queue.length > 0) {
              const line = queue.shift()!;
              const parsed = readJsonSafe<unknown>(line);
              const request = normalizeRequest(parsed);
              if (!request) {
                socket.write(encodeErrorFrame("invalid request"));
                continue;
              }
              await handleRequest({
                socket,
                request,
                options,
                globalRateState,
                cliRateState,
              });
            }
          } finally {
            processing = false;
          }
        };

        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf-8");

          // Enforce max line length to prevent memory exhaustion
          if (buffer.length > MAX_LINE_LENGTH && !buffer.includes("\n")) {
            socket.write(encodeErrorFrame("request too large"));
            socket.destroy();
            return;
          }

          // Parse all complete lines synchronously
          let idx = buffer.indexOf("\n");
          while (idx !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            idx = buffer.indexOf("\n");
            if (line) {
              queue.push(line);
            }
          }

          // Truncate buffer if it exceeds max even with partial lines
          if (buffer.length > MAX_LINE_LENGTH) {
            socket.write(encodeErrorFrame("request too large"));
            socket.destroy();
            return;
          }

          // Process queued lines serially (async handling is serialized)
          void processQueue();
        });
      });

      server.maxConnections = MAX_CONNECTIONS;

      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(options.socketPath, () => resolve());
      });
      try {
        await fs.chmod(options.socketPath, 0o600);
      } catch (err) {
        options.logger?.warn?.(
          `[cliport] failed to chmod socket: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      running = true;
      options.logger?.info?.(`[cliport] daemon listening on ${options.socketPath}`);
    },
    stop: async () => {
      if (!running) {
        return;
      }
      await new Promise<void>((resolve) => {
        server?.close(() => resolve());
      });
      running = false;
      await fs.rm(options.socketPath, { force: true }).catch(() => undefined);
      options.logger?.info?.("[cliport] daemon stopped");
    },
  };
}

export const __testing = {
  normalizeRequest,
  checkRateLimit,
  readRegistry,
  buildSpawnEnv,
  parseTokenBinding,
  tokenBindingMatchesRequest,
  timingSafeStringEquals,
  findTokenBinding,
  MAX_LINE_LENGTH,
  MAX_CONNECTIONS,
  MAX_ARG_LENGTH,
  MAX_TOTAL_ARGS_LENGTH,
};
