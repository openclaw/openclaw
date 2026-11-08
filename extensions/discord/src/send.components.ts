import { ChannelType } from "discord-api-types/v10";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { hasNonEmptyString, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { registerDiscordComponentEntries } from "./components-registry.js";
import {
  buildDiscordComponentMessage,
  resolveDiscordComponentAttachmentName,
  type DiscordComponentBuildResult,
  type DiscordComponentMessageSpec,
} from "./components.js";
import { createChannelMessage, editChannelMessage } from "./internal/api.messages.js";
import {
  serializePayload,
  type MessagePayloadFile,
  type MessagePayloadObject,
} from "./internal/payload.js";
import { withDiscordRequestAuthority } from "./internal/request-authority.js";
import { sendMessageDiscord } from "./send.outbound.js";
import { createDiscordSendResult } from "./send.receipt.js";
import {
  buildDiscordSendError,
  createDiscordClient,
  createDiscordMessageNonce,
  resolveChannelId,
  resolveDiscordChannel,
  SUPPRESS_NOTIFICATIONS_FLAG,
} from "./send.shared.js";
import type { DiscordSendResult } from "./send.types.js";
import { parseAndResolveDiscordTarget } from "./target-resolver.js";

const DISCORD_FORUM_LIKE_TYPES = new Set<number>([ChannelType.GuildForum, ChannelType.GuildMedia]);

function extractComponentAttachmentNames(spec: DiscordComponentMessageSpec): string[] {
  const names: string[] = [];
  for (const block of spec.blocks ?? []) {
    if (block.type === "file") {
      names.push(resolveDiscordComponentAttachmentName(block.file));
    }
  }
  return names;
}

function resolveClassicDiscordMessage(
  spec: DiscordComponentMessageSpec,
): { text: string; filename?: string } | undefined {
  if (spec.modal || spec.container) {
    return undefined;
  }
  const parts = hasNonEmptyString(spec.text) ? [spec.text] : [];
  // Only the leading text block can mirror the fallback caption. Later matching
  // blocks are authored content, so retain their repetitions and order.
  let captionToMatch: string | undefined = parts[0];
  let filename: string | undefined;
  for (const block of spec.blocks ?? []) {
    if (block.type === "text") {
      if (!hasNonEmptyString(block.text)) {
        continue;
      }
      if (block.text !== captionToMatch) {
        parts.push(block.text);
      }
      captionToMatch = undefined;
    } else if (block.type === "file" && !block.spoiler && filename === undefined) {
      filename = resolveDiscordComponentAttachmentName(block.file);
    } else {
      return undefined;
    }
  }
  return { text: parts.join("\n\n"), filename };
}

type DiscordComponentSendOpts = Omit<
  Parameters<typeof sendMessageDiscord>[2],
  "verbose" | "retry" | "components" | "embeds" | "threadId"
> & {
  sessionKey?: string;
  agentId?: string;
};

export function registerBuiltDiscordComponentMessage(params: {
  buildResult: DiscordComponentBuildResult;
  messageId: string;
  ttlMs?: number;
}): Promise<void> {
  return registerDiscordComponentEntries({
    entries: params.buildResult.entries,
    modals: params.buildResult.modals,
    messageId: params.messageId,
    ttlMs: params.ttlMs,
  });
}

export async function sendDiscordComponentMessage(
  to: string,
  spec: DiscordComponentMessageSpec,
  opts: DiscordComponentSendOpts,
): Promise<DiscordSendResult> {
  return await withDiscordRequestAuthority(opts.assertPlatformSendAuthorized, async () => {
    const classicMessage = opts.mediaUrl ? resolveClassicDiscordMessage(spec) : undefined;
    if (classicMessage) {
      return await sendMessageDiscord(to, classicMessage.text, {
        ...opts,
        filename: opts.filename?.trim() || classicMessage.filename,
      });
    }
    return await writeDiscordComponentMessage(to, spec, opts);
  });
}

export async function editDiscordComponentMessage(
  to: string,
  messageId: string,
  spec: DiscordComponentMessageSpec,
  opts: DiscordComponentSendOpts,
): Promise<DiscordSendResult> {
  return await writeDiscordComponentMessage(to, spec, opts, messageId);
}

async function writeDiscordComponentMessage(
  to: string,
  spec: DiscordComponentMessageSpec,
  opts: DiscordComponentSendOpts,
  messageId?: string,
): Promise<DiscordSendResult> {
  const creating = messageId === undefined;
  const cfg = requireRuntimeConfig(
    opts.cfg,
    creating ? "Discord component send" : "Discord component edit",
  );
  const { token, rest, request, account: accountInfo } = createDiscordClient({ ...opts, cfg });
  const recipient = await parseAndResolveDiscordTarget(
    to,
    { cfg, accountId: accountInfo.accountId },
    { defaultKind: "channel" },
  );
  const { channelId } = await resolveChannelId(rest, recipient, request);
  if (creating) {
    const channel = await resolveDiscordChannel(rest, channelId);
    if (channel && DISCORD_FORUM_LIKE_TYPES.has(channel.type)) {
      throw new Error("Discord components are not supported in forum-style channels");
    }
  }
  const messageReference = opts.reply
    ? { message_id: opts.reply.messageId, fail_if_not_exists: false }
    : undefined;

  let componentSpec = spec;
  let resolvedFileName: string | undefined;
  let files: MessagePayloadFile[] | undefined;
  let attachmentNames: string[] | undefined;
  if (opts.mediaUrl) {
    const media = await loadOutboundMediaFromUrl(opts.mediaUrl, {
      mediaAccess: opts.mediaAccess,
      mediaLocalRoots: opts.mediaLocalRoots,
      mediaReadFile: opts.mediaReadFile,
    });
    const filenameOverride = opts.filename?.trim();
    attachmentNames = extractComponentAttachmentNames(componentSpec);
    const explicitAttachmentName = attachmentNames[0];
    resolvedFileName =
      filenameOverride ||
      explicitAttachmentName ||
      media.fileName ||
      `upload${extensionForMime(media.contentType) ?? ""}`;
    if (attachmentNames.length === 0) {
      // An implicit File component must reference the uploaded filename.
      const file: `attachment://${string}` = `attachment://${resolvedFileName}`;
      componentSpec = {
        ...componentSpec,
        blocks: [...(componentSpec.blocks ?? []), { type: "file", file }],
      };
      attachmentNames = [resolveDiscordComponentAttachmentName(file)];
    }
    files = [{ data: media.buffer, name: resolvedFileName, contentType: media.contentType }];
  }

  const uniqueAttachmentNames = uniqueStrings(
    attachmentNames ?? extractComponentAttachmentNames(componentSpec),
  );
  if (uniqueAttachmentNames.length > 1) {
    throw new Error(
      "Discord component attachments currently support a single file. Use media-gallery for multiple files.",
    );
  }
  const expectedAttachmentName = uniqueAttachmentNames[0];
  if (expectedAttachmentName && resolvedFileName && expectedAttachmentName !== resolvedFileName) {
    throw new Error(
      `Component file block expects attachment "${expectedAttachmentName}", but the uploaded file is "${resolvedFileName}". Update components.blocks[].file or provide a matching filename.`,
    );
  }
  if (!opts.mediaUrl && expectedAttachmentName) {
    throw new Error(
      "Discord component file blocks require a media attachment (media/path/filePath).",
    );
  }

  const buildResult = buildDiscordComponentMessage({
    spec: componentSpec,
    sessionKey: opts.sessionKey,
    agentId: opts.agentId,
    accountId: accountInfo.accountId,
  });
  const payload: MessagePayloadObject = {
    components: buildResult.components,
    allowed_mentions: opts.allowedMentions,
    ...(opts.silent ? { flags: SUPPRESS_NOTIFICATIONS_FLAG } : {}),
    ...(files ? { files } : {}),
  };
  const componentBody = {
    ...serializePayload(payload),
    ...(messageReference ? { message_reference: messageReference } : {}),
  };
  // Nonce enforcement belongs to Create Message, not edits.
  const body = creating
    ? { ...componentBody, nonce: createDiscordMessageNonce(), enforce_nonce: true }
    : componentBody;
  let result: { id: string; channel_id: string };
  try {
    result = await request(
      async () => {
        if (messageId !== undefined) {
          return editChannelMessage(rest, channelId, messageId, { body });
        }
        await opts.onPlatformSendDispatch?.();
        opts.assertPlatformSendAuthorized?.();
        return createChannelMessage(rest, channelId, { body });
      },
      "components",
      creating ? { safety: "nonce-protected-create" } : undefined,
    );
  } catch (err) {
    throw await buildDiscordSendError(err, {
      channelId,
      cfg,
      rest,
      token,
      hasMedia: Boolean(opts.mediaUrl),
    });
  }

  const toDeliveryResult = () =>
    createDiscordSendResult({
      result: creating ? result : { id: result.id ?? messageId, channel_id: result.channel_id },
      fallbackChannelId: channelId,
      kind: "card",
      ...(opts.reply ? { reply: opts.reply } : {}),
    });
  const deliveryResult = creating ? toDeliveryResult() : undefined;
  if (deliveryResult) {
    await opts.onDeliveryResult?.(deliveryResult);
  }
  await registerBuiltDiscordComponentMessage({
    buildResult,
    messageId: result.id ?? messageId,
    ttlMs: accountInfo.config.agentComponents?.ttlMs,
  });
  recordChannelActivity({
    channel: "discord",
    accountId: accountInfo.accountId,
    direction: "outbound",
  });
  return deliveryResult ?? toDeliveryResult();
}
