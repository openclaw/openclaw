import {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  type ChannelOutboundContext,
  type ChannelPlugin,
  registerPluginHttpRoute,
  resolveOutboundMediaUrls,
  setAccountEnabledInConfigSection,
  toLocationContext,
} from "openclaw/plugin-sdk";
import { z } from "zod";
import { listAccountIds, resolveAccount } from "./accounts.js";
import { getNaverWorksRuntime } from "./runtime.js";
import { resolveNaverWorksAccessToken, sendMessageNaverWorks } from "./send.js";
import type { NaverWorksSendDelivery } from "./send.js";
import type { NaverWorksAccount } from "./types.js";
import { createNaverWorksWebhookHandler } from "./webhook-handler.js";

const CHANNEL_ID = "naverworks";

const NaverWorksConfigSchema = buildChannelConfigSchema(
  z
    .object({
      dmPolicy: z.enum(["open", "pairing", "allowlist", "disabled"]).optional(),
      allowFrom: z.array(z.string()).optional(),
      webhookPath: z.string().optional(),
      botName: z.string().optional(),
      strictBinding: z.boolean().optional(),
      botSecret: z.string().optional(),
      botId: z.string().optional(),
      accessToken: z.string().optional(),
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
      serviceAccount: z.string().optional(),
      privateKey: z.string().optional(),
      scope: z.string().optional(),
      tokenUrl: z.string().optional(),
      jwtIssuer: z.string().optional(),
      apiBaseUrl: z.string().optional(),
      markdownMode: z.enum(["plain", "auto-flex"]).optional(),
      autoThinking: z
        .object({
          enabled: z.boolean().optional(),
          defaultLevel: z.enum(["low", "medium", "high"]).optional(),
          lowKeywords: z.array(z.string()).optional(),
          highKeywords: z.array(z.string()).optional(),
        })
        .optional(),
      statusStickers: z
        .object({
          enabled: z.boolean().optional(),
          received: z.object({ packageId: z.string(), stickerId: z.string() }).optional(),
          processing: z.object({ packageId: z.string(), stickerId: z.string() }).optional(),
          failed: z.object({ packageId: z.string(), stickerId: z.string() }).optional(),
        })
        .optional(),
    })
    .passthrough(),
);

const activeRouteUnregisters = new Map<string, () => void>();
const INLINE_THINK_DIRECTIVE_RE = /(^|\s)\/(?:think|thinking|t)(?::|\s|$)/i;
const PROCESSING_STICKER_INTERVAL_MS = 60_000;
const FAILED_REPLY_NOTICE = "처리에 실패했습니다. 잠시 후 다시 시도해주세요.";

type AutoThinkingLevel = "low" | "medium" | "high";

function formatDeliveryLog(delivery: NaverWorksSendDelivery): string {
  return [
    `contentType=${delivery.contentType}`,
    `viaAttachmentUpload=${delivery.viaAttachmentUpload ? "yes" : "no"}`,
    `mediaKind=${delivery.mediaKind ?? "none"}`,
    `uploadedFileId=${delivery.uploadedFileId ? "yes" : "no"}`,
    `remoteMediaUrl=${delivery.remoteMediaUrl ? "yes" : "no"}`,
  ].join(" ");
}

function resolveAutoThinkingLevel(params: {
  text?: string;
  account: ReturnType<typeof resolveAccount>;
}): AutoThinkingLevel | undefined {
  const text = params.text?.trim();
  if (!text || !params.account.autoThinking?.enabled) {
    return undefined;
  }
  if (INLINE_THINK_DIRECTIVE_RE.test(text)) {
    return undefined;
  }

  const normalized = text.toLowerCase();
  const { highKeywords = [], lowKeywords = [] } = params.account.autoThinking;
  if (highKeywords.some((keyword) => keyword && normalized.includes(keyword.toLowerCase()))) {
    return "high";
  }
  if (lowKeywords.some((keyword) => keyword && normalized.includes(keyword.toLowerCase()))) {
    return "low";
  }
  return params.account.autoThinking.defaultLevel;
}

