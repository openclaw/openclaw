import {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  registerPluginHttpRoute,
  resolveOutboundMediaUrls,
  setAccountEnabledInConfigSection,
  toLocationContext,
} from "openclaw/plugin-sdk";
import { z } from "zod";
import { listAccountIds, resolveAccount } from "./accounts.js";
import { getNaverWorksRuntime } from "./runtime.js";
import { resolveNaverWorksAccessToken, sendMessageNaverWorks } from "./send.js";
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
    })
    .passthrough(),
);

const activeRouteUnregisters = new Map<string, () => void>();

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
  log?: { warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
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

export function createNaverWorksPlugin() {
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
      sendText: async ({ cfg, to, text, accountId }) => {
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
        return {
          channel: CHANNEL_ID,
          messageId: `naverworks:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
        };
      },
      sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
        const account = resolveAccount(cfg as Record<string, unknown>, accountId);
        const caption = text?.trim();
        if (caption) {
          const sentText = await sendMessageNaverWorks({
            account,
            toUserId: to,
            text: caption,
          });
          if (!sentText.ok) {
            throw new Error(
              `NAVER WORKS text preface failed (${sentText.reason}, status=${sentText.status ?? "unknown"}).`,
            );
          }
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
            `NAVER WORKS media send failed (${sentMedia.reason}, status=${sentMedia.status ?? "unknown"}): ${sentMedia.body?.slice(0, 300) ?? ""}`,
          );
        }
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
            const freshCfg = await runtime.config.loadConfig();
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
            const downloadedMedia = await downloadInboundMedia({
              runtime,
              account,
              event,
              log,
            });
            const mediaPath = downloadedMedia.path;
            const mediaUrls = event.mediaUrl ? [event.mediaUrl] : undefined;
            const mediaPaths = mediaPath ? [mediaPath] : undefined;
            const mediaTypes =
              downloadedMedia.mediaType || event.mediaMimeType
                ? [downloadedMedia.mediaType ?? event.mediaMimeType ?? "application/octet-stream"]
                : undefined;

            const locationContext = event.location ? toLocationContext(event.location) : undefined;
            const msgCtx = {
              Body: inboundBody,
              BodyForAgent: inboundBody,
              RawBody: inboundBody,
              CommandBody: inboundBody,
              From: `naverworks:${event.userId}`,
              To: `naverworks:${account.accountId}`,
              SessionKey: route.sessionKey,
              AccountId: route.accountId,
              ChatType: "direct",
              SenderName: event.senderName,
              SenderId: event.userId,
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

            await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: msgCtx,
              cfg: freshCfg,
              dispatcherOptions: {
                onReplyStart: () => {
                  log?.info?.(`naverworks: reply started for ${event.userId} (${route.agentId})`);
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

                  if (localMediaPaths.length > 0) {
                    log?.warn?.(
                      `naverworks[${account.accountId}]: skipped ${localMediaPaths.length} local media attachment(s); NAVER WORKS requires remotely reachable media URLs`,
                    );
                  }

                  if (text) {
                    const sent = await sendMessageNaverWorks({
                      account,
                      toUserId: event.userId,
                      text,
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
                      `naverworks[${account.accountId}]: outbound text delivered to ${event.userId}`,
                    );
                  }

                  for (const mediaUrl of remoteMediaUrls) {
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
                      `naverworks[${account.accountId}]: outbound media delivered to ${event.userId}`,
                    );
                  }
                },
              },
            });
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
