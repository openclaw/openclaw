import {
  jsonResult,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveGoogleChatAccount } from "./accounts.js";
import { sendGoogleChatMessage, updateGoogleChatMessage } from "./api.js";
import { formatGoogleChatMediaText } from "./format.js";
import { resolveGoogleChatOutboundSpace } from "./targets.js";

const OUTBOUND_MEDIA_KEYS = ["media", "mediaUrl", "path", "filePath", "fileUrl"] as const;
const STRUCTURED_ATTACHMENT_MEDIA_KEYS = [...OUTBOUND_MEDIA_KEYS, "url"] as const;

function readGoogleChatMediaUrls(params: Record<string, unknown>): string[] {
  return [
    ...OUTBOUND_MEDIA_KEYS.map((key) => readStringParam(params, key)),
    ...(readStringArrayParam(params, "mediaUrls") ?? []),
    ...(Array.isArray(params.attachments) ? params.attachments : []).flatMap((attachment) =>
      isRecord(attachment)
        ? STRUCTURED_ATTACHMENT_MEDIA_KEYS.map((key) => readStringParam(attachment, key))
        : [],
    ),
  ].filter((value): value is string => value !== undefined);
}

export async function handleGoogleChatAction({
  action,
  params,
  cfg,
  accountId,
  assertDirectAdapterHandoff,
  onPlatformSendDispatch,
}: ChannelMessageActionContext) {
  if (action === "upload-file") {
    throw new Error(
      "Google Chat outbound attachments require user OAuth and are not supported by this service-account channel.",
    );
  }

  const mediaUrls = action === "send" ? readGoogleChatMediaUrls(params) : [];
  const content =
    action === "send"
      ? formatGoogleChatMediaText(
          readStringParam(params, "message", {
            required: mediaUrls.length === 0,
            allowEmpty: true,
          }),
          mediaUrls,
        )
      : "";

  const account = resolveGoogleChatAccount({
    cfg,
    accountId,
  });
  if (account.credentialSource === "none" || account.tokenStatus === "configured_unavailable") {
    throw new Error("Google Chat credentials are missing.");
  }

  if (action === "send") {
    const to = readStringParam(params, "to", { required: true });
    const threadId = readStringParam(params, "threadId") ?? readStringParam(params, "replyTo");
    const space = await resolveGoogleChatOutboundSpace({
      account,
      target: to,
      assertDirectAdapterHandoff,
    });

    const sent = await sendGoogleChatMessage({
      account,
      space,
      text: content,
      thread: threadId,
      assertDirectAdapterHandoff,
      onPlatformSendDispatch,
    });
    return jsonResult({ ok: true, to: space, ...sent });
  }

  if (action === "edit") {
    if (!account.enabled) {
      throw new Error("Google Chat account is disabled.");
    }
    const to = readStringParam(params, "to", { required: true });
    const messageName = readStringParam(params, "messageId", { required: true });
    const text = readStringParam(params, "message", { required: true, trim: false });
    const match = /^(spaces\/[A-Za-z0-9_-]+)\/messages\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/.exec(
      messageName,
    );
    if (!match) {
      throw new Error(
        "messageId must be a Google Chat resource name: spaces/<space>/messages/<message>.",
      );
    }
    const space = await resolveGoogleChatOutboundSpace({
      account,
      target: to,
      assertDirectAdapterHandoff,
    });
    if (match[1] !== space) {
      throw new Error("messageId must belong to the target Google Chat space");
    }
    const updated = await updateGoogleChatMessage({
      account,
      messageName,
      text,
      assertDirectAdapterHandoff,
      onPlatformSendDispatch,
    });
    return jsonResult({ ok: true, to: space, ...updated });
  }

  throw new Error(`Action ${action} is not supported for provider googlechat.`);
}
