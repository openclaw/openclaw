/**
 * Matrix ChannelPlugin implementation for OpenClaw.
 *
 * This is the integration contract between Matrix and OpenClaw.
 * Every adapter tells OpenClaw how to interact with the Matrix channel.
 */

import type { OpenClawConfig, PluginLogger, GatewayStatus } from "./openclaw-types.js";
import { resolveMatrixAccount, type ResolvedMatrixAccount } from "./config.js";
import { getHealthMetrics } from "./health.js";

// Guard against config hot-reload racing: track whether an account is already running.
let _runningAccountPromise: Promise<void> | null = null;

export const matrixChannelPlugin = {
  id: "matrix" as const,

  // ═══════════════════════════════════════════════
  // META — channel identity
  // ═══════════════════════════════════════════════
  meta: {
    id: "matrix",
    label: "Matrix",
    selectionLabel: "Matrix",
    docsPath: "channels/matrix",
    blurb: "Matrix with E2E encryption",
    order: 100,
  },

  // ═══════════════════════════════════════════════
  // CAPABILITIES — what this channel supports
  // ═══════════════════════════════════════════════
  capabilities: {
    chatTypes: ["dm", "group"] as string[],
    reactions: true,
    edit: true,
    unsend: true,
    reply: true,
    polls: false,
    effects: false,
    groupManagement: false,
    threads: false,
    media: true,
    typing: true,
    nativeCommands: false,
    blockStreaming: true,
  },

  // ═══════════════════════════════════════════════
  // CONFIG — how OpenClaw reads our config
  // ═══════════════════════════════════════════════
  config: {
    listAccountIds(cfg: OpenClawConfig): string[] {
      const matrixCfg = cfg?.channels?.matrix;
      if (!matrixCfg) return [];
      let ids: string[];
      if (matrixCfg.accounts && typeof matrixCfg.accounts === "object") {
        ids = Object.keys(matrixCfg.accounts);
      } else {
        ids = matrixCfg.userId ? ["default"] : [];
      }
      // Single-account limitation: multi-account support deferred to Phase 3.
      // OlmMachine, sync loop, and room state caches are global singletons —
      // running multiple accounts requires per-account isolation.
      if (ids.length > 1) {
        console.warn(
          `[claw-matrix] Multiple accounts configured (${ids.length}) but only one is supported. Using "${ids[0]}".`,
        );
        return ids.slice(0, 1);
      }
      return ids;
    },

    resolveAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedMatrixAccount {
      return resolveMatrixAccount(cfg, accountId);
    },

    isEnabled(account: ResolvedMatrixAccount): boolean {
      return account.enabled;
    },

    isConfigured(account: ResolvedMatrixAccount): boolean {
      return !!(account.homeserver && account.userId && account.accessToken);
    },

    disabledReason(): string {
      return "Matrix channel is disabled in config";
    },

    unconfiguredReason(account: ResolvedMatrixAccount): string {
      if (!account.homeserver) return "Missing homeserver URL";
      if (!account.userId) return "Missing userId";
      if (!account.accessToken) return "Missing accessToken";
      return "Matrix not configured";
    },

    resolveAllowFrom(params: {
      cfg: OpenClawConfig;
      accountId?: string | null;
    }): string[] | undefined {
      const matrixCfg = params.cfg?.channels?.matrix as Record<string, unknown> | undefined;
      const dm = matrixCfg?.dm as { allowFrom?: string[] } | undefined;
      return dm?.allowFrom;
    },
  },

  // ═══════════════════════════════════════════════════
  // GATEWAY — lifecycle (start/stop sync loop)
  //
  // OpenClaw calls startAccount() when the gateway starts.
  // ctx.abortSignal is used for shutdown — NOT process.on("SIGTERM").
  // ═══════════════════════════════════════════════════
  gateway: {
    async startAccount(ctx: {
      cfg: OpenClawConfig;
      accountId: string;
      account: ResolvedMatrixAccount;
      abortSignal: AbortSignal;
      log?: PluginLogger;
      getStatus: () => GatewayStatus;
      setStatus: (next: GatewayStatus) => void;
    }): Promise<void> {
      // Config hot-reload safety: reject if an account is already running.
      // OpenClaw must stopAccount() (abort) before starting a new one.
      if (_runningAccountPromise) {
        throw new Error(
          `[claw-matrix] Cannot start account "${ctx.accountId}": another account is already running. ` +
            `Call stopAccount() first to trigger shutdown via abortSignal.`,
        );
      }

      const { monitorMatrixProvider } = await import("./monitor.js");
      _runningAccountPromise = monitorMatrixProvider({
        config: ctx.cfg,
        account: ctx.account,
        accountId: ctx.accountId,
        abortSignal: ctx.abortSignal,
        log: ctx.log,
        getStatus: ctx.getStatus,
        setStatus: ctx.setStatus,
      }).finally(() => {
        _runningAccountPromise = null;
      });
      return _runningAccountPromise;
    },

    async stopAccount(): Promise<void> {
      // abortSignal handles cleanup
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // OUTBOUND — how OpenClaw sends messages THROUGH Matrix
  //
  // When an agent replies, OpenClaw calls outbound.sendText().
  // The `to` parameter is a Matrix room ID (e.g., "!abc123:example.com").
  // ═══════════════════════════════════════════════════════════════
  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 4096,

    resolveTarget(params: {
      to?: string;
      [key: string]: unknown;
    }): { ok: true; to: string } | { ok: false; error: Error } {
      let to = params.to?.trim();
      if (!to) return { ok: false, error: new Error("Missing target room ID") };
      // Strip channel/type prefixes the agent may include
      if (to.toLowerCase().startsWith("matrix:")) {
        to = to.slice("matrix:".length).trim();
      }
      to = to.replace(/^(room|channel|user):/i, "").trim();
      if (to.startsWith("!") || to.startsWith("@") || to.startsWith("#")) {
        return { ok: true, to };
      }
      return {
        ok: false,
        error: new Error(`Invalid Matrix target: ${to}`),
      };
    },

    async sendText(ctx: {
      cfg: OpenClawConfig;
      to: string;
      text: string;
      accountId?: string | null;
      replyToId?: string | null;
      [key: string]: unknown;
    }): Promise<{
      channel: string;
      messageId: string;
      roomId?: string;
    }> {
      const { resolveMatrixTarget } = await import("./client/targets.js");
      const { sendMatrixMessage } = await import("./client/send.js");
      const account = resolveMatrixAccount(ctx.cfg, ctx.accountId);
      const roomId = await resolveMatrixTarget(ctx.to, account.userId);
      const result = await sendMatrixMessage({
        roomId,
        text: ctx.text,
        replyToId: ctx.replyToId ?? undefined,
      });
      return {
        channel: "matrix",
        messageId: result.eventId,
        roomId,
      };
    },

    async sendPayload(ctx: {
      cfg: OpenClawConfig;
      to: string;
      text: string;
      payload?: { text?: string };
      accountId?: string | null;
      replyToId?: string | null;
      [key: string]: unknown;
    }): Promise<{
      channel: string;
      messageId: string;
      roomId?: string;
    }> {
      const text = ctx.payload?.text ?? ctx.text;
      const { resolveMatrixTarget } = await import("./client/targets.js");
      const { sendMatrixMessage } = await import("./client/send.js");
      const account = resolveMatrixAccount(ctx.cfg, ctx.accountId);
      const roomId = await resolveMatrixTarget(ctx.to, account.userId);
      const result = await sendMatrixMessage({
        roomId,
        text,
        replyToId: ctx.replyToId ?? undefined,
      });
      return {
        channel: "matrix",
        messageId: result.eventId,
        roomId,
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // OUTBOUND MEDIA — how OpenClaw sends media THROUGH Matrix
  // ═══════════════════════════════════════════════════════════════
  outboundMedia: {
    async sendMedia(ctx: {
      cfg: OpenClawConfig;
      to: string;
      buffer: Buffer;
      mimeType: string;
      filename: string;
      caption?: string;
      accountId?: string | null;
      replyToId?: string | null;
    }): Promise<{
      channel: string;
      messageId: string;
      roomId?: string;
    }> {
      const { resolveMatrixTarget } = await import("./client/targets.js");
      const { sendMedia } = await import("./client/send.js");
      const account = resolveMatrixAccount(ctx.cfg, ctx.accountId);
      const roomId = await resolveMatrixTarget(ctx.to, account.userId);
      const result = await sendMedia({
        roomId,
        buffer: ctx.buffer,
        mimeType: ctx.mimeType,
        filename: ctx.filename,
        caption: ctx.caption,
        replyToId: ctx.replyToId ?? undefined,
      });
      return {
        channel: "matrix",
        messageId: result.eventId,
        roomId,
      };
    },
  },

  // ═══════════════════════════════════════════════
  // SECURITY — DM policy and access control
  // ═══════════════════════════════════════════════
  security: {
    resolveDmPolicy(ctx: { account: ResolvedMatrixAccount; [key: string]: unknown }) {
      return {
        policy: ctx.account.dm.policy,
        allowFrom: ctx.account.dm.allowFrom,
        allowFromPath: "channels.matrix.dm.allowFrom",
        approveHint: "Add their Matrix user ID to channels.matrix.dm.allowFrom",
      };
    },
  },

  // ═══════════════════════════════════════════════
  // GROUPS — mention gating for group rooms
  // ═══════════════════════════════════════════════
  groups: {
    resolveRequireMention(params: {
      cfg: OpenClawConfig;
      groupId?: string | null;
    }): boolean | undefined {
      const matrixCfg = params.cfg?.channels?.matrix as Record<string, unknown> | undefined;
      const groups = matrixCfg?.groups as Record<string, { requireMention?: boolean }> | undefined;
      const groupId = params.groupId;
      if (groupId && groups?.[groupId]) {
        return groups[groupId].requireMention;
      }
      return undefined;
    },
  },

  // ═══════════════════════════════════════════════
  // ACTIONS — message tool handlers
  // ═══════════════════════════════════════════════
  actions: {
    supportsAction(params: { action: string }): boolean {
      return [
        "send",
        "read",
        "channel-list",
        "react",
        "reactions",
        "unreact",
        "edit",
        "delete",
        "unsend",
        "invite",
        "join",
        "leave",
        "kick",
        "ban",
      ].includes(params.action);
    },

    async handleAction(ctx: {
      action: string;
      params: Record<string, unknown>;
      cfg: OpenClawConfig;
      accountId?: string | null;
    }): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
      const { handleMatrixAction } = await import("./actions.js");
      return handleMatrixAction(ctx);
    },
  },

  // ═══════════════════════════════════════════════
  // STATUS — health reporting
  // ═══════════════════════════════════════════════
  status: {
    buildAccountSnapshot(params: {
      account: ResolvedMatrixAccount;
      runtime?: Record<string, unknown>;
      [key: string]: unknown;
    }) {
      const { account } = params;
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        configured: !!(account.homeserver && account.userId && account.accessToken),
        dmPolicy: account.dm.policy,
        allowFrom: account.dm.allowFrom,
        health: getHealthMetrics(),
        ...params.runtime,
      };
    },
  },

  // ═══════════════════════════════════════════════
  // MESSAGING — target normalization
  // ═══════════════════════════════════════════════
  messaging: {
    normalizeTarget(raw: string): string | undefined {
      let normalized = raw.trim();
      if (!normalized) return undefined;
      if (normalized.toLowerCase().startsWith("matrix:")) {
        normalized = normalized.slice("matrix:".length).trim();
      }
      normalized = normalized.replace(/^(room|channel|user):/i, "").trim();
      return normalized || undefined;
    },
    targetResolver: {
      looksLikeId: (raw: string): boolean => {
        const trimmed = raw.trim();
        if (!trimmed) return false;
        if (/^(matrix:)?[!#@]/i.test(trimmed)) return true;
        return trimmed.includes(":");
      },
      hint: "<room|alias|user>",
    },
  },
};
