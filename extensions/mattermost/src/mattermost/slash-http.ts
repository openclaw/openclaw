/**
 * HTTP callback handler for Mattermost slash commands.
 *
 * Receives POST requests from Mattermost when a slash command is invoked,
 * validates the token, and routes the command through the standard inbound pipeline.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig, ReplyPayload, RuntimeEnv } from "openclaw/plugin-sdk";
import {
  createReplyPrefixOptions,
  createTypingCallbacks,
  logTypingFailure,
} from "openclaw/plugin-sdk";
import type { ResolvedMattermostAccount } from "../mattermost/accounts.js";
import { getMattermostRuntime } from "../runtime.js";
import {
  createMattermostClient,
  fetchMattermostChannel,
  fetchMattermostUser,
  normalizeMattermostBaseUrl,
  sendMattermostTyping,
  type MattermostChannel,
} from "./client.js";
import { sendMessageMattermost } from "./send.js";
import {
  parseSlashCommandPayload,
  resolveCommandText,
  type MattermostSlashCommandResponse,
} from "./slash-commands.js";

type SlashHttpHandlerParams = {
  account: ResolvedMattermostAccount;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  /** Expected token from registered commands (for validation). */
  commandTokens: Set<string>;
  log?: (msg: string) => void;
};

/**
 * Read the full request body as a string.
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJsonResponse(
  res: ServerResponse,
  status: number,
  body: MattermostSlashCommandResponse,
) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/**
 * Create the HTTP request handler for Mattermost slash command callbacks.
 *
 * This handler is registered as a plugin HTTP route and receives POSTs
 * from the Mattermost server when a user invokes a registered slash command.
 */
export function createSlashCommandHttpHandler(params: SlashHttpHandlerParams) {
  const { account, cfg, runtime, commandTokens, log } = params;
  const core = getMattermostRuntime();

  const MAX_BODY_BYTES = 64 * 1024; // 64KB

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return;
    }

    let body: string;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch {
      res.statusCode = 413;
      res.end("Payload Too Large");
      return;
    }

    const contentType = req.headers["content-type"] ?? "";
    const payload = parseSlashCommandPayload(body, contentType);
    if (!payload) {
      sendJsonResponse(res, 400, {
        response_type: "ephemeral",
        text: "Invalid slash command payload.",
      });
      return;
    }

    // Validate token — fail closed: reject when no tokens are registered
    // (e.g. registration failed or startup was partial)
    if (commandTokens.size === 0 || !commandTokens.has(payload.token)) {
      sendJsonResponse(res, 401, {
        response_type: "ephemeral",
        text: "Unauthorized: invalid command token.",
      });
      return;
    }

    // Extract command info
    const trigger = payload.command.replace(/^\//, "").trim();
    const commandText = resolveCommandText(trigger, payload.text);
    const channelId = payload.channel_id;
    const senderId = payload.user_id;
    const senderName = payload.user_name ?? senderId;

    log?.(`mattermost: slash command /${trigger} from ${senderName} in ${channelId}`);

    // Acknowledge immediately — we'll send the actual reply asynchronously
    sendJsonResponse(res, 200, {
      response_type: "ephemeral",
      text: "Processing...",
    });

    // Now handle the command asynchronously (post reply as a message)
    try {
      await handleSlashCommandAsync({
        account,
        cfg,
        runtime,
        commandText,
        channelId,
        senderId,
        senderName,
        teamId: payload.team_id,
        triggerId: payload.trigger_id,
        log,
      });
    } catch (err) {
      log?.(`mattermost: slash command handler error: ${String(err)}`);
      try {
        const to = `channel:${channelId}`;
        await sendMessageMattermost(to, "Sorry, something went wrong processing that command.", {
          accountId: account.accountId,
        });
      } catch {
        // best-effort error reply
      }
    }
  };
}