export function resolveAutoThinkingDirective(params: {
  text?: string;
  account: ReturnType<typeof resolveAccount>;
}): string | undefined {
  const level = resolveAutoThinkingLevel(params);
  return level ? `/think ${level}` : undefined;
}

async function sendStatusSticker(params: {
  account: ReturnType<typeof resolveAccount>;
  userId: string;
  phase: "received" | "processing" | "failed";
  log?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
}): Promise<void> {
  if (!params.account.statusStickers?.enabled) {
    params.log?.info?.(
      `naverworks[${params.account.accountId}]: status sticker skipped phase=${params.phase} (statusStickers disabled)`,
    );
    return;
  }
  const sticker = params.account.statusStickers[params.phase];
  if (!sticker) {
    params.log?.warn?.(
      `naverworks[${params.account.accountId}]: status sticker skipped phase=${params.phase} (sticker not configured)`,
    );
    return;
  }

  params.log?.info?.(
    `naverworks[${params.account.accountId}]: sending ${params.phase} sticker to ${params.userId} (packageId=${sticker.packageId}, stickerId=${sticker.stickerId})`,
  );

  try {
    const sent = await sendMessageNaverWorks({
      account: params.account,
      toUserId: params.userId,
      sticker,
    });
    if (!sent.ok) {
      params.log?.warn?.(
        `naverworks[${params.account.accountId}]: failed to send ${params.phase} sticker to ${params.userId} (reason=${sent.reason}, status=${sent.status ?? "unknown"}, body=${sent.body?.slice(0, 300) ?? ""})`,
      );
      return;
    }
    params.log?.info?.(
      `naverworks[${params.account.accountId}]: sent ${params.phase} sticker to ${params.userId}`,
    );
  } catch (error) {
    params.log?.error?.(
      `naverworks[${params.account.accountId}]: status sticker send threw phase=${params.phase} userId=${params.userId}: ${String(error)}`,
    );
  }
}

function startProcessingStickerHeartbeat(params: {
  account: ReturnType<typeof resolveAccount>;
  userId: string;
  log?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
}): () => void {
  params.log?.info?.(
    `naverworks[${params.account.accountId}]: starting processing sticker heartbeat for ${params.userId} intervalMs=${PROCESSING_STICKER_INTERVAL_MS}`,
  );
  const timer = setInterval(() => {
    void sendStatusSticker({
      account: params.account,
      userId: params.userId,
      phase: "processing",
      log: params.log,
    });
  }, PROCESSING_STICKER_INTERVAL_MS);

  return () => {
    clearInterval(timer);
    params.log?.info?.(
      `naverworks[${params.account.accountId}]: stopped processing sticker heartbeat for ${params.userId}`,
    );
  };
}

function hasNaverWorksOutboundAuth(account: ReturnType<typeof resolveAccount>): boolean {
  if (account.accessToken?.trim()) {
    return true;
  }
  return Boolean(
    account.clientId?.trim() &&
    account.clientSecret?.trim() &&
    account.serviceAccount?.trim() &&
    account.privateKey,
  );
}

function isNaverWorksConfigured(account: ReturnType<typeof resolveAccount>): boolean {
  return Boolean(account.botId?.trim()) && hasNaverWorksOutboundAuth(account);
}

async function downloadInboundMedia(params: {
  runtime: ReturnType<typeof getNaverWorksRuntime>;
  account: ReturnType<typeof resolveAccount>;
  event: { mediaUrl?: string; mediaMimeType?: string; mediaFileName?: string; mediaKind?: string };
  log?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
}): Promise<{ path?: string; mediaType?: string }> {
  const mediaUrl = params.event.mediaUrl?.trim();
  if (!mediaUrl) {
    return {};
  }

  const maxBytes = 20 * 1024 * 1024;
  const headers: Record<string, string> = {};
  const accessToken = await resolveNaverWorksAccessToken(params.account);
  if (accessToken.ok) {
    headers.Authorization = `Bearer ${accessToken.token}`;
  } else {
    params.log?.warn?.(
      `naverworks[${params.account.accountId}]: inbound media fetch proceeding without bot auth (status=${accessToken.status ?? "unknown"})`,
    );
  }

  try {
    const fetched = await params.runtime.channel.media.fetchRemoteMedia({
      url: mediaUrl,
      maxBytes,
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
    });
    const saved = await params.runtime.channel.media.saveMediaBuffer(
      fetched.buffer,
      fetched.contentType ?? params.event.mediaMimeType,
      "inbound",
      maxBytes,
      fetched.fileName ?? params.event.mediaFileName ?? params.event.mediaKind,
    );
    return {
      path: saved.path,
      mediaType: saved.contentType ?? fetched.contentType ?? params.event.mediaMimeType,
    };
  } catch (error) {
    params.log?.error?.(
      `naverworks[${params.account.accountId}]: failed to download inbound media ${mediaUrl}: ${String(error)}`,
    );
    return { mediaType: params.event.mediaMimeType };
  }
}

