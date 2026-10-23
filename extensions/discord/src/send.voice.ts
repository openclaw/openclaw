import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { MessageFlags } from "discord-api-types/v10";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  buildOutboundMediaLoadOptions,
  extensionForMime,
  maxBytesForKind,
  parseFfprobeCodecAndSampleRate,
  runFfmpeg,
  runFfprobe,
  MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS,
  unlinkIfExists,
} from "openclaw/plugin-sdk/media-runtime";
import { parseStrictFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import {
  readProviderJsonResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import { writeExternalFileWithinRoot } from "openclaw/plugin-sdk/security-runtime";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTempWorkspace, resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import {
  getDiscordEndpointRuntime,
  resolveDiscordEndpointAttachmentGuard,
} from "./endpoint-runtime.js";
import { parseDiscordHttpErrorBody } from "./error-body.js";
import { createChannelMessage } from "./internal/api.messages.js";
import { DiscordError, RateLimitError } from "./internal/discord.js";
import { withDiscordRequestAuthority } from "./internal/request-authority.js";
import { readDiscordMessage, readRetryAfter } from "./internal/rest-errors.js";
import { DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS } from "./monitor/timeouts.js";
import { classifyDiscordDeliveryFailure, recordDiscordMessageCreateAmbiguity } from "./retry.js";
import { createDiscordMessageNonce } from "./send.message-request.js";
import type { sendMessageDiscord } from "./send.outbound.js";
import { createDiscordSendResult } from "./send.receipt.js";
import { buildDiscordSendError, createDiscordClient, resolveChannelId } from "./send.shared.js";
import type { DiscordSendResult } from "./send.types.js";
import { parseAndResolveDiscordTarget } from "./target-resolver.js";

const WAVEFORM_SAMPLES = 256;
const DISCORD_OPUS_SAMPLE_RATE_HZ = 48_000;
const DISCORD_VOICE_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const DISCORD_VOICE_UPLOAD_SSRF_POLICY: SsrFPolicy = {
  allowRfc2544BenchmarkRange: true,
  allowIpv6UniqueLocalRange: true,
};

async function runFfmpegToOutput(
  inputPath: string,
  outputPath: string,
  outputArgs: string[],
): Promise<void> {
  const rootDir = path.dirname(outputPath);
  await fs.mkdir(rootDir, { recursive: true });
  await writeExternalFileWithinRoot({
    rootDir,
    path: path.basename(outputPath),
    write: async (tempPath) => {
      await runFfmpeg([
        "-y",
        "-i",
        inputPath,
        "-vn",
        "-sn",
        "-dn",
        "-t",
        String(MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS),
        ...outputArgs,
        tempPath,
      ]);
    },
  });
}

type VoiceMessageMetadata = {
  durationSecs: number;
  waveform: string; // base64 encoded
};

async function getAudioDuration(filePath: string): Promise<number> {
  try {
    const stdout = await runFfprobe([
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      filePath,
    ]);
    const duration = parseStrictFiniteNumber(stdout);
    if (duration === undefined) {
      throw new Error("Could not parse duration");
    }
    return Math.round(duration * 100) / 100;
  } catch (err) {
    const errMessage = formatErrorMessage(err);
    throw new Error(`Failed to get audio duration: ${errMessage}`, { cause: err });
  }
}

async function generateWaveformFromPcm(filePath: string): Promise<string> {
  const tempDir = resolvePreferredOpenClawTmpDir();
  const tempPcm = path.join(tempDir, `waveform-${crypto.randomUUID()}.raw`);

  try {
    await runFfmpegToOutput(filePath, tempPcm, [
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "-ac",
      "1",
      "-ar",
      "8000",
    ]);

    const pcmData = await fs.readFile(tempPcm);
    const samples = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength / 2);

    const step = Math.max(1, Math.floor(samples.length / WAVEFORM_SAMPLES));
    const waveform = Buffer.alloc(WAVEFORM_SAMPLES);

    for (let i = 0; i < WAVEFORM_SAMPLES && i * step < samples.length; i++) {
      let sum = 0;
      const count = Math.min(step, samples.length - i * step);
      for (let j = 0; j < count; j++) {
        sum += Math.abs(expectDefined(samples.at(i * step + j), "bounded PCM waveform sample"));
      }
      const avg = sum / count;
      // Normalize to 0-255 (16-bit signed max is 32767)
      const normalized = Math.min(255, Math.round((avg / 32767) * 255));
      waveform[i] = normalized;
    }

    return waveform.toString("base64");
  } finally {
    await unlinkIfExists(tempPcm);
  }
}

function generatePlaceholderWaveform(): string {
  const waveform: number[] = [];
  for (let i = 0; i < WAVEFORM_SAMPLES; i++) {
    const value = Math.round(128 + 64 * Math.sin((i / WAVEFORM_SAMPLES) * Math.PI * 8));
    waveform.push(Math.min(255, Math.max(0, value)));
  }
  return Buffer.from(waveform).toString("base64");
}

/**
 * Convert audio file to OGG/Opus format if needed
 * Returns path to the OGG file (may be same as input if already OGG/Opus)
 */
async function ensureOggOpus(filePath: string): Promise<{ path: string; cleanup: boolean }> {
  const trimmed = filePath.trim();
  // Defense-in-depth: callers should never hand ffmpeg/ffprobe a URL/protocol path.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new Error(
      `Voice message conversion requires a local file path; received a URL/protocol source: ${trimmed}`,
    );
  }

  const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));

  if (ext === ".ogg") {
    // Fast-path only when the file is Opus at Discord's expected 48kHz.
    try {
      const stdout = await runFfprobe([
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_name,sample_rate",
        "-of",
        "csv=p=0",
        filePath,
      ]);
      const { codec, sampleRateHz } = parseFfprobeCodecAndSampleRate(stdout);
      if (codec === "opus" && sampleRateHz === DISCORD_OPUS_SAMPLE_RATE_HZ) {
        return { path: filePath, cleanup: false };
      }
    } catch {
      // If probe fails, convert anyway
    }
  }

  // Always resample to 48kHz to ensure Discord voice messages play at correct speed
  // (Discord expects 48kHz; lower sample rates like 24kHz from some TTS providers cause 0.5x playback)
  const tempDir = resolvePreferredOpenClawTmpDir();
  const outputPath = path.join(tempDir, `voice-${crypto.randomUUID()}.ogg`);

  await runFfmpegToOutput(filePath, outputPath, [
    "-ar",
    String(DISCORD_OPUS_SAMPLE_RATE_HZ),
    "-c:a",
    "libopus",
    "-b:a",
    "64k",
    "-f",
    "ogg",
  ]);

  return { path: outputPath, cleanup: true };
}

