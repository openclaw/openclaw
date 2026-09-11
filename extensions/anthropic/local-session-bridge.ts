// Loopback bridge between the live local session source and the Claude Code
// channel processes it feeds. Claude Code spawns the channel MCP server itself
// (from `.mcp.json`), so the only rendezvous we control is a deterministic
// socket path under the OpenClaw state dir. Hook processes use the same socket
// to report which Claude session a channel process belongs to.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  isRecord,
  readNonEmptyStringPreservingWhitespace,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const CLAUDE_CHANNEL_SOCKET_NAME = "claude-channel.sock";
/** Claude Code waits for hooks; a channel that never acks must not stall the Gateway input path. */
const INPUT_ACK_TIMEOUT_MS = 5_000;
/** Hook and MCP startup race at session start; keep an unmatched hello/hook around this long. */
const PAIRING_WINDOW_MS = 60_000;
const MAX_LINE_BYTES = 256 * 1024;

type ClaudeHookEvent = "SessionStart" | "UserPromptSubmit" | "Stop" | "SessionEnd";

export type ClaudeChannelBridgeEvents = {
  /** A channel process is now paired with (or unpaired from) a Claude session. */
  onPairingChange(sessionId: string, connected: boolean): void;
  onHook(event: { name: ClaudeHookEvent; sessionId: string; cwd?: string }): void;
};

