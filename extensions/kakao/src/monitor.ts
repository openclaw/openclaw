import type { IncomingMessage, ServerResponse } from "node:http";

import type { MoltbotConfig, MarkdownTableMode } from "clawdbot/plugin-sdk";

import type { ResolvedKakaoAccount } from "./accounts.js";
import {
  sendMessage,
  getUserInfo,
  type KakaoFetch,
  type KakaoReactiveEvent,
} from "./api.js";
import { resolveKakaoProxyFetch } from "./proxy.js";
import { getKakaoRuntime } from "./runtime.js";

export type KakaoRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type KakaoMonitorOptions = {
  appKey: string;
  account: ResolvedKakaoAccount;
  config: MoltbotConfig;
  runtime: KakaoRuntimeEnv;
  abortSignal: AbortSignal;
  callbackUrl?: string;
  callbackPath?: string;
  fetcher?: KakaoFetch;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type KakaoMonitorResult = {
  stop: () => void;
};

const KAKAO_TEXT_LIMIT = 4000;
const DEFAULT_MEDIA_MAX_MB = 5;

type KakaoCoreRuntime = ReturnType<typeof getKakaoRuntime>;

function logVerbose(core: KakaoCoreRuntime, runtime: KakaoRuntimeEnv, message: string): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[kakao] ${message}`);
  }
}

function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) return true;
  const normalizedSenderId = senderId.toLowerCase();
  return allowFrom.some((entry) => {
    const normalized = entry.toLowerCase().replace(/^(kakao|kw):/i, "");
    return normalized === normalizedSenderId;
  });
}

async function readJsonBody(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({ ok: false, error: "empty payload" });
          return;
        }
        resolve({ ok: true, value: JSON.parse(raw) as unknown });
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

type CallbackTarget = {
  appKey: string;
  account: ResolvedKakaoAccount;
  config: MoltbotConfig;
  runtime: KakaoRuntimeEnv;
  core: KakaoCoreRuntime;
  path: string;
  mediaMaxMb: number;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  fetcher?: KakaoFetch;
};

const callbackTargets = new Map<string, CallbackTarget[]>();

function normalizeCallbackPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

function resolveCallbackPath(callbackPath?: string, callbackUrl?: string): string | null {
  const trimmedPath = callbackPath?.trim();
  if (trimmedPath) return normalizeCallbackPath(trimmedPath);
  if (callbackUrl?.trim()) {
    try {
      const parsed = new URL(callbackUrl);
      return normalizeCallbackPath(parsed.pathname || "/");
    } catch {
      return null;
    }
  }
  return null;
}

export function registerKakaoCallbackTarget(target: CallbackTarget): () => void {
  const key = normalizeCallbackPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = callbackTargets.get(key) ?? [];
  const next = [...existing, normalizedTarget];
  callbackTargets.set(key, next);
  return () => {
    const updated = (callbackTargets.get(key) ?? []).filter(
      (entry) => entry !== normalizedTarget,
    );
    if (updated.length > 0) {
      callbackTargets.set(key, updated);
    } else {
      callbackTargets.delete(key);
    }
  };
}

export async function handleKakaoCallbackRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = normalizeCallbackPath(url.pathname);
  const targets = callbackTargets.get(path);
  if (!targets || targets.length === 0) return false;

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  const target = targets[0];
  if (!target) {
    res.statusCode = 500;
    res.end("no target configured");
    return true;
  }

  const body = await readJsonBody(req, 1024 * 1024);
  if (!body.ok) {
    res.statusCode = body.error === "payload too large" ? 413 : 400;
    res.end(body.error ?? "invalid payload");
    return true;
  }

  const raw = body.value;
  const event =
    raw && typeof raw === "object" ? (raw as KakaoReactiveEvent) : null;

  if (!event?.type) {
    res.statusCode = 400;
    res.end("invalid payload");
    return true;
  }

  target.statusSink?.({ lastInboundAt: Date.now() });
  processReactiveEvent(
    event,
    target.appKey,
    target.account,
    target.config,
    target.runtime,
    target.core,
    target.mediaMaxMb,
    target.statusSink,
    target.fetcher,
  ).catch((err) => {
    target.runtime.error?.(`[${target.account.accountId}] KakaoWork callback failed: ${String(err)}`);
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ success: true }));
  return true;
}

async function processReactiveEvent(
  event: KakaoReactiveEvent,
  appKey: string,
  account: ResolvedKakaoAccount,
  config: MoltbotConfig,
  runtime: KakaoRuntimeEnv,
  core: KakaoCoreRuntime,
  _mediaMaxMb: number,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
  fetcher?: KakaoFetch,
): Promise<void> {
  const { type, message, react_user_id, value } = event;

  if (!message || !react_user_id) return;

  switch (type) {
    case "submit_action":
      await handleSubmitAction(
        event,
        appKey,
        account,
        config,
        runtime,
        core,
        statusSink,
        fetcher,
      );
      break;
    case "request_modal":
    case "submission":
      logVerbose(core, runtime, `Received ${type} event from user ${react_user_id}`);
      break;
  }
}

async function handleSubmitAction(
  event: KakaoReactiveEvent,
  appKey: string,
  account: ResolvedKakaoAccount,
  config: MoltbotConfig,
  runtime: KakaoRuntimeEnv,
  core: KakaoCoreRuntime,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
  fetcher?: KakaoFetch,
): Promise<void> {
  const { message, react_user_id, action_name, value } = event;
  if (!message) return;

  const conversationId = message.conversation_id;
  const senderId = String(react_user_id);
  const chatId = String(conversationId);

  let senderName: string | undefined;
  try {
    const userResponse = await getUserInfo(appKey, react_user_id, fetcher);
    if (userResponse.success && userResponse.user) {
      senderName = userResponse.user.name;
    }
  } catch {
    // ignore user lookup errors
  }

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));
  const rawBody = value?.trim() || action_name || "";
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(
    rawBody,
    config,
  );
  const storeAllowFrom =
    dmPolicy !== "open" || shouldComputeAuth
      ? await core.channel.pairing.readAllowFromStore("kakao").catch(() => [])
      : [];
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = isSenderAllowed(senderId, effectiveAllowFrom);
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [{ configured: effectiveAllowFrom.length > 0, allowed: senderAllowedForCommands }],
      })
    : undefined;

  if (dmPolicy === "disabled") {
    logVerbose(core, runtime, `Blocked kakao DM from ${senderId} (dmPolicy=disabled)`);
    return;
  }

  if (dmPolicy !== "open") {
    const allowed = senderAllowedForCommands;

    if (!allowed) {
      if (dmPolicy === "pairing") {
        const { code, created } = await core.channel.pairing.upsertPairingRequest({
          channel: "kakao",
          id: senderId,
          meta: { name: senderName ?? undefined },
        });

        if (created) {
          logVerbose(core, runtime, `kakao pairing request sender=${senderId}`);
          try {
            await sendMessage(
              appKey,
              {
                conversation_id: conversationId,
                text: core.channel.pairing.buildPairingReply({
                  channel: "kakao",
                  idLine: `Your KakaoWork user id: ${senderId}`,
                  code,
                }),
              },
              fetcher,
            );
            statusSink?.({ lastOutboundAt: Date.now() });
          } catch (err) {
            logVerbose(
              core,
              runtime,
              `kakao pairing reply failed for ${senderId}: ${String(err)}`,
            );
          }
        }
      } else {
        logVerbose(
          core,
          runtime,
          `Blocked unauthorized kakao sender ${senderId} (dmPolicy=${dmPolicy})`,
        );
      }
      return;
    }
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "kakao",
    accountId: account.accountId,
    peer: {
      kind: "dm",
      id: chatId,
    },
  });

  const fromLabel = senderName || `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "KakaoWork",
    from: fromLabel,
    timestamp: event.action_time ? new Date(event.action_time).getTime() : undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `kakao:${senderId}`,
    To: `kakao:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    CommandAuthorized: commandAuthorized,
    Provider: "kakao",
    Surface: "kakaowork",
    MessageSid: message.id,
    OriginatingChannel: "kakao",
    OriginatingTo: `kakao:${chatId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`kakao: failed updating session meta: ${String(err)}`);
    },
  });

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: config,
    channel: "kakao",
    accountId: account.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload) => {
        await deliverKakaoReply({
          payload,
          appKey,
          conversationId,
          runtime,
          core,
          config,
          accountId: account.accountId,
          statusSink,
          fetcher,
          tableMode,
        });
      },
      onError: (err, info) => {
        runtime.error?.(`[${account.accountId}] KakaoWork ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}

async function deliverKakaoReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  appKey: string;
  conversationId: number;
  runtime: KakaoRuntimeEnv;
  core: KakaoCoreRuntime;
  config: MoltbotConfig;
  accountId?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  fetcher?: KakaoFetch;
  tableMode?: MarkdownTableMode;
}): Promise<void> {
  const { payload, appKey, conversationId, runtime, core, config, accountId, statusSink, fetcher } =
    params;
  const tableMode = params.tableMode ?? "code";
  const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);

  if (text) {
    const chunkMode = core.channel.text.resolveChunkMode(config, "kakao", accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(
      text,
      KAKAO_TEXT_LIMIT,
      chunkMode,
    );
    for (const chunk of chunks) {
      try {
        await sendMessage(appKey, { conversation_id: conversationId, text: chunk }, fetcher);
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`KakaoWork message send failed: ${String(err)}`);
      }
    }
  }
}

export async function monitorKakaoProvider(
  options: KakaoMonitorOptions,
): Promise<KakaoMonitorResult> {
  const {
    appKey,
    account,
    config,
    runtime,
    abortSignal,
    callbackUrl,
    callbackPath,
    statusSink,
    fetcher: fetcherOverride,
  } = options;

  const core = getKakaoRuntime();
  const effectiveMediaMaxMb = account.config.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
  const fetcher = fetcherOverride ?? resolveKakaoProxyFetch(account.config.proxy);

  let stopped = false;
  const stopHandlers: Array<() => void> = [];

  const stop = () => {
    stopped = true;
    for (const handler of stopHandlers) {
      handler();
    }
  };

  const path = resolveCallbackPath(callbackPath, callbackUrl);
  if (!path) {
    runtime.log?.(`[${account.accountId}] KakaoWork running without callback (reactive events disabled)`);
    return { stop };
  }

  if (callbackUrl && !callbackUrl.startsWith("https://")) {
    runtime.error?.(`[${account.accountId}] KakaoWork callback URL should use HTTPS`);
  }

  const unregister = registerKakaoCallbackTarget({
    appKey,
    account,
    config,
    runtime,
    core,
    path,
    statusSink: (patch) => statusSink?.(patch),
    mediaMaxMb: effectiveMediaMaxMb,
    fetcher,
  });
  stopHandlers.push(unregister);

  return { stop };
}
