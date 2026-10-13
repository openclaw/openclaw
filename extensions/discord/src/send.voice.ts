import fs from "node:fs/promises";
import path from "node:path";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import {
  buildOutboundMediaLoadOptions,
  extensionForMime,
  maxBytesForKind,
  unlinkIfExists,
} from "openclaw/plugin-sdk/media-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { withTempWorkspace, resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import { withDiscordRequestAuthority } from "./internal/request-authority.js";
import { parseAndResolveChannelRecipient } from "./recipient-resolution.js";
import type { sendMessageDiscord } from "./send.outbound.js";
import { createDiscordSendResult } from "./send.receipt.js";
import { buildDiscordSendError, createDiscordClient, resolveChannelId } from "./send.shared.js";
import type { DiscordSendResult } from "./send.types.js";
import {
  ensureOggOpus,
  getVoiceMessageMetadata,
  sendDiscordVoiceMessage,
} from "./voice-message.js";

type VoiceMessageOpts = Pick<
  Parameters<typeof sendMessageDiscord>[2],
  | "cfg"
  | "token"
  | "accountId"
  | "verbose"
  | "rest"
  | "reply"
  | "retry"
  | "silent"
  | "mediaAccess"
  | "mediaLocalRoots"
  | "mediaReadFile"
  | "onPlatformSendDispatch"
  | "assertPlatformSendAuthorized"
>;

/** Discord voice messages require OGG/Opus audio with a waveform and cannot include text. */
export async function sendVoiceMessageDiscord(
  to: string,
  audioPath: string,
  opts: VoiceMessageOpts,
): Promise<DiscordSendResult> {
  return await withDiscordRequestAuthority(opts.assertPlatformSendAuthorized, async () => {
    const cfg = requireRuntimeConfig(opts.cfg, "Discord voice send");
    // Security: reuse the standard media loader so we apply SSRF guards + allowed-local-root checks.
    // Then write to a private temp file so ffmpeg/ffprobe never sees the original URL/path string.
    const media = await loadWebMediaRaw(
      audioPath,
      buildOutboundMediaLoadOptions({
        maxBytes: maxBytesForKind("audio"),
        mediaAccess: opts.mediaAccess,
        mediaLocalRoots: opts.mediaLocalRoots,
        mediaReadFile: opts.mediaReadFile,
      }),
    );
    const extFromName = media.fileName ? path.extname(media.fileName) : "";
    const extFromMime = media.contentType ? extensionForMime(media.contentType) : "";
    const ext = extFromName || extFromMime || ".bin";
    return await withTempWorkspace(
      {
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "voice-src-",
      },
      async (workspace) => {
        const localInputPath = await workspace.write(`input${ext}`, media.buffer);
        let ogg: Awaited<ReturnType<typeof ensureOggOpus>> | undefined;
        let client: ReturnType<typeof createDiscordClient> | undefined;
        let channelId: string | undefined;

        try {
          client = createDiscordClient({ ...opts, cfg });
          const { token, rest, request, account: accountInfo } = client;
          const recipient = await parseAndResolveChannelRecipient(to, cfg, accountInfo.accountId);
          channelId = (await resolveChannelId(rest, recipient, request)).channelId;

          ogg = await ensureOggOpus(localInputPath);

          const metadata = await getVoiceMessageMetadata(ogg.path);
          const audioBuffer = await fs.readFile(ogg.path);
          const result = await sendDiscordVoiceMessage(
            rest,
            channelId,
            audioBuffer,
            metadata,
            opts.reply?.messageId,
            request,
            opts.silent,
            token,
            opts.onPlatformSendDispatch,
            opts.assertPlatformSendAuthorized,
          );

          recordChannelActivity({
            channel: "discord",
            accountId: accountInfo.accountId,
            direction: "outbound",
          });

          return createDiscordSendResult({
            result,
            fallbackChannelId: channelId,
            kind: "voice",
            reply: opts.reply,
          });
        } catch (err) {
          if (channelId && client?.rest && client.token) {
            throw await buildDiscordSendError(err, {
              channelId,
              cfg,
              rest: client.rest,
              token: client.token,
              hasMedia: true,
            });
          }
          throw err;
        } finally {
          await unlinkIfExists(ogg?.cleanup ? ogg.path : null);
        }
      },
    );
  });
}