export type ClaudeChannelBridge = {
  readonly endpoint: string;
  isConnected(sessionId: string): boolean;
  /** Resolve true once the channel process wrote the notification to Claude Code. */
  sendInput(input: {
    sessionId: string;
    inputId: string;
    content: string;
    meta: Record<string, string>;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
  close(): Promise<void>;
};

/** Socket path (named pipe on Windows) both the source and the channel server derive. */
export function resolveClaudeChannelBridgeEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env);
  if (process.platform === "win32") {
    const digest = createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\openclaw-claude-channel-${digest}`;
  }
  return path.join(stateDir, "node", CLAUDE_CHANNEL_SOCKET_NAME);
}

type ChannelConnection = {
  socket: net.Socket;
  cwd?: string;
  /** The Claude Code process that spawned the channel server. */
  ppid?: number;
  sessionId?: string;
  connectedAt: number;
  pendingAcks: Map<string, (result: { ok: true } | { ok: false; reason: string }) => void>;
};

type PendingSessionStart = { sessionId: string; cwd: string; ancestorPids: number[]; at: number };

function writeLine(socket: net.Socket, frame: Record<string, unknown>): void {
  if (!socket.destroyed) {
    socket.write(`${JSON.stringify(frame)}\n`);
  }
}

/** Frame fields are untrusted socket input: keep them non-empty and bounded, whitespace intact (paths). */
function readBoundedFrameText(value: unknown, max = 4096): string | undefined {
  const text = readNonEmptyStringPreservingWhitespace(value);
  return text !== undefined && text.length <= max ? text : undefined;
}

function readPidList(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((pid): pid is number => Number.isInteger(pid) && pid > 0).slice(0, 8)
    : [];
}

function readPid(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isHookEvent(value: unknown): value is ClaudeHookEvent {
  return (
    value === "SessionStart" ||
    value === "UserPromptSubmit" ||
    value === "Stop" ||
    value === "SessionEnd"
  );
}

export async function createClaudeChannelBridge(params: {
  endpoint: string;
  events: ClaudeChannelBridgeEvents;
  now?: () => number;
}): Promise<ClaudeChannelBridge> {
  const now = params.now ?? Date.now;
  const channels = new Set<ChannelConnection>();
  const bySession = new Map<string, ChannelConnection>();
  const pendingStarts: PendingSessionStart[] = [];

  // A start that already paired (or ended) must not pair a later channel: a
  // retained cwd-only entry would hand the next hello in that directory an
  // unrelated session, routing team input into the wrong Claude process.
  const forgetStart = (sessionId: string) => {
    const index = pendingStarts.findIndex((entry) => entry.sessionId === sessionId);
    if (index >= 0) {
      pendingStarts.splice(index, 1);
    }
  };

  const pair = (connection: ChannelConnection, sessionId: string) => {
    forgetStart(sessionId);
    if (connection.sessionId === sessionId) {
      return;
    }
    const previous = bySession.get(sessionId);
    if (previous && previous !== connection) {
      previous.sessionId = undefined;
    }
    if (connection.sessionId) {
      bySession.delete(connection.sessionId);
      params.events.onPairingChange(connection.sessionId, false);
    }
    connection.sessionId = sessionId;
    bySession.set(sessionId, connection);
    params.events.onPairingChange(sessionId, true);
  };

  const unpair = (connection: ChannelConnection) => {
    const sessionId = connection.sessionId;
    if (!sessionId) {
      return;
    }
    connection.sessionId = undefined;
    if (bySession.get(sessionId) === connection) {
      bySession.delete(sessionId);
      params.events.onPairingChange(sessionId, false);
    }
  };

  // Pairing rule: a SessionStart hook names the session. The channel process is
  // a child of the Claude process and the hook runs beneath it, so a channel
  // whose ppid is in the hook's ancestry belongs to that session, whatever else
  // runs in the same directory. Without ancestry (Windows) the cwd is the only
  // clue, and it only identifies a channel when exactly one unpaired channel
  // lives there: guessing between two would route a teammate's instruction
  // into the wrong native session, so ambiguity stays unpaired.
  const pairSession = (sessionId: string, cwd: string, ancestorPids: number[]): boolean => {
    if (bySession.has(sessionId)) {
      return true;
    }
    const byProcess = [...channels].find(
      (connection) => connection.ppid !== undefined && ancestorPids.includes(connection.ppid),
    );
    const byCwd =
      ancestorPids.length === 0
        ? [...channels].filter((connection) => connection.cwd === cwd && !connection.sessionId)
        : [];
    const chosen = byProcess ?? (byCwd.length === 1 ? byCwd[0] : undefined);
    if (!chosen) {
      return false;
    }
    pair(chosen, sessionId);
    return true;
  };

  const rememberStart = (sessionId: string, cwd: string, ancestorPids: number[]) => {
    const cutoff = now() - PAIRING_WINDOW_MS;
    const kept = pendingStarts.filter(
      (entry) => entry.at >= cutoff && entry.sessionId !== sessionId,
    );
    pendingStarts.splice(0, pendingStarts.length, ...kept, {
      sessionId,
      cwd,
      ancestorPids,
      at: now(),
    });
  };

  const handleHook = (frame: Record<string, unknown>) => {
    const name = frame.event;
    const sessionId = readBoundedFrameText(frame.sessionId, 256);
    const cwd = readBoundedFrameText(frame.cwd);
    const ancestorPids = readPidList(frame.ancestorPids);
    if (!isHookEvent(name) || !sessionId) {
      return;
    }
    if (name === "SessionEnd") {
      forgetStart(sessionId);
      const connection = bySession.get(sessionId);
      if (connection) {
        unpair(connection);
      }
    } else if (cwd && !pairSession(sessionId, cwd, ancestorPids)) {
      rememberStart(sessionId, cwd, ancestorPids);
    }
    params.events.onHook({ name, sessionId, ...(cwd ? { cwd } : {}) });
  };

  const handleHello = (connection: ChannelConnection, frame: Record<string, unknown>) => {
    connection.cwd = readBoundedFrameText(frame.cwd);
    connection.ppid = readPid(frame.ppid);
    if (!connection.cwd) {
      return;
    }
    const cutoff = now() - PAIRING_WINDOW_MS;
    const ppid = connection.ppid;
    const byProcess =
      ppid === undefined
        ? -1
        : pendingStarts.findLastIndex(
            (entry) => entry.at >= cutoff && entry.ancestorPids.includes(ppid),
          );
    // Same rule as pairSession: a cwd-only start pairs only when it is the sole
    // recent start for that directory.
    const byCwd = pendingStarts.flatMap((entry, index) =>
      entry.at >= cutoff && entry.ancestorPids.length === 0 && entry.cwd === connection.cwd
        ? [index]
        : [],
    );
    const index = byProcess >= 0 ? byProcess : byCwd.length === 1 ? byCwd[0]! : -1;
    const start = index >= 0 ? pendingStarts[index] : undefined;
    if (start) {
      pair(connection, start.sessionId);
    }
  };

  const handleFrame = (connection: ChannelConnection, frame: Record<string, unknown>) => {
    switch (frame.type) {
      case "hello":
        channels.add(connection);
        handleHello(connection, frame);
        return;
      case "hook":
        handleHook(frame);
        return;
      case "delivered":
      case "failed": {
        const inputId = readBoundedFrameText(frame.inputId, 256);
        const resolve = inputId ? connection.pendingAcks.get(inputId) : undefined;
        if (inputId && resolve) {
          connection.pendingAcks.delete(inputId);
          resolve(
            frame.type === "delivered"
              ? { ok: true }
              : {
                  ok: false,
                  reason: readBoundedFrameText(frame.reason, 512) ?? "channel delivery failed",
                },
          );
        }
        break;
      }
      default:
        // "reply": Claude's reply already lands in the transcript as a tool call; nothing to project twice.
        break;
    }
  };

  const server = net.createServer((socket) => {
    const connection: ChannelConnection = {
      socket,
      connectedAt: now(),
      pendingAcks: new Map(),
    };
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.length > MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line.trim()) {
          continue;
        }
        let frame: unknown;
        try {
          frame = JSON.parse(line) as unknown;
        } catch {
          continue;
        }
        if (isRecord(frame)) {
          handleFrame(connection, frame);
        }
      }
    });
    const cleanup = () => {
      channels.delete(connection);
      unpair(connection);
      for (const resolve of connection.pendingAcks.values()) {
        resolve({ ok: false, reason: "channel disconnected before delivery" });
      }
      connection.pendingAcks.clear();
    };
    socket.on("close", cleanup);
    socket.on("error", () => socket.destroy());
  });

  if (process.platform !== "win32") {
    await fs.mkdir(path.dirname(params.endpoint), { recursive: true });
    // A previous node-host process may have died without unlinking; the path is
    // ours by construction, so reclaiming it is safe.
    await fs.rm(params.endpoint, { force: true });
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params.endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") {
    await fs.chmod(params.endpoint, 0o600).catch(() => {});
  }

  return {
    endpoint: params.endpoint,
    isConnected: (sessionId) => bySession.has(sessionId),
    sendInput: (input) => {
      const connection = bySession.get(input.sessionId);
      if (!connection) {
        return Promise.resolve({ ok: false, reason: "no channel connected" });
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          connection.pendingAcks.delete(input.inputId);
          resolve({ ok: false, reason: "channel did not acknowledge delivery" });
        }, INPUT_ACK_TIMEOUT_MS);
        connection.pendingAcks.set(input.inputId, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
        writeLine(connection.socket, {
          type: "input",
          inputId: input.inputId,
          sessionId: input.sessionId,
          content: input.content,
          meta: input.meta,
        });
      });
    },
    close: async () => {
      for (const connection of channels) {
        connection.socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      if (process.platform !== "win32") {
        await fs.rm(params.endpoint, { force: true }).catch(() => {});
      }
    },
  };
}
