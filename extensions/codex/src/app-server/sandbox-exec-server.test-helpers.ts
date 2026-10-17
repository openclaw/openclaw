import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { vi } from "vitest";
import type { RawData, WebSocket } from "ws";
import { websocket } from "./sandbox-exec-server.websocket.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

type RpcResponse = {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
};
type Backend = NonNullable<SandboxContext["backend"]>;
type FsBridge = NonNullable<SandboxContext["fsBridge"]>;
type ProcessRead = {
  chunks?: Array<{ seq?: number; stream: string; chunk: string }>;
  exited?: boolean;
  exitCode?: number;
  closed?: boolean;
  nextSeq?: number;
};

export function createSandboxContext(overrides: {
  buildExecSpec?: Backend["buildExecSpec"];
  finalizeExec?: Backend["finalizeExec"];
  runShellCommand?: Backend["runShellCommand"];
  copyFile?: FsBridge["copyFile"];
  mkdirp?: FsBridge["mkdirp"];
  readFile?: FsBridge["readFile"];
  remove?: FsBridge["remove"];
  resolvePinnedMutationTarget?: FsBridge["resolvePinnedMutationTarget"];
  resolveReadPolicyPath?: FsBridge["resolveReadPolicyPath"];
  stat?: FsBridge["stat"];
  writeFile?: FsBridge["writeFile"];
}): SandboxContext {
  return {
    enabled: true,
    backendId: "docker",
    sessionKey: "agent:codex:test",
    workspaceDir: "/host/workspace",
    agentWorkspaceDir: "/host/workspace",
    workspaceAccess: "rw",
    runtimeId: "openclaw-test-runtime",
    runtimeLabel: "openclaw-test-runtime",
    containerName: "openclaw-test-runtime",
    containerWorkdir: "/workspace",
    docker: { binds: [], image: "test", workdir: "/workspace", env: {}, network: "none" },
    tools: {},
    browserAllowHostControl: false,
    backend: {
      id: "docker",
      runtimeId: "openclaw-test-runtime",
      runtimeLabel: "openclaw-test-runtime",
      workdir: "/workspace",
      buildExecSpec:
        overrides.buildExecSpec ??
        (async () => ({
          argv: [process.execPath, "-e", ""],
          env: { PATH: process.env.PATH },
          stdinMode: "pipe-closed",
        })),
      finalizeExec: overrides.finalizeExec,
      runShellCommand:
        overrides.runShellCommand ??
        (async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 })),
    },
    fsBridge: {
      resolvePath: ({ filePath }: Parameters<FsBridge["resolvePath"]>[0]) => ({
        relativePath: filePath,
        containerPath: filePath,
      }),
      copyFile: overrides.copyFile ?? (async () => undefined),
      readFile: overrides.readFile ?? (async () => Buffer.alloc(0)),
      writeFile: overrides.writeFile ?? (async () => undefined),
      mkdirp: overrides.mkdirp ?? (async () => undefined),
      remove: overrides.remove ?? (async () => undefined),
      rename: async () => undefined,
      resolvePinnedMutationTarget: overrides.resolvePinnedMutationTarget,
      resolveReadPolicyPath: overrides.resolveReadPolicyPath,
      stat:
        overrides.stat ??
        (async ({ filePath }) => ({
          type: /\.[^/]+$/u.test(filePath) ? "file" : "directory",
          size: 1,
          mtimeMs: 1,
        })),
    },
  } as unknown as SandboxContext;
}

export function createClient(options: { serverVersion?: string } = {}) {
  return {
    getServerVersion: vi.fn(() => options.serverVersion ?? CODEX_APP_SERVER_VERSION),
    request: vi.fn(async (_method: string, _params?: unknown) => ({})),
  };
}

export function execServerUrlFromClient(
  client: ReturnType<typeof createClient>,
  callIndex = 0,
): string {
  const params = client.request.mock.calls[callIndex]?.[1];
  if (!params || typeof params !== "object" || !("execServerUrl" in params)) {
    throw new Error(`missing execServerUrl for environment/add call ${callIndex}`);
  }
  const { execServerUrl } = params as { execServerUrl?: unknown };
  if (typeof execServerUrl !== "string" || !execServerUrl) {
    throw new Error(`invalid execServerUrl for environment/add call ${callIndex}`);
  }
  return execServerUrl;
}

export function codexFsSandboxContext(params: {
  entries: Array<{ path: unknown; access: "read" | "write" | "none" | "deny" }>;
  cwd?: string;
}): unknown {
  return {
    permissions: {
      type: "managed",
      file_system: { type: "restricted", entries: params.entries },
      network: "restricted",
    },
    cwd: params.cwd ?? "file:///workspace",
    windowsSandboxLevel: "disabled",
    windowsSandboxPrivateDesktop: false,
    useLegacyLandlock: false,
  };
}

export function specialPath(kind: string, subpath?: string): unknown {
  return { type: "special", value: { kind, ...(subpath ? { subpath } : {}) } };
}

export function globPath(pattern: string): unknown {
  return { type: "glob_pattern", pattern };
}

export function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new websocket.WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

export function collectNotifications(
  socket: WebSocket,
): Array<{ method: string; params?: unknown }> {
  const notifications: Array<{ method: string; params?: unknown }> = [];
  socket.on("message", (data) => {
    const message = JSON.parse(Buffer.from(data as Buffer).toString("utf8")) as {
      id?: number;
      method?: string;
      params?: unknown;
    };
    if (message.id === undefined && message.method) {
      notifications.push({ method: message.method, params: message.params });
    }
  });
  return notifications;
}

/** Polls process/read until the managed sandbox process reports closed. */
export async function readUntilClosed(socket: WebSocket, processId: string): Promise<ProcessRead> {
  let afterSeq = 0;
  const chunks: Array<{ stream: string; chunk: string }> = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const read = (await rpc(socket, "process/read", {
      processId,
      afterSeq,
      waitMs: 1000,
    })) as ProcessRead;
    chunks.push(...(read.chunks ?? []));
    afterSeq = Math.max(afterSeq, (read.nextSeq ?? 1) - 1);
    if (read.closed) {
      return { ...read, chunks };
    }
  }
  throw new Error(`process ${processId} did not close`);
}

export function waitForSocketClose(socket: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve) => {
    socket.once("close", (code) => resolve({ code }));
  });
}

/** Waits until the requested number of streaming HTTP body-delta notifications arrive. */
export async function waitForHttpBodyDeltas(
  notifications: Array<{ method: string; params?: unknown }>,
  count: number,
): Promise<unknown[]> {
  // Preserve the 500 ms failure budget while checking completed streams sooner.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const deltas = notifications
      .filter((notification) => notification.method === "http/request/bodyDelta")
      .map((notification) => notification.params);
    if (deltas.length >= count) {
      return deltas;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error(`expected ${count} http body deltas`);
}

export function rpc(socket: WebSocket, method: string, params: unknown): Promise<unknown> {
  const id = Math.floor(Math.random() * 1_000_000);
  return new Promise((resolve, reject) => {
    const onMessage = (data: RawData) => {
      const response = JSON.parse(Buffer.from(data as Buffer).toString("utf8")) as RpcResponse;
      if (response.id !== id) {
        return;
      }
      socket.off("message", onMessage);
      if (response.error) {
        reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
        return;
      }
      resolve(response.result);
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}
