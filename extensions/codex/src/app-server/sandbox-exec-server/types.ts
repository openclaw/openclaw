import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import type { CodexNativeProcessClient } from "../native-process-authority.js";
import type { JsonObject, JsonValue } from "../protocol.js";
import type { SandboxChild, SandboxChildOwner } from "./sandbox-child.js";

/** Minimal JSON-RPC request shape accepted by the sandbox exec-server. */
export type JsonRpcRequest = {
  id?: string | number;
  method?: string;
  params?: JsonValue;
};

/** Narrow JSON-RPC message sink for one connection-owned execution session. */
export type CodexSandboxExecMessageTransport = {
  send: (message: JsonObject) => void;
  isOpen: () => boolean;
};

/** Notification delivery and lifetime owned by one execution session. */
export type CodexSandboxExecSessionNotifications = {
  send: (method: string, params: JsonObject) => void;
  isOpen: () => boolean;
  signal: AbortSignal;
};

/** Buffered process output chunk retained for polling and stream replay. */
export type ProcessChunk = {
  seq: number;
  stream: "stdout" | "stderr" | "pty";
  chunk: string;
};

export type DirectoryEntry = {
  fileName: string;
  isDirectory: boolean;
  isFile: boolean;
};

export type FsAccessMode = "read" | "write" | "none";

export type ResolvedFsSandboxEntry =
  | {
      kind: "path";
      path: string;
      access: FsAccessMode;
    }
  | {
      kind: "glob";
      pattern: string;
      matcher: RegExp;
      literalPrefix: string;
      access: FsAccessMode;
    };

export type ResolvedFsSandboxPolicy = {
  unrestricted: boolean;
  entries: ResolvedFsSandboxEntry[];
};

export type HttpHeader = {
  name: string;
  value: string;
};

export type ManagedProcess = {
  processId: string;
  chunks: ProcessChunk[];
  retainedOutputBytes: number;
  nextSeq: number;
  exited: boolean;
  exitCode: number | null;
  closed: boolean;
  failure: string | null;
  tty: boolean;
  pipeStdin: boolean;
  terminationRequested: boolean;
  child: SandboxChild | null;
  startPromise?: Promise<void>;
  evictionTimer?: ReturnType<typeof setTimeout>;
  waiters: Array<() => void>;
  emitNotification: (method: string, params: JsonObject) => void;
  evictProcess: () => void;
};

/** Common loopback server and lease ownership shared by both execution transports. */
type OpenClawExecServerLease = {
  environmentId: string;
  authPath: string;
  refCount: number;
  closed: boolean;
  url: string;
  sandbox: SandboxContext;
  server: {
    clients: Iterable<{ close: (code?: number, reason?: string) => void }>;
    close: (callback: (error?: Error) => void) => void;
  };
  children: Set<SandboxChildOwner>;
  cleanupTasks: Set<Promise<void>>;
};

/** Locally interpreted exec-server protocol backed by an OpenClaw sandbox. */
export type OpenClawExecServer = OpenClawExecServerLease & {
  processAuthorities?: Map<string, CodexNativeProcessClient>;
  backend: NonNullable<SandboxContext["backend"]>;
  fsBridge: NonNullable<SandboxContext["fsBridge"]>;
  readonly networkIsolated: boolean;
};

/** One pre-authorized, single-use Codex stdio connection. */
export type CodexNodeExecServerLease = {
  id: string;
  channel: Awaited<ReturnType<PluginRuntime["nodes"]["openDuplex"]>>;
  claimed: boolean;
  closed: boolean;
  closeRelay?: () => void;
  onDisconnected?: (error: Error) => void;
  onChannelClosed?: (result: { failed: boolean; error?: unknown }) => void;
};

/** Opaque exec-server relay backed by the exact prepared paired-device placement. */
export type OpenClawNodeExecServer = OpenClawExecServerLease & {
  node: {
    id: string;
    leases: Map<string, CodexNodeExecServerLease>;
  };
};

/** One canonical loopback/refcount owner with either local or node connection handling. */
export type OpenClawLeasedExecServer = OpenClawExecServer | OpenClawNodeExecServer;
