import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { createReplyPrefixOptions } from "openclaw/plugin-sdk";
import type { ResolvedKakaoAccount } from "./accounts.js";
import { getKakaoRuntime } from "./runtime.js";

export type KakaoRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type KakaoMonitorOptions = {
  account: ResolvedKakaoAccount;
  config: OpenClawConfig;
  runtime: KakaoRuntimeEnv;
  abortSignal: AbortSignal;
  webhookPath?: string;
  webhookUrl?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

type KakaoBot = {
  id?: string;
  name?: string;
};

type KakaoUser = {
  id?: string;
  type?: string;
  properties?: Record<string, unknown>;
};

type KakaoUserRequest = {
  utterance?: string;
  user?: KakaoUser;
  params?: Record<string, unknown>;
  callbackUrl?: string;
  lang?: string;
  timezone?: string;
  block?: { id?: string; name?: string };
};

type KakaoRequest = {
  bot?: KakaoBot;
  userRequest?: KakaoUserRequest;
  intent?: { id?: string; name?: string };
  action?: { id?: string; name?: string };
};

type KakaoResponse = {
  version: "2.0";
  useCallback?: boolean;
  template: {
    outputs: Array<{ simpleText: { text: string } }>;
  };
  data?: { text?: string };
};

type KakaoCoreRuntime = ReturnType<typeof getKakaoRuntime>;

type WebhookTarget = {
  account: ResolvedKakaoAccount;
  config: OpenClawConfig;
  runtime: KakaoRuntimeEnv;
  core: KakaoCoreRuntime;
  path: string;
  botId?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

const webhookTargets = new Map<string, WebhookTarget[]>();

function logVerbose(core: KakaoCoreRuntime, runtime: KakaoRuntimeEnv, message: string): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[kakao] ${message}`);
  }
}

function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "/";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

function resolveWebhookPath(webhookPath?: string, webhookUrl?: string): string | null {
  const trimmedPath = webhookPath?.trim();
  if (trimmedPath) {
    return normalizeWebhookPath(trimmedPath);
  }
  if (webhookUrl?.trim()) {
    try {
      const parsed = new URL(webhookUrl);
      return normalizeWebhookPath(parsed.pathname || "/");
    } catch {
      return null;
    }
  }
  return "/kakao/webhook";
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

function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSenderId = senderId.toLowerCase();
  return allowFrom.some((entry) => {
    const normalized = entry.toLowerCase().replace(/^(kakao|kakaotalk):/i, "");
    return normalized === normalizedSenderId;
  });
}

function resolveSenderId(request: KakaoUserRequest): string | null {
  const userId = request.user?.id?.trim();
  if (userId) {
    return userId;
  }
  const props = request.user?.properties ?? {};
  const botUserKey = typeof props.botUserKey === "string" ? props.botUserKey : undefined;
  if (botUserKey?.trim()) {
    return botUserKey.trim();
  }
  const legacyBotUserKey =
    typeof props.bot_user_key === "string" ? props.bot_user_key : undefined;
  if (legacyBotUserKey?.trim()) {
    return legacyBotUserKey.trim();
  }
  return null;
}

function buildKakaoResponse(text: string): KakaoResponse {
  return {
    version: "2.0",
    template: {
      outputs: [
        {
          simpleText: {
            text,
          },
        },
      ],
    },
  };
}

async function sendKakaoCallbackResponse(
  url: string,
  payload: KakaoResponse,
  runtime: KakaoRuntimeEnv,
): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      runtime.error?.(
        `[kakao] callback response failed (${res.status})${body ? `: ${body}` : ""}`,
      );
    }
  } catch (err) {
    runtime.error?.(`[kakao] callback response error: ${String(err)}`);
  }
}

function pickTarget(targets: WebhookTarget[], botId?: string): WebhookTarget | null {
  if (targets.length === 0) {
    return null;
  }
  if (botId) {
    const match = targets.find((entry) => entry.botId && entry.botId === botId);
    if (match) {
      return match;
    }
  }
  if (targets.length === 1) {
    return targets[0];
  }
  return null;
}

export function registerKakaoWebhookTarget(target: WebhookTarget): () => void {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  const next = [...existing, normalizedTarget];
  webhookTargets.set(key, next);
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) {
      webhookTargets.set(key, updated);
    } else {
      webhookTargets.delete(key);
    }
  };
}

async function processKakaoRequest(params: {
  request: KakaoRequest;
  target: WebhookTarget;
}): Promise<string | null> {
  const { request, target } = params;
  const userRequest = request.userRequest;
  if (!userRequest) {
    return null;
  }

  const rawBody = userRequest.utterance?.trim() || "";
  if (!rawBody) {
    return null;
  }

  const senderId = resolveSenderId(userRequest) ?? "unknown";
  const dmPolicy = target.account.config.dmPolicy ?? "pairing";
  const configAllowFrom = (target.account.config.allowFrom ?? []).map((v) => String(v));
  const shouldComputeAuth = target.core.channel.commands.shouldComputeCommandAuthorized(
    rawBody,
    target.config,
  );
  const storeAllowFrom =
    dmPolicy !== "open" || shouldComputeAuth
      ? await target.core.channel.pairing.readAllowFromStore("kakao").catch(() => [])
      : [];
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
  const useAccessGroups = target.config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = isSenderAllowed(senderId, effectiveAllowFrom);
  const commandAuthorized = shouldComputeAuth
    ? target.core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [
          { configured: effectiveAllowFrom.length > 0, allowed: senderAllowedForCommands },
        ],
      })
    : undefined;

  if (dmPolicy === "disabled") {
    logVerbose(target.core, target.runtime, `kakao: blocked sender ${senderId} (disabled)`);
    return "이 봇은 현재 비활성화되어 있습니다.";
  }

  if (dmPolicy !== "open" && !senderAllowedForCommands) {
    if (dmPolicy === "pairing") {
      const { code, created } = await target.core.channel.pairing.upsertPairingRequest({
        channel: "kakao",
        id: senderId,
      });
      if (created) {
        logVerbose(target.core, target.runtime, `kakao pairing request sender=${senderId}`);
      }
      return target.core.channel.pairing.buildPairingReply({
        channel: "kakao",
        idLine: `Your Kakao user id: ${senderId}`,
        code,
      });
    }
    logVerbose(target.core, target.runtime, `kakao: blocked sender ${senderId}`);
    return "접근이 허용되지 않았습니다.";
  }

  const route = target.core.channel.routing.resolveAgentRoute({
    cfg: target.config,
    channel: "kakao",
    accountId: target.account.accountId,
    peer: {
      kind: "direct",
      id: senderId,
    },
  });

  if (
    target.core.channel.commands.isControlCommandMessage(rawBody, target.config) &&
    commandAuthorized !== true
  ) {
    logVerbose(target.core, target.runtime, `kakao: drop control command from ${senderId}`);
    return null;
  }

  const fromLabel = `user:${senderId}`;
  const storePath = target.core.channel.session.resolveStorePath(target.config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = target.core.channel.reply.resolveEnvelopeFormatOptions(target.config);
  const previousTimestamp = target.core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = target.core.channel.reply.formatAgentEnvelope({
    channel: "Kakao",
    from: fromLabel,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const messageId =
    request.userRequest?.callbackUrl?.trim() ||
    request.intent?.id?.trim() ||
    request.action?.id?.trim() ||
    undefined;
  const ctxPayload = target.core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `kakao:${senderId}`,
    To: `kakao:${senderId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: fromLabel,
    SenderId: senderId,
    CommandAuthorized: commandAuthorized,
    Provider: "kakao",
    Surface: "kakao",
    MessageSid: messageId,
    MessageSidFull: messageId,
    OriginatingChannel: "kakao",
    OriginatingTo: `kakao:${senderId}`,
  });

  await target.core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      target.runtime.error?.(`kakao: failed updating session meta: ${String(err)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: target.config,
    agentId: route.agentId,
    channel: "kakao",
    accountId: target.account.accountId,
  });

  const chunks: string[] = [];

  await target.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: target.config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload) => {
        if (payload.text) {
          chunks.push(payload.text);
        }
      },
      onError: (err, info) => {
        target.runtime.error?.(`kakao ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });

  const responseText = chunks.join("\n").trim();
  return responseText || null;
}