export function createNaverWorksPlugin(): ChannelPlugin<NaverWorksAccount> {
  return {
    id: CHANNEL_ID,

    meta: {
      id: CHANNEL_ID,
      label: "NAVER WORKS",
      selectionLabel: "NAVER WORKS (Webhook)",
      detailLabel: "NAVER WORKS (Webhook)",
      docsPath: "/channels/naverworks",
      blurb: "NAVER WORKS DM-first channel plugin with per-user agent routing.",
      order: 92,
    },

    capabilities: {
      chatTypes: ["direct" as const],
      media: true,
      threads: false,
      reactions: false,
      edit: false,
      unsend: false,
      reply: true,
      effects: false,
      blockStreaming: false,
    },

    reload: { configPrefixes: ["channels.naverworks", "bindings", "agents"] },

    configSchema: NaverWorksConfigSchema,

    config: {
      listAccountIds: (cfg: any) => listAccountIds(cfg),
      resolveAccount: (cfg: any, accountId?: string | null) => resolveAccount(cfg, accountId),
      defaultAccountId: () => DEFAULT_ACCOUNT_ID,
      isConfigured: (account: ReturnType<typeof resolveAccount>) => isNaverWorksConfigured(account),
      describeAccount: (account: ReturnType<typeof resolveAccount>) => ({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: isNaverWorksConfigured(account),
        dmPolicy: account.dmPolicy,
      }),
      setAccountEnabled: ({ cfg, accountId, enabled }: any) =>
        setAccountEnabledInConfigSection({
          cfg,
          sectionKey: "channels.naverworks",
          accountId,
          enabled,
        }),
    },

    messaging: {
      normalizeTarget: (raw: string) => {
        const trimmed = raw?.trim();
        if (!trimmed) {
          return undefined;
        }
        return trimmed.replace(/^naverworks:/i, "");
      },
      targetResolver: {
        looksLikeId: (raw: string, normalized?: string | null) =>
          Boolean((normalized ?? raw)?.trim()),
        hint: "<userId>",
      },
    },

    outbound: {
      deliveryMode: "direct",
      sendText: async ({ cfg, to, text, accountId }: ChannelOutboundContext) => {
        const account = resolveAccount(cfg as Record<string, unknown>, accountId);
        const sent = await sendMessageNaverWorks({
          account,
          toUserId: to,
          text,
        });
        if (!sent.ok) {
          if (sent.reason === "not-configured") {
            throw new Error(
              `NAVER WORKS account \"${account.accountId}\" is not configured for outbound delivery (set botId and auth settings).`,
            );
          }
          throw new Error(
            `NAVER WORKS send failed (${sent.reason}, status=${sent.status ?? "unknown"}): ${sent.body?.slice(0, 300) ?? ""}`,
          );
        }
        getNaverWorksRuntime().log?.info?.(
          `naverworks[${account.accountId}]: outbound sendText delivered to=${to} ${formatDeliveryLog(sent.delivery)}`,
        );
        return {
          channel: CHANNEL_ID,
          messageId: `naverworks:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
        };
      },
      sendMedia: async ({ cfg, to, text, mediaUrl, accountId }: ChannelOutboundContext) => {
        const account = resolveAccount(cfg as Record<string, unknown>, accountId);
        const caption = text?.trim();
        const mediaHref = mediaUrl?.trim();
        if (caption) {
          const sentText = await sendMessageNaverWorks({
            account,
            toUserId: to,
            text: caption,
          });
          if (!sentText.ok) {
            throw new Error(
              `NAVER WORKS text preface failed (${sentText.reason}, status=${sentText.status ?? "unknown"}, to=${to}, mediaUrl=${mediaHref ?? "none"}): ${sentText.body?.slice(0, 300) ?? ""}`,
            );
          }
          getNaverWorksRuntime().log?.info?.(
            `naverworks[${account.accountId}]: outbound sendMedia text preface delivered to=${to} ${formatDeliveryLog(sentText.delivery)}`,
          );
        }
        const sentMedia = await sendMessageNaverWorks({
          account,
          toUserId: to,
          mediaUrl,
        });
        if (!sentMedia.ok) {
          if (sentMedia.reason === "not-configured") {
            throw new Error(
              `NAVER WORKS account \"${account.accountId}\" is not configured for media outbound delivery (set botId and auth settings).`,
            );
          }
          throw new Error(
            `NAVER WORKS media send failed (${sentMedia.reason}, status=${sentMedia.status ?? "unknown"}, to=${to}, mediaUrl=${mediaHref ?? "none"}): ${sentMedia.body?.slice(0, 300) ?? ""}`,
          );
        }
        getNaverWorksRuntime().log?.info?.(
          `naverworks[${account.accountId}]: outbound sendMedia delivered to=${to} ${formatDeliveryLog(sentMedia.delivery)}`,
        );
        return {
          channel: CHANNEL_ID,
          messageId: `naverworks:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
        };
      },
    },

    status: {
      defaultRuntime: {
        accountId: DEFAULT_ACCOUNT_ID,
        running: false,
        connected: false,
        lastStartAt: null,
        lastStopAt: null,
        lastInboundAt: null,
        lastOutboundAt: null,
        lastError: null,
      },
      buildAccountSnapshot: ({ account, runtime }: any) => {
        const configured = isNaverWorksConfigured(account);
        return {
          accountId: account.accountId,
          enabled: account.enabled,
          configured,
          dmPolicy: account.dmPolicy,
          running: runtime?.running ?? false,
          connected: runtime?.connected ?? runtime?.running ?? false,
          lastStartAt: runtime?.lastStartAt ?? null,
          lastStopAt: runtime?.lastStopAt ?? null,
          lastInboundAt: runtime?.lastInboundAt ?? null,
          lastOutboundAt: runtime?.lastOutboundAt ?? null,
          lastError: runtime?.lastError ?? null,
        };
      },
    },

    gateway: {
      startAccount: async (ctx: any) => {
        const { cfg, accountId, log } = ctx;
        log?.info?.(`naverworks[${accountId ?? DEFAULT_ACCOUNT_ID}]: start requested`);
        const account = resolveAccount(cfg, accountId);
        log?.info?.(
          `naverworks[${account.accountId}]: resolved config (enabled=${account.enabled}, webhookPath=${account.webhookPath}, dmPolicy=${account.dmPolicy}, strictBinding=${account.strictBinding}, outboundConfigured=${Boolean(account.botId && account.accessToken)})`,
        );
        if (!account.enabled) {
          log?.info?.(`naverworks[${account.accountId}]: disabled; skipping start`);
          return { stop: () => {} };
        }

        const routeKey = `${account.accountId}:${account.webhookPath}`;
        const prev = activeRouteUnregisters.get(routeKey);
        if (prev) {
          log?.info?.(
            `naverworks[${account.accountId}]: replacing existing webhook route ${account.webhookPath}`,
          );
          prev();
          activeRouteUnregisters.delete(routeKey);
        }

        const handler = createNaverWorksWebhookHandler({
          account,
          log,
          deliver: async (event) => {
            log?.info?.(
              `naverworks[${account.accountId}]: processing inbound event userId=${event.userId}${event.teamId ? ` teamId=${event.teamId}` : ""}`,
            );
            const runtime = getNaverWorksRuntime();
            log?.info?.(`naverworks[${account.accountId}]: loading fresh config for inbound event`);
            const freshCfg = await runtime.config.loadConfig();
            log?.info?.(`naverworks[${account.accountId}]: config load complete`);
            log?.info?.(
              `naverworks[${account.accountId}]: resolving route for peer=${event.userId}${event.teamId ? ` teamId=${event.teamId}` : ""}`,
            );
            const route = runtime.channel.routing.resolveAgentRoute({
              cfg: freshCfg,
              channel: CHANNEL_ID,
              accountId: account.accountId,
              teamId: event.teamId,
              peer: { kind: "direct", id: event.userId },
            });
            log?.info?.(
              `naverworks[${account.accountId}]: route resolved agentId=${route.agentId} matchedBy=${route.matchedBy} sessionKey=${route.sessionKey}${event.teamId ? ` teamId=${event.teamId}` : ""}`,
            );

            if (account.strictBinding && route.matchedBy === "default") {
              log?.warn?.(
                `naverworks: strictBinding dropped event for ${event.userId}${event.teamId ? ` teamId=${event.teamId}` : ""} (no matching binding)`,
              );
              return;
            }

            const inboundBody =
              event.text?.trim() || (event.mediaKind ? `<media:${event.mediaKind}>` : "<media>");
            const autoThinkingDirective = resolveAutoThinkingDirective({
              text: event.text,
              account,
            });
            const bodyWithAutoThinking = autoThinkingDirective
              ? `${autoThinkingDirective}\n${inboundBody}`
              : inboundBody;
            await sendStatusSticker({
              account,
              userId: event.userId,
              phase: "received",
              log,
            });
            log?.info?.(
              `naverworks[${account.accountId}]: preparing inbound context bodyType=${event.mediaKind ? "media" : "text"} mediaUrl=${event.mediaUrl ? "yes" : "no"}`,
            );
            log?.info?.(
              `naverworks[${account.accountId}]: downloading inbound media=${event.mediaUrl ? "yes" : "no"}`,
            );
            const downloadedMedia = await downloadInboundMedia({
              runtime,
              account,
              event,
              log,
            });
            log?.info?.(
              `naverworks[${account.accountId}]: inbound media download complete saved=${downloadedMedia.path ? "yes" : "no"} mediaType=${downloadedMedia.mediaType ?? "none"}`,
            );
            const mediaPath = downloadedMedia.path;
            const mediaUrls = event.mediaUrl ? [event.mediaUrl] : undefined;
            const mediaPaths = mediaPath ? [mediaPath] : undefined;
            const mediaTypes =
              downloadedMedia.mediaType || event.mediaMimeType
                ? [downloadedMedia.mediaType ?? event.mediaMimeType ?? "application/octet-stream"]
                : undefined;

            const locationContext = event.location ? toLocationContext(event.location) : undefined;
            const msgCtx = {
              Body: bodyWithAutoThinking,
              BodyForAgent: bodyWithAutoThinking,
              RawBody: bodyWithAutoThinking,
              CommandBody: bodyWithAutoThinking,
              From: `naverworks:${event.userId}`,
              To: `naverworks:${account.accountId}`,
              SessionKey: route.sessionKey,
              AccountId: route.accountId,
              ChatType: "direct",
              SenderName: event.senderName,
              SenderId: event.userId,
              // Accepted NAVER WORKS DMs have already passed dmPolicy/allowlist checks,
              // so in-channel control commands like /new should be treated as authorized.
              CommandAuthorized: true,
              Provider: CHANNEL_ID,
              Surface: CHANNEL_ID,
              OriginatingChannel: CHANNEL_ID,
              OriginatingTo: `naverworks:${account.accountId}`,
              MediaPath: mediaPath,
              MediaPaths: mediaPaths,
              MediaType: downloadedMedia.mediaType ?? event.mediaMimeType,
              MediaTypes: mediaTypes,
              MediaUrl: event.mediaUrl ?? mediaPath,
              MediaUrls: mediaUrls,
              MediaName: event.mediaFileName,
              ...(locationContext ?? {}),
            };

            log?.info?.(
              `naverworks[${account.accountId}]: dispatching buffered reply sessionKey=${route.sessionKey}`,
            );
            let stopProcessingStickerHeartbeat = () => {};
            let processingStickerHeartbeatStarted = false;
            try {
              await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
                ctx: msgCtx,
                cfg: freshCfg,
                dispatcherOptions: {
                  onReplyStart: async () => {
                    log?.info?.(`naverworks: reply started for ${event.userId} (${route.agentId})`);
                    if (processingStickerHeartbeatStarted) {
                      return;
                    }
                    processingStickerHeartbeatStarted = true;
                    stopProcessingStickerHeartbeat = startProcessingStickerHeartbeat({
                      account,
                      userId: event.userId,
                      log,
                    });
                  },
                  deliver: async (payload: {
                    text?: string;
                    body?: string;
                    mediaUrl?: string;
                    mediaUrls?: string[];
                    audioAsVoice?: boolean;
                  }) => {
                    const text = payload?.text ?? payload?.body;
                    const mediaUrls = resolveOutboundMediaUrls(payload ?? {});
                    const remoteMediaUrls = mediaUrls.filter((url) => /^https?:\/\//i.test(url));
                    const localMediaPaths = mediaUrls.filter((url) => !/^https?:\/\//i.test(url));
                    const pendingRemoteMedia = [...remoteMediaUrls];
                    let pendingText = text;
                    log?.info?.(
                      `naverworks[${account.accountId}]: deliver callback text=${text ? "yes" : "no"} remoteMedia=${remoteMediaUrls.length} localMedia=${localMediaPaths.length}`,
                    );

                    if (localMediaPaths.length > 0) {
                      log?.warn?.(
                        `naverworks[${account.accountId}]: processing ${localMediaPaths.length} local media attachment(s) through NAVER WORKS attachment upload`,
                      );
                    }

                    log?.info?.(
                      `naverworks[${account.accountId}]: outbound routing pendingText=${pendingText ? "yes" : "no"} remoteMediaRemaining=${pendingRemoteMedia.length} localMediaRemaining=${localMediaPaths.length}`,
                    );
                    if (pendingText) {
                      log?.info?.(
                        `naverworks[${account.accountId}]: sending standalone text message to ${event.userId} textChars=${pendingText.length}`,
                      );
                      const sent = await sendMessageNaverWorks({
                        account,
                        toUserId: event.userId,
                        text: pendingText,
                      });

                      if (!sent.ok) {
                        if (sent.reason === "not-configured") {
                          log?.warn?.(
                            `naverworks[${account.accountId}]: outbound skipped (set botId and auth settings to enable delivery)`,
                          );
                          return;
                        }
                        if (sent.reason === "auth-error") {
                          log?.error?.(
                            `naverworks[${account.accountId}]: outbound auth failed status=${sent.status ?? "unknown"} body=${sent.body?.slice(0, 300) ?? ""} (check accessToken or JWT auth settings)`,
                          );
                          return;
                        }
                        log?.error?.(
                          `naverworks[${account.accountId}]: outbound send failed status=${sent.status ?? "unknown"} body=${sent.body?.slice(0, 300) ?? ""}`,
                        );
                        return;
                      }

                      log?.info?.(
                        `naverworks[${account.accountId}]: outbound text delivered to ${event.userId} ${formatDeliveryLog(sent.delivery)}`,
                      );
                    }

                    for (const mediaUrl of pendingRemoteMedia) {
                      log?.info?.(
                        `naverworks[${account.accountId}]: sending standalone remote media to ${event.userId} mediaUrl=${mediaUrl}`,
                      );
                      const sentMedia = await sendMessageNaverWorks({
                        account,
                        toUserId: event.userId,
                        mediaUrl,
                      });
                      if (!sentMedia.ok) {
                        if (sentMedia.reason === "not-configured") {
                          log?.warn?.(
                            `naverworks[${account.accountId}]: outbound media skipped (set botId and auth settings to enable delivery)`,
                          );
                          return;
                        }
                        if (sentMedia.reason === "auth-error") {
                          log?.error?.(
                            `naverworks[${account.accountId}]: outbound media auth failed status=${sentMedia.status ?? "unknown"} body=${sentMedia.body?.slice(0, 300) ?? ""}`,
                          );
                          return;
                        }
                        log?.error?.(
                          `naverworks[${account.accountId}]: outbound media send failed status=${sentMedia.status ?? "unknown"} body=${sentMedia.body?.slice(0, 300) ?? ""}`,
                        );
                        return;
                      }
                      log?.info?.(
                        `naverworks[${account.accountId}]: outbound media delivered to ${event.userId} ${formatDeliveryLog(sentMedia.delivery)}`,
                      );
                    }

                    for (const mediaPath of localMediaPaths) {
                      log?.info?.(
                        `naverworks[${account.accountId}]: sending local media through attachment upload to ${event.userId} mediaPath=${mediaPath}`,
                      );
                      const sentMedia = await sendMessageNaverWorks({
                        account,
                        toUserId: event.userId,
                        mediaUrl: mediaPath,
                      });
                      if (!sentMedia.ok) {
                        if (sentMedia.reason === "not-configured") {
                          log?.warn?.(
                            `naverworks[${account.accountId}]: outbound local media skipped (set botId and auth settings to enable delivery)`,
                          );
                          return;
                        }
                        if (sentMedia.reason === "auth-error") {
                          log?.error?.(
                            `naverworks[${account.accountId}]: outbound local media auth failed status=${sentMedia.status ?? "unknown"} body=${sentMedia.body?.slice(0, 300) ?? ""}`,
                          );
                          return;
                        }
                        log?.error?.(
                          `naverworks[${account.accountId}]: outbound local media send failed status=${sentMedia.status ?? "unknown"} body=${sentMedia.body?.slice(0, 300) ?? ""}`,
                        );
                        return;
                      }
                      log?.info?.(
                        `naverworks[${account.accountId}]: outbound local media delivered to ${event.userId} ${formatDeliveryLog(sentMedia.delivery)}`,
                      );
                    }
                  },
                },
              });
              stopProcessingStickerHeartbeat();
            } catch (error) {
              stopProcessingStickerHeartbeat();
              await sendStatusSticker({
                account,
                userId: event.userId,
                phase: "failed",
                log,
              });
              const failedNoticeSent = await sendMessageNaverWorks({
                account,
                toUserId: event.userId,
                text: FAILED_REPLY_NOTICE,
              });
              if (!failedNoticeSent.ok) {
                log?.warn?.(
                  `naverworks[${account.accountId}]: failed to send failure notice to ${event.userId} (reason=${failedNoticeSent.reason}, status=${failedNoticeSent.status ?? "unknown"}, body=${failedNoticeSent.body?.slice(0, 300) ?? ""})`,
                );
              }
              log?.error?.(
                `naverworks[${account.accountId}]: reply pipeline failed for ${event.userId}: ${String(error)}`,
              );
              return;
            }
            log?.info?.(`naverworks[${account.accountId}]: buffered reply dispatch complete`);
            log?.info?.(
              `naverworks[${account.accountId}]: inbound event handled for ${event.userId} (agent=${route.agentId})`,
            );
          },
        });

        const unregister = registerPluginHttpRoute({
          path: account.webhookPath,
          auth: "plugin",
          pluginId: CHANNEL_ID,
          accountId: account.accountId,
          log: (line: string) => log?.info?.(line),
          handler,
        });
        log?.info?.(
          `naverworks[${account.accountId}]: webhook route registered at ${account.webhookPath}`,
        );
        activeRouteUnregisters.set(routeKey, unregister);
        ctx.setStatus({ connected: true, lastError: null });

        try {
          // Webhook mode is passive; keep account task alive until the runtime aborts it.
          await new Promise<void>((resolve) => {
            if (ctx.abortSignal.aborted) {
              resolve();
              return;
            }
            ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        } finally {
          log?.info?.(
            `naverworks[${account.accountId}]: abort received; unregistering webhook route`,
          );
          ctx.setStatus({ connected: false });
          unregister();
          activeRouteUnregisters.delete(routeKey);
        }
      },
      stopAccount: async () => {},
    },
  };
}
