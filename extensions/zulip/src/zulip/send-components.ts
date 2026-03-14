import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { getZulipRuntime } from "../runtime.js";
import { resolveZulipAccount } from "./accounts.js";
import {
  createZulipClient,
  normalizeZulipBaseUrl,
  sendZulipDirectMessageWithWidget,
  sendZulipStreamMessageWithWidget,
  uploadZulipFile,
} from "./client.js";
import { registerZulipComponentEntries } from "./components-registry.js";
import { buildZulipWidgetContent, type ZulipComponentSpec } from "./components.js";
import { resolveZulipTargetForSend, sendMessageZulip, type ZulipSendResult } from "./send.js";

export type ZulipComponentSendOpts = {
  cfg?: OpenClawConfig;
  accountId?: string;
  mediaUrl?: string;
  replyToTopic?: string;
  sessionKey?: string;
  agentId?: string;
  callbackExpiresAtMs?: number;
};

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function buildFallbackText(text: string, spec: ZulipComponentSpec): string {
  const lines: string[] = [];
  const trimmedText = text.trim();
  if (trimmedText) {
    lines.push(trimmedText);
  }
  const heading = spec.heading?.trim();
  if (heading) {
    lines.push(`### ${heading}`);
  }
  for (const button of spec.buttons) {
    lines.push(`- ${button.label}`);
  }
  return lines.join("\n");
}

function resolveMessageContent(text: string, spec: ZulipComponentSpec): string {
  const trimmed = text.trim();
  if (trimmed) {
    return trimmed;
  }
  const heading = spec.heading?.trim();
  if (heading) {
    return `### ${heading}`;
  }
  return "Choose an option:";
}

function normalizeReplyTarget(
  target: Awaited<ReturnType<typeof resolveZulipTargetForSend>>,
  replyToTopic?: string,
): { replyTo: string; chatType: "channel" | "direct" } {
  if (target.kind === "stream") {
    return {
      replyTo: `stream:${target.stream}:topic:${replyToTopic ?? target.topic}`,
      chatType: "channel",
    };
  }
  return {
    replyTo: `dm:${target.userIds.join(",")}`,
    chatType: "direct",
  };
}

export async function sendZulipComponentMessage(
  to: string,
  text: string,
  spec: ZulipComponentSpec,
  opts: ZulipComponentSendOpts = {},
): Promise<ZulipSendResult> {
  const core = getZulipRuntime();
  const logger = core.logging.getChildLogger({ module: "zulip" });
  const cfg = opts.cfg ?? core.config.loadConfig();
  const account = resolveZulipAccount({ cfg, accountId: opts.accountId });

  if (!account.config.widgetsEnabled || !opts.sessionKey?.trim() || !opts.agentId?.trim()) {
    if (account.config.widgetsEnabled && (!opts.sessionKey?.trim() || !opts.agentId?.trim())) {
      logger.debug?.(
        "zulip component send: widgets enabled but sessionKey/agentId missing, degrading to text",
      );
    }
    return await sendMessageZulip(to, buildFallbackText(text, spec), {
      cfg,
      accountId: account.accountId,
      mediaUrl: opts.mediaUrl,
      replyToTopic: opts.replyToTopic,
    });
  }

  const botEmail = account.botEmail?.trim();
  const botApiKey = account.botApiKey?.trim();
  if (!botEmail || !botApiKey) {
    throw new Error(`Zulip bot credentials missing for account "${account.accountId}"`);
  }
  const baseUrl = normalizeZulipBaseUrl(account.baseUrl);
  if (!baseUrl) {
    throw new Error(`Zulip baseUrl missing for account "${account.accountId}"`);
  }

  const client = createZulipClient({ baseUrl, botEmail, botApiKey });
  const target = await resolveZulipTargetForSend({
    to,
    replyToTopic: opts.replyToTopic,
    accountStreams: account.config.streams,
    client,
  });
  const { replyTo, chatType } = normalizeReplyTarget(target, opts.replyToTopic);

  let message = resolveMessageContent(text, spec);
  const mediaUrl = opts.mediaUrl?.trim();
  if (mediaUrl) {
    try {
      const media = await core.media.loadWebMedia(mediaUrl);
      const uri = await uploadZulipFile(client, {
        buffer: media.buffer,
        fileName: media.fileName ?? "upload",
        contentType: media.contentType ?? undefined,
      });
      const fullUrl = uri.startsWith("http") ? uri : `${baseUrl}${uri}`;
      message = [message, `[${media.fileName ?? "attachment"}](${fullUrl})`].join("\n");
    } catch (err) {
      if (core.logging.shouldLogVerbose()) {
        logger.debug?.(`zulip component send: media upload failed, falling back: ${String(err)}`);
      }
      if (isHttpUrl(mediaUrl)) {
        message = [message, mediaUrl].join("\n");
      }
    }
  }

  const buildResult = buildZulipWidgetContent({
    spec,
    sessionKey: opts.sessionKey.trim(),
    agentId: opts.agentId.trim(),
    accountId: account.accountId,
    replyTo,
    chatType,
  });

  const response =
    target.kind === "stream"
      ? await sendZulipStreamMessageWithWidget(client, {
          stream: target.stream,
          topic: opts.replyToTopic ?? target.topic,
          content: message,
          widgetContent: JSON.stringify(buildResult.widgetContent),
        })
      : await sendZulipDirectMessageWithWidget(client, {
          to: target.userIds,
          content: message,
          widgetContent: JSON.stringify(buildResult.widgetContent),
        });

  await registerZulipComponentEntries({
    entries: buildResult.entries,
    messageId: response.id,
    callbackExpiresAtMs: opts.callbackExpiresAtMs,
  });

  core.channel.activity.record({
    channel: "zulip",
    accountId: account.accountId,
    direction: "outbound",
  });

  return {
    messageId: String(response.id ?? "unknown"),
    target: replyTo,
  };
}
