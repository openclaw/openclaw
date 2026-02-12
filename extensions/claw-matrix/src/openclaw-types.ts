/**
 * Type definitions for OpenClaw plugin SDK interfaces used by claw-matrix.
 *
 * These mirror the upstream PluginRuntime and related types without importing
 * from OpenClaw directly (the plugin is loaded via jiti and cannot resolve
 * workspace imports at type-check time).
 */

// ── Logger ────────────────────────────────────────────────────────────

export interface PluginLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

// ── OpenClaw Config ───────────────────────────────────────────────────

/** Minimal shape of the OpenClaw config object as seen by channel plugins. */
export interface OpenClawConfig {
  channels?: {
    matrix?: Record<string, unknown>;
    [channel: string]: unknown;
  };
  [key: string]: unknown;
}

// ── Agent Route ───────────────────────────────────────────────────────

export interface AgentRoute {
  agentId: string;
  sessionKey: string;
  mainSessionKey?: string;
  matchedBy?: string;
}

// ── Agent Tool Result ─────────────────────────────────────────────────

export interface AgentToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}

// ── Saved Media ───────────────────────────────────────────────────────

export interface SavedMedia {
  id?: string;
  path?: string;
  size?: number;
  contentType?: string;
}

// ── Plugin Runtime ────────────────────────────────────────────────────

/**
 * The `PluginRuntime` object provided by OpenClaw via `api.runtime`.
 * Only the namespaces actually used by claw-matrix are typed here.
 */
export interface PluginRuntime {
  channel: {
    routing: {
      resolveAgentRoute(params: {
        cfg: OpenClawConfig;
        channel: string;
        accountId: string;
        peer: { kind: "direct" | "group"; id: string };
      }): AgentRoute | null;
    };

    reply: {
      finalizeInboundContext(ctx: Record<string, unknown>): Record<string, unknown>;
      dispatchReplyWithBufferedBlockDispatcher(params: {
        ctx: Record<string, unknown>;
        cfg: OpenClawConfig;
        dispatcherOptions: {
          deliver: (payload: { text?: string; [key: string]: unknown }) => Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
        };
        replyOptions?: Record<string, unknown>;
      }): Promise<void>;
    };

    session: {
      resolveStorePath(store?: string, opts?: { agentId?: string }): string;
      recordInboundSession(params: {
        storePath: string;
        sessionKey: string;
        ctx: Record<string, unknown>;
        groupResolution?: { key: string; channel?: string; id?: string; chatType?: string } | null;
        createIfMissing?: boolean;
        updateLastRoute?: {
          sessionKey: string;
          channel: string;
          to: string;
          accountId?: string;
          threadId?: string | number;
        };
        onRecordError: (err: unknown) => void;
      }): Promise<void>;
    };

    media?: {
      saveMediaBuffer?(
        buffer: Buffer,
        contentType?: string,
        subdir?: string,
        maxBytes?: number,
        originalFilename?: string,
      ): Promise<SavedMedia>;
    };
  };
}

// ── Plugin API ────────────────────────────────────────────────────────

/** The `api` object passed to `plugin.register()`. */
export interface OpenClawPluginApi {
  runtime: PluginRuntime;
  logger?: PluginLogger;
  config?: OpenClawConfig;
  registerChannel(opts: { plugin: unknown }): void;
}

// ── Gateway Status ────────────────────────────────────────────────────

export interface GatewayStatus {
  running?: boolean;
  connected?: boolean;
  lastStartAt?: number;
  lastEventAt?: number;
  lastError?: string;
  reconnectAttempts?: number;
}
