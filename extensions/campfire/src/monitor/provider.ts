import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import {
  resolveCommandAuthorizedFromAuthorizers,
  shouldComputeCommandAuthorized,
} from "openclaw/plugin-sdk/command-auth";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveCampfireAccount } from "../config.js";
import { registerCampfireWebhookRoute, type CampfireInboundHandler } from "../http/index.js";
import { getCampfireRuntime } from "../runtime.js";
import { sendCampfireText } from "../send.js";
import type { ResolvedCampfireAccount } from "../types.js";
import { buildCampfireInboundContext } from "./context.js";

function waitUntilAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function resolveCampfireCommandAuthorized(params: {
  cfg: OpenClawConfig;
  rawBody: string;
  allowFrom: string[];
  senderId: string;
}): boolean | undefined {
  const shouldComputeAuth = shouldComputeCommandAuthorized(params.rawBody, params.cfg);
  if (!shouldComputeAuth) {
    return undefined;
  }

  const allowFrom = params.allowFrom.map((entry) => entry.trim()).filter(Boolean);
  const senderAllowedForCommands = allowFrom.includes("*") || allowFrom.includes(params.senderId);

  return resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups: params.cfg.commands?.useAccessGroups !== false,
    authorizers: [
      {
        configured: allowFrom.length > 0,
        allowed: senderAllowedForCommands,
      },
    ],
  });
}

function resolveCampfireBotUserId(botKey: string): string | null {
  const normalized = botKey.trim();
  if (!normalized) {
    return null;
  }
  const [prefix] = normalized.split("-", 1);
  const botUserId = prefix?.trim();
  return botUserId ? botUserId : null;
}

function isCampfireSelfAuthoredInbound(params: { senderId: string; botKey: string }): boolean {
  const botUserId = resolveCampfireBotUserId(params.botKey);
  return Boolean(botUserId && params.senderId === botUserId);
}

type CampfireGatewayContext = {
  cfg: OpenClawConfig;
  accountId: string;
  account: ResolvedCampfireAccount;
  abortSignal: AbortSignal;
  runtime?: unknown;
  getStatus?: () => ChannelAccountSnapshot;
  setStatus?: (next: ChannelAccountSnapshot) => void;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
  channelRuntime?: unknown;
};

type CampfireGatewayAdapter = {
  startAccount: (ctx: CampfireGatewayContext) => Promise<void>;
};

type CampfireConfigLoader = () => OpenClawConfig | Promise<OpenClawConfig>;

type CampfireReplyRuntime = {
  finalizeInboundContext: (ctx: Record<string, unknown>) => Record<string, unknown>;
  dispatchReplyWithBufferedBlockDispatcher: (params: {
    ctx: Record<string, unknown>;
    cfg: OpenClawConfig;
    dispatcherOptions: {
      deliver: (replyPayload: { text?: string; body?: string }) => Promise<void>;
      onError?: (err: unknown, info: { kind: string }) => void;
    };
  }) => Promise<unknown>;
};

function resolveCampfireReplyRuntime(channelRuntime: unknown): CampfireReplyRuntime | null {
  if (!channelRuntime || typeof channelRuntime !== "object") {
    return null;
  }
  const reply = (channelRuntime as { reply?: unknown }).reply;
  if (!reply || typeof reply !== "object") {
    return null;
  }

  const replyRecord = reply as Record<string, unknown>;
  if (
    typeof replyRecord.finalizeInboundContext !== "function" ||
    typeof replyRecord.dispatchReplyWithBufferedBlockDispatcher !== "function"
  ) {
    return null;
  }

  return reply as CampfireReplyRuntime;
}

async function resolveCampfireInboundConfig(params: {
  fallback: OpenClawConfig;
  loadConfigOverride?: CampfireConfigLoader;
  log?: {
    warn?: (message: string) => void;
  };
}): Promise<{ cfg: OpenClawConfig; usedFallback: boolean }> {
  const loadConfig =
    params.loadConfigOverride ??
    (() => {
      return getCampfireRuntime().config.loadConfig();
    });

  try {
    return {
      cfg: await Promise.resolve(loadConfig()),
      usedFallback: false,
    };
  } catch (err) {
    params.log?.warn?.(`campfire: failed to reload config for inbound webhook: ${String(err)}`);
    return {
      cfg: params.fallback,
      usedFallback: true,
    };
  }
}

