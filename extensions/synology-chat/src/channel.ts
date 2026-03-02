import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_ACCOUNT_ID,
  registerPluginHttpRoute,
  setAccountEnabledInConfigSection,
  buildChannelConfigSchema,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { sendMessage, sendFileUrl } from "./client.js";
import { getSynologyRuntime } from "./runtime.js";

type SynologyChatAccountConfig = {
  enabled?: boolean;
  token?: string;
  incomingUrl?: string;
  webhookPath?: string;
  dmPolicy?: string;
  allowedUserIds?: string[];
  allowFrom?: string[];
};

type SynologyChatChannelConfig = {
  enabled?: boolean;
  accounts?: Record<string, SynologyChatAccountConfig>;
} & SynologyChatAccountConfig;

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): SynologyChatAccountConfig | undefined {
  const section = (cfg.channels as Record<string, unknown> | undefined)?.["synology-chat"] as
    | SynologyChatChannelConfig
    | undefined;
  if (!section) {
    return undefined;
  }
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return section;
  }
  return section.accounts?.[accountId];
}

function parseFormBody(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of body.split("&")) {
    const [key, ...rest] = pair.split("=");
    if (key) {
      result[decodeURIComponent(key)] = decodeURIComponent(rest.join("="));
    }
  }
  return result;
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function createSynologyChatPlugin() {
  return {
    gateway: {
      startAccount: async (ctx: {
        cfg: OpenClawConfig;
        accountId: string;
        log?: {
          info: (...args: unknown[]) => void;
          warn: (...args: unknown[]) => void;
          error: (...args: unknown[]) => void;
        };
      }) => {
        const accountId = ctx.accountId;
        const accountConfig = resolveAccountConfig(ctx.cfg, accountId);
        if (!accountConfig) {
          throw new Error(`Synology Chat not configured for account "${accountId}"`);
        }

        const token = accountConfig.token;
        const webhookPath = accountConfig.webhookPath ?? `/webhook/synology-chat/${accountId}`;
        const dmPolicy = accountConfig.dmPolicy ?? "open";
        const allowedUserIds = accountConfig.allowedUserIds ?? [];
        const core = getSynologyRuntime();

        const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
          if (req.method !== "POST") {
            res.writeHead(405, { "Content-Type": "text/plain" });
            res.end("Method Not Allowed");
            return;
          }

          const body = await readRequestBody(req);
          const fields = parseFormBody(body);

          if (token && fields.token !== token) {
            res.writeHead(401, { "Content-Type": "text/plain" });
            res.end("unauthorized");
            return;
          }

          const senderId = fields.user_id;
          const senderName = fields.username ?? "";
          const text = fields.text ?? "";

          if (dmPolicy === "allowlist") {
            const isAllowed =
              allowedUserIds.length > 0 &&
              senderId !== undefined &&
              allowedUserIds.includes(senderId);
            if (!isAllowed) {
              res.writeHead(403, { "Content-Type": "text/plain" });
              res.end("not authorized");
              return;
            }
          }

          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("ok");

          try {
            await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: {
                Body: text,
                From: `synology-chat:${senderId}`,
                To: `synology-chat:${accountId}`,
                Provider: "synology-chat",
                SenderId: senderId,
                SenderName: senderName,
                AccountId: accountId,
              },
              cfg: ctx.cfg,
              dispatcherOptions: {
                deliver: async (payload: { text?: string }) => {
                  if (payload.text && accountConfig.incomingUrl) {
                    await sendMessage(accountConfig.incomingUrl, payload.text);
                  }
                },
                onError: (err: unknown) => {
                  ctx.log?.error(`[${accountId}] Synology Chat reply failed: ${String(err)}`);
                },
              },
            });
          } catch (err) {
            ctx.log?.error(`[${accountId}] Synology Chat dispatch failed: ${String(err)}`);
          }
        };

        const unregister = registerPluginHttpRoute({
          path: webhookPath,
          accountId,
          handler,
        });

        return {
          stop: () => {
            unregister();
          },
        };
      },
    },
  };
}
