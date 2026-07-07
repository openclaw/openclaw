// Googlechat plugin module implements actions behavior.
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { listEnabledGoogleChatAccounts, resolveGoogleChatAccount } from "./accounts.js";
import { sendGoogleChatMessage, uploadGoogleChatAttachment } from "./api.js";
import { getGoogleChatRuntime } from "./runtime.js";
import { resolveGoogleChatOutboundSpace } from "./targets.js";

const providerId = "googlechat";

function listEnabledAccounts(cfg: OpenClawConfig) {
  return listEnabledGoogleChatAccounts(cfg).filter(
    (account) => account.enabled && account.credentialSource !== "none",
  );
}

async function loadGoogleChatActionMedia(params: {
  mediaUrl: string;
  maxBytes: number;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
}) {
  const runtime = getGoogleChatRuntime();
  return /^https?:\/\//i.test(params.mediaUrl)
    ? await runtime.channel.media.readRemoteMediaBuffer({
        url: params.mediaUrl,
        maxBytes: params.maxBytes,
      })
    : await loadOutboundMediaFromUrl(params.mediaUrl, {
        maxBytes: params.maxBytes,
        mediaAccess: params.mediaAccess,
        mediaLocalRoots: params.mediaLocalRoots,
        mediaReadFile: params.mediaReadFile,
      });
}

export const googlechatMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId }) => {
    const accounts = accountId
      ? [resolveGoogleChatAccount({ cfg, accountId })].filter(
          (account) => account.enabled && account.credentialSource !== "none",
        )
      : listEnabledAccounts(cfg);
    if (accounts.length === 0) {
      return null;
    }
    return { actions: ["send", "upload-file"] };
  },
  extractToolSend: ({ args }) => {
    return extractToolSend(args, "sendMessage");
  },
  handleAction: async ({
    action,
    params,
    cfg,
    accountId,
    mediaAccess,
    mediaLocalRoots,
    mediaReadFile,
  }) => {
    const account = resolveGoogleChatAccount({
      cfg,
      accountId,
    });
    if (account.credentialSource === "none") {
      throw new Error("Google Chat credentials are missing.");
    }

    if (action === "send" || action === "upload-file") {
      const to = readStringParam(params, "to", { required: true });
      const content =
        readStringParam(params, "message", {
          required: action === "send",
          allowEmpty: true,
        }) ??
        readStringParam(params, "initialComment", {
          allowEmpty: true,
        }) ??
        "";
      const mediaUrl =
        readStringParam(params, "media", { trim: false }) ??
        readStringParam(params, "filePath", { trim: false }) ??
        readStringParam(params, "path", { trim: false });
      const threadId = readStringParam(params, "threadId") ?? readStringParam(params, "replyTo");
      const space = await resolveGoogleChatOutboundSpace({ account, target: to });

      if (mediaUrl) {
        const maxBytes = (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
        const loaded = await loadGoogleChatActionMedia({
          mediaUrl,
          maxBytes,
          mediaAccess,
          mediaLocalRoots,
          mediaReadFile,
        });
        const uploadFileName =
          readStringParam(params, "filename") ??
          readStringParam(params, "title") ??
          loaded.fileName ??
          "attachment";
        const upload = await uploadGoogleChatAttachment({
          account,
          space,
          filename: uploadFileName,
          buffer: loaded.buffer,
          contentType: loaded.contentType,
        });
        const sent = await sendGoogleChatMessage({
          account,
          space,
          text: content,
          thread: threadId ?? undefined,
          attachments: upload.attachmentUploadToken
            ? [
                {
                  attachmentUploadToken: upload.attachmentUploadToken,
                  contentName: uploadFileName,
                },
              ]
            : undefined,
        });
        return jsonResult({ ok: true, to: space, ...sent });
      }

      if (action === "upload-file") {
        throw new Error("upload-file requires media, filePath, or path");
      }

      const sent = await sendGoogleChatMessage({
        account,
        space,
        text: content,
        thread: threadId ?? undefined,
      });
      return jsonResult({ ok: true, to: space, ...sent });
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