async function handleSlashCommandAsync(params: {
  account: ResolvedMattermostAccount;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  commandText: string;
  channelId: string;
  senderId: string;
  senderName: string;
  teamId: string;
  triggerId?: string;
  log?: (msg: string) => void;
}) {
  const { account, cfg, runtime, commandText, channelId, senderId, senderName, teamId, log } =
    params;
  const core = getMattermostRuntime();

  // Resolve channel info
  const client = createMattermostClient({
    baseUrl: account.baseUrl ?? "",
    botToken: account.botToken ?? "",
  });

  let channelInfo: MattermostChannel | null = null;
  try {
    channelInfo = await fetchMattermostChannel(client, channelId);
  } catch {
    // continue without channel info
  }

  const channelType = channelInfo?.type ?? undefined;
  const isDirectMessage = channelType?.toUpperCase() === "D";
  const kind = isDirectMessage
    ? "direct"
    : channelType?.toUpperCase() === "G"
      ? "group"
      : "channel";
  const chatType =
    kind === "direct"
      ? ("direct" as const)
      : kind === "group"
        ? ("group" as const)
        : ("channel" as const);

  const channelName = channelInfo?.name ?? "";
  const channelDisplay = channelInfo?.display_name ?? channelName;
  const roomLabel = channelName ? `#${channelName}` : channelDisplay || `#${channelId}`;

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "mattermost",
    accountId: account.accountId,
    teamId,
    peer: {
      kind,
      id: kind === "direct" ? senderId : channelId,
    },
  });

  const fromLabel =
    kind === "direct"
      ? `Mattermost DM from ${senderName}`
      : `Mattermost message in ${roomLabel} from ${senderName}`;

  const to = kind === "direct" ? `user:${senderId}` : `channel:${channelId}`;

  // Build inbound context — the command text is the body
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: commandText,
    BodyForAgent: commandText,
    RawBody: commandText,
    CommandBody: commandText,
    From:
      kind === "direct"
        ? `mattermost:${senderId}`
        : kind === "group"
          ? `mattermost:group:${channelId}`
          : `mattermost:channel:${channelId}`,
    To: to,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    GroupSubject: kind !== "direct" ? channelDisplay || roomLabel : undefined,
    SenderName: senderName,
    SenderId: senderId,
    Provider: "mattermost" as const,
    Surface: "mattermost" as const,
    MessageSid: params.triggerId ?? `slash-${Date.now()}`,
    Timestamp: Date.now(),
    WasMentioned: true,
    CommandAuthorized: true, // Slash commands bypass mention requirements
    CommandSource: "native" as const,
    OriginatingChannel: "mattermost" as const,
    OriginatingTo: to,
  });

  const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "mattermost", account.accountId, {
    fallbackLimit: account.textChunkLimit ?? 4000,
  });
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "mattermost",
    accountId: account.accountId,
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "mattermost",
    accountId: account.accountId,
  });

  const typingCallbacks = createTypingCallbacks({
    start: () => sendMattermostTyping(client, { channelId }),
    onStartError: (err) => {
      logTypingFailure({
        log: (message) => log?.(message),
        channel: "mattermost",
        target: channelId,
        error: err,
      });
    },
  });

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
      deliver: async (payload: ReplyPayload) => {
        const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
        const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
        if (mediaUrls.length === 0) {
          const chunkMode = core.channel.text.resolveChunkMode(
            cfg,
            "mattermost",
            account.accountId,
          );
          const chunks = core.channel.text.chunkMarkdownTextWithMode(text, textLimit, chunkMode);
          for (const chunk of chunks.length > 0 ? chunks : [text]) {
            if (!chunk) continue;
            await sendMessageMattermost(to, chunk, {
              accountId: account.accountId,
            });
          }
        } else {
          let first = true;
          for (const mediaUrl of mediaUrls) {
            const caption = first ? text : "";
            first = false;
            await sendMessageMattermost(to, caption, {
              accountId: account.accountId,
              mediaUrl,
            });
          }
        }
        runtime.log?.(`delivered slash reply to ${to}`);
      },
      onError: (err, info) => {
        runtime.error?.(`mattermost slash ${info.kind} reply failed: ${String(err)}`);
      },
      onReplyStart: typingCallbacks.onReplyStart,
    });

  await core.channel.reply.dispatchReplyFromConfig({
    ctx: ctxPayload,
    cfg,
    dispatcher,
    replyOptions: {
      ...replyOptions,
      disableBlockStreaming:
        typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
      onModelSelected,
    },
  });
  markDispatchIdle();
}