export function createCampfireGateway(params?: {
  registerRoute?: typeof registerCampfireWebhookRoute;
  sendText?: typeof sendCampfireText;
  loadConfig?: CampfireConfigLoader;
}): CampfireGatewayAdapter {
  const registerRoute = params?.registerRoute ?? registerCampfireWebhookRoute;
  const sendText = params?.sendText ?? sendCampfireText;
  const loadConfig = params?.loadConfig;

  return {
    startAccount: async (ctx) => {
      if (!ctx.account.enabled || !ctx.account.configured) {
        await waitUntilAbort(ctx.abortSignal);
        return;
      }
      const replyRuntime = resolveCampfireReplyRuntime(ctx.channelRuntime);
      if (!replyRuntime) {
        ctx.log?.warn?.(
          `[${ctx.account.accountId}] campfire channelRuntime is unavailable; inbound disabled`,
        );
        await waitUntilAbort(ctx.abortSignal);
        return;
      }

      const onInbound: CampfireInboundHandler = async (payload) => {
        if (ctx.abortSignal.aborted) {
          return;
        }

        const resolvedInboundConfig = await resolveCampfireInboundConfig({
          fallback: ctx.cfg,
          loadConfigOverride: loadConfig,
          log: ctx.log,
        });
        const currentCfg = resolvedInboundConfig.cfg;
        const resolvedCurrentAccount = resolveCampfireAccount(currentCfg, ctx.account.accountId);
        const currentAccount =
          resolvedInboundConfig.usedFallback &&
          !resolvedCurrentAccount.configured &&
          ctx.account.configured
            ? ctx.account
            : resolvedCurrentAccount;
        if (!currentAccount.enabled || !currentAccount.configured) {
          return;
        }

        const inbound = buildCampfireInboundContext({
          payload,
          allowFrom: currentAccount.allowFrom,
          baseUrl: currentAccount.baseUrl,
        });
        if (
          isCampfireSelfAuthoredInbound({
            senderId: inbound.sender.id,
            botKey: currentAccount.botKey,
          })
        ) {
          return;
        }
        if (!inbound.isAllowed) {
          return;
        }

        const route = resolveAgentRoute({
          cfg: currentCfg,
          channel: "campfire",
          accountId: currentAccount.accountId,
          peer: {
            kind: "group",
            id: inbound.roomId,
          },
        });

        const commandAuthorized = resolveCampfireCommandAuthorized({
          cfg: currentCfg,
          rawBody: inbound.text,
          allowFrom: currentAccount.allowFrom,
          senderId: inbound.sender.id,
        });

        const msgCtx = replyRuntime.finalizeInboundContext({
          Body: inbound.text,
          BodyForAgent: inbound.text,
          RawBody: inbound.text,
          CommandBody: inbound.text,
          From: `campfire:${inbound.sender.id}`,
          To: `campfire:room:${inbound.roomId}`,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: "group",
          ConversationLabel: inbound.roomName,
          SenderId: inbound.sender.id,
          SenderName: inbound.sender.name,
          Provider: "campfire",
          Surface: "campfire",
          OriginatingChannel: "campfire",
          OriginatingTo: `campfire:room:${inbound.roomId}`,
          MessageSid: inbound.messageId,
          MessageSidFull: inbound.messageId,
          GroupSpace: inbound.roomName,
          Timestamp: Date.now(),
          CommandAuthorized: commandAuthorized,
        });

        await replyRuntime.dispatchReplyWithBufferedBlockDispatcher({
          ctx: msgCtx,
          cfg: currentCfg,
          dispatcherOptions: {
            deliver: async (replyPayload: { text?: string; body?: string }) => {
              const text =
                typeof replyPayload.text === "string"
                  ? replyPayload.text
                  : typeof replyPayload.body === "string"
                    ? replyPayload.body
                    : "";
              if (!text) {
                return;
              }
              await sendText(
                inbound.replyUrl,
                text,
                currentAccount.botKey,
                currentAccount.textChunkLimit,
              );
            },
            onError: (err: unknown, info: { kind: string }) => {
              ctx.log?.error?.(
                `[${currentAccount.accountId}] campfire ${info.kind} reply failed: ${String(err)}`,
              );
            },
          },
        });
      };

      const unregister = registerRoute({
        accountId: ctx.account.accountId,
        path: ctx.account.webhookPath,
        webhookSecret: ctx.account.webhookSecret,
        onInbound,
        log: ctx.log,
      });

      try {
        await waitUntilAbort(ctx.abortSignal);
      } finally {
        unregister();
      }
    },
  };
}

export const campfireGateway = createCampfireGateway();