export async function handleKakaoWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = normalizeWebhookPath(url.pathname);
  const targets = webhookTargets.get(path);
  if (!targets || targets.length === 0) {
    return false;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  const body = await readJsonBody(req, 1024 * 1024);
  if (!body.ok) {
    res.statusCode = body.error === "payload too large" ? 413 : 400;
    res.end(body.error ?? "invalid payload");
    return true;
  }

  const raw = body.value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    res.statusCode = 400;
    res.end("invalid payload");
    return true;
  }

  const request = raw as KakaoRequest;
  const botId = request.bot?.id?.trim();
  if (!request.userRequest || typeof request.userRequest.utterance !== "string") {
    res.statusCode = 400;
    res.end("invalid payload");
    return true;
  }
  const target = pickTarget(targets, botId);
  if (!target) {
    res.statusCode = 409;
    res.end("ambiguous kakao webhook target");
    return true;
  }

  target.statusSink?.({ lastInboundAt: Date.now() });

  const callbackUrl = request.userRequest.callbackUrl?.trim() || "";
  if (callbackUrl) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        version: "2.0",
        useCallback: true,
        data: { text: "처리중입니다." },
        template: { outputs: [] },
      }),
    );

    void (async () => {
      let text: string | null = null;
      try {
        text = await processKakaoRequest({ request, target });
      } catch (err) {
        target.runtime.error?.(`kakao webhook failed: ${String(err)}`);
      }
      const responseText = text ?? "응답을 생성하지 못했어요.";
      await sendKakaoCallbackResponse(callbackUrl, buildKakaoResponse(responseText), target.runtime);
      target.statusSink?.({ lastOutboundAt: Date.now() });
    })();
    return true;
  }

  let text: string | null = null;
  try {
    text = await processKakaoRequest({ request, target });
  } catch (err) {
    target.runtime.error?.(`kakao webhook failed: ${String(err)}`);
  }

  const responseText = text ?? "응답을 생성하지 못했어요.";
  const payload = buildKakaoResponse(responseText);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
  target.statusSink?.({ lastOutboundAt: Date.now() });
  return true;
}

export function monitorKakaoProvider(options: KakaoMonitorOptions): () => void {
  const core = getKakaoRuntime();
  const webhookPath = resolveWebhookPath(options.webhookPath, options.webhookUrl);
  if (!webhookPath) {
    options.runtime.error?.(`[${options.account.accountId}] invalid webhook path`);
    return () => {};
  }

  const unregister = registerKakaoWebhookTarget({
    account: options.account,
    config: options.config,
    runtime: options.runtime,
    core,
    path: webhookPath,
    botId: options.account.botId,
    statusSink: options.statusSink,
  });

  logVerbose(core, options.runtime, `registered webhook handler at ${webhookPath}`);
  const stop = () => {
    options.abortSignal.removeEventListener("abort", stop);
    unregister();
  };
  options.abortSignal.addEventListener("abort", stop);
  return stop;
}

export function resolveKakaoWebhookPath(params: { account: ResolvedKakaoAccount }): string {
  return resolveWebhookPath(params.account.config.webhookPath, params.account.config.webhookUrl) ??
    "/kakao/webhook";
}