/**
 * Wait for waveform cleanup before callers can release the audio input.
 */
async function getVoiceMessageMetadata(filePath: string): Promise<VoiceMessageMetadata> {
  const waveform = generateWaveformFromPcm(filePath).catch(generatePlaceholderWaveform);
  try {
    return { durationSecs: await getAudioDuration(filePath), waveform: await waveform };
  } finally {
    await waveform;
  }
}

type UploadUrlResponse = {
  attachments: Array<{
    id: number;
    upload_url: string;
    upload_filename: string;
  }>;
};

async function createVoiceRequestError(
  response: Response,
  fallbackMessage: string,
): Promise<Error> {
  const raw = await readResponseTextLimited(response, DISCORD_VOICE_ERROR_BODY_LIMIT_BYTES).catch(
    () => "",
  );
  const parsed = parseDiscordHttpErrorBody(raw);
  if (response.status === 429) {
    throw new RateLimitError(response, {
      message: readDiscordMessage(parsed, "You are being rate limited."),
      retry_after: readRetryAfter(parsed, response),
      global:
        parsed && typeof parsed === "object" && "global" in parsed ? Boolean(parsed.global) : false,
    });
  }
  return new DiscordError(
    response,
    parsed ?? {
      message: fallbackMessage,
    },
  );
}

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
          const recipient = await parseAndResolveDiscordTarget(
            to,
            { cfg, accountId: accountInfo.accountId },
            { defaultKind: "channel" },
          );
          const resolvedChannelId = (await resolveChannelId(rest, recipient, request)).channelId;
          channelId = resolvedChannelId;

          ogg = await ensureOggOpus(localInputPath);

          const metadata = await getVoiceMessageMetadata(ogg.path);
          const audioBuffer = await fs.readFile(ogg.path);
          const filename = "voice-message.ogg";
          // Capture the environment-selected endpoint for the whole retrying operation.
          const endpointRuntime = getDiscordEndpointRuntime() ?? null;

          // RequestClient auto-converts "files" bodies to multipart/form-data, but Discord's
          // /attachments endpoint expects JSON, so this path uses a guarded raw HTTP call.
          if (!token) {
            throw new Error("Discord bot token is required for voice message upload");
          }
          const { upload_filename } = await request(async () => {
            let uploadUrlResponse: UploadUrlResponse;
            const uploadApiBaseUrl =
              endpointRuntime?.descriptor.restApiBaseUrl ??
              rest.options?.baseUrl ??
              "https://discord.com/api";
            const url = `${uploadApiBaseUrl}/channels/${channelId}/attachments`;
            const uploadUrlInit: RequestInit = {
              method: "POST",
              headers: {
                Authorization: `Bot ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                files: [{ filename, file_size: audioBuffer.byteLength, id: "0" }],
              }),
            };
            const endpointResponse = endpointRuntime
              ? {
                  response: await endpointRuntime.fetch(url, {
                    ...uploadUrlInit,
                    signal: AbortSignal.timeout(rest.options.timeout),
                  }),
                  release: async () => {},
                }
              : await fetchWithSsrFGuard({
                  url,
                  init: uploadUrlInit,
                  // Keep control-plane negotiation on the REST budget; the binary upload below
                  // needs the longer attachment-transfer budget.
                  timeoutMs: rest.options.timeout,
                  policy: DISCORD_VOICE_UPLOAD_SSRF_POLICY,
                  auditContext: "discord.voice.upload-url",
                });
            const { response: res, release: releaseNegotiation } = endpointResponse;
            try {
              if (!res.ok) {
                throw await createVoiceRequestError(res, "Upload URL request failed");
              }
              uploadUrlResponse = await readProviderJsonResponse<UploadUrlResponse>(
                res,
                "discord.voice.upload-url",
              );
            } finally {
              await releaseNegotiation();
            }

            if (!uploadUrlResponse.attachments?.[0]) {
              throw new Error("Failed to get upload URL for voice message");
            }

            const attachment = uploadUrlResponse.attachments[0];
            const endpointGuard = resolveDiscordEndpointAttachmentGuard(
              attachment.upload_url,
              endpointRuntime,
            );
            const { response: uploadResponse, release: releaseUpload } = await fetchWithSsrFGuard({
              url: attachment.upload_url,
              init: {
                method: "PUT",
                headers: {
                  "Content-Type": "audio/ogg",
                },
                body: new Uint8Array(audioBuffer),
              },
              timeoutMs: DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS,
              policy: endpointGuard?.policy ?? DISCORD_VOICE_UPLOAD_SSRF_POLICY,
              ...(endpointGuard
                ? {
                    maxRedirects: endpointGuard.maxRedirects,
                    requireHttps: endpointGuard.requireHttps,
                  }
                : {}),
              auditContext: "discord.voice.attachment-upload",
            });

            try {
              if (!uploadResponse.ok) {
                throw await createVoiceRequestError(
                  uploadResponse,
                  "Failed to upload voice message",
                );
              }
              await uploadResponse.body?.cancel().catch(() => undefined);
            } finally {
              await releaseUpload();
            }
            return attachment;
          }, "voice-upload");

          const flags =
            MessageFlags.IsVoiceMessage | (opts.silent ? MessageFlags.SuppressNotifications : 0);
          const messagePayload = {
            flags,
            nonce: createDiscordMessageNonce(),
            enforce_nonce: true,
            attachments: [
              {
                id: "0",
                filename,
                uploaded_filename: upload_filename,
                duration_secs: metadata.durationSecs,
                waveform: metadata.waveform,
              },
            ],
            ...(opts.reply?.messageId
              ? {
                  message_reference: {
                    message_id: opts.reply.messageId,
                    fail_if_not_exists: false,
                  },
                }
              : {}),
          };

          let result: { id: string; channel_id: string };
          let messageCreateMayHaveCommitted = false;
          try {
            result = await request(
              async () => {
                await opts.onPlatformSendDispatch?.();
                opts.assertPlatformSendAuthorized?.();
                try {
                  return await createChannelMessage(rest, resolvedChannelId, {
                    body: messagePayload,
                  });
                } catch (error) {
                  messageCreateMayHaveCommitted ||=
                    classifyDiscordDeliveryFailure(error) === "ambiguous";
                  throw error;
                }
              },
              "voice-message",
              { safety: "nonce-protected-create" },
            );
          } catch (error) {
            // Only this final request can commit a message; upload/preflight failures cannot.
            if (messageCreateMayHaveCommitted) {
              recordDiscordMessageCreateAmbiguity(error);
            }
            throw error;
          }

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
