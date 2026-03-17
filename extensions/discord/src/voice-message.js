import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { RateLimitError } from "@buape/carbon";
import { resolvePreferredOpenClawTmpDir } from "../../../src/infra/tmp-openclaw-dir.js";
import {
  parseFfprobeCodecAndSampleRate,
  runFfmpeg,
  runFfprobe
} from "../../../src/media/ffmpeg-exec.js";
import { MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS } from "../../../src/media/ffmpeg-limits.js";
import { unlinkIfExists } from "../../../src/media/temp-files.js";
const DISCORD_VOICE_MESSAGE_FLAG = 1 << 13;
const SUPPRESS_NOTIFICATIONS_FLAG = 1 << 12;
const WAVEFORM_SAMPLES = 256;
const DISCORD_OPUS_SAMPLE_RATE_HZ = 48e3;
async function getAudioDuration(filePath) {
  try {
    const stdout = await runFfprobe([
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      filePath
    ]);
    const duration = parseFloat(stdout.trim());
    if (isNaN(duration)) {
      throw new Error("Could not parse duration");
    }
    return Math.round(duration * 100) / 100;
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to get audio duration: ${errMessage}`, { cause: err });
  }
}
async function generateWaveform(filePath) {
  try {
    return await generateWaveformFromPcm(filePath);
  } catch {
    return generatePlaceholderWaveform();
  }
}
async function generateWaveformFromPcm(filePath) {
  const tempDir = resolvePreferredOpenClawTmpDir();
  const tempPcm = path.join(tempDir, `waveform-${crypto.randomUUID()}.raw`);
  try {
    await runFfmpeg([
      "-y",
      "-i",
      filePath,
      "-vn",
      "-sn",
      "-dn",
      "-t",
      String(MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS),
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "-ac",
      "1",
      "-ar",
      "8000",
      tempPcm
    ]);
    const pcmData = await fs.readFile(tempPcm);
    const samples = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength / 2);
    const step = Math.max(1, Math.floor(samples.length / WAVEFORM_SAMPLES));
    const waveform = [];
    for (let i = 0; i < WAVEFORM_SAMPLES && i * step < samples.length; i++) {
      let sum = 0;
      let count = 0;
      for (let j = 0; j < step && i * step + j < samples.length; j++) {
        sum += Math.abs(samples[i * step + j]);
        count++;
      }
      const avg = count > 0 ? sum / count : 0;
      const normalized = Math.min(255, Math.round(avg / 32767 * 255));
      waveform.push(normalized);
    }
    while (waveform.length < WAVEFORM_SAMPLES) {
      waveform.push(0);
    }
    return Buffer.from(waveform).toString("base64");
  } finally {
    await unlinkIfExists(tempPcm);
  }
}
function generatePlaceholderWaveform() {
  const waveform = [];
  for (let i = 0; i < WAVEFORM_SAMPLES; i++) {
    const value = Math.round(128 + 64 * Math.sin(i / WAVEFORM_SAMPLES * Math.PI * 8));
    waveform.push(Math.min(255, Math.max(0, value)));
  }
  return Buffer.from(waveform).toString("base64");
}
async function ensureOggOpus(filePath) {
  const trimmed = filePath.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new Error(
      `Voice message conversion requires a local file path; received a URL/protocol source: ${trimmed}`
    );
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".ogg") {
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
        filePath
      ]);
      const { codec, sampleRateHz } = parseFfprobeCodecAndSampleRate(stdout);
      if (codec === "opus" && sampleRateHz === DISCORD_OPUS_SAMPLE_RATE_HZ) {
        return { path: filePath, cleanup: false };
      }
    } catch {
    }
  }
  const tempDir = resolvePreferredOpenClawTmpDir();
  const outputPath = path.join(tempDir, `voice-${crypto.randomUUID()}.ogg`);
  await runFfmpeg([
    "-y",
    "-i",
    filePath,
    "-vn",
    "-sn",
    "-dn",
    "-t",
    String(MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS),
    "-ar",
    String(DISCORD_OPUS_SAMPLE_RATE_HZ),
    "-c:a",
    "libopus",
    "-b:a",
    "64k",
    outputPath
  ]);
  return { path: outputPath, cleanup: true };
}
async function getVoiceMessageMetadata(filePath) {
  const [durationSecs, waveform] = await Promise.all([
    getAudioDuration(filePath),
    generateWaveform(filePath)
  ]);
  return { durationSecs, waveform };
}
async function sendDiscordVoiceMessage(rest, channelId, audioBuffer, metadata, replyTo, request, silent, token) {
  const filename = "voice-message.ogg";
  const fileSize = audioBuffer.byteLength;
  const botToken = token;
  if (!botToken) {
    throw new Error("Discord bot token is required for voice message upload");
  }
  const uploadUrlResponse = await request(async () => {
    const url = `${rest.options?.baseUrl ?? "https://discord.com/api"}/channels/${channelId}/attachments`;
    const res2 = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        files: [{ filename, file_size: fileSize, id: "0" }]
      })
    });
    if (!res2.ok) {
      if (res2.status === 429) {
        const retryData = await res2.json().catch(() => ({}));
        throw new RateLimitError(res2, {
          message: retryData.message ?? "You are being rate limited.",
          retry_after: retryData.retry_after ?? 1,
          global: retryData.global ?? false
        });
      }
      const errorBody = await res2.json().catch(() => null);
      const err = new Error(`Upload URL request failed: ${res2.status} ${errorBody?.message ?? ""}`);
      if (errorBody?.code !== void 0) {
        err.code = errorBody.code;
      }
      throw err;
    }
    return await res2.json();
  }, "voice-upload-url");
  if (!uploadUrlResponse.attachments?.[0]) {
    throw new Error("Failed to get upload URL for voice message");
  }
  const { upload_url, upload_filename } = uploadUrlResponse.attachments[0];
  const uploadResponse = await fetch(upload_url, {
    method: "PUT",
    headers: {
      "Content-Type": "audio/ogg"
    },
    body: new Uint8Array(audioBuffer)
  });
  if (!uploadResponse.ok) {
    throw new Error(`Failed to upload voice message: ${uploadResponse.status}`);
  }
  const flags = silent ? DISCORD_VOICE_MESSAGE_FLAG | SUPPRESS_NOTIFICATIONS_FLAG : DISCORD_VOICE_MESSAGE_FLAG;
  const messagePayload = {
    flags,
    attachments: [
      {
        id: "0",
        filename,
        uploaded_filename: upload_filename,
        duration_secs: metadata.durationSecs,
        waveform: metadata.waveform
      }
    ]
  };
  if (replyTo) {
    messagePayload.message_reference = {
      message_id: replyTo,
      fail_if_not_exists: false
    };
  }
  const res = await request(
    () => rest.post(`/channels/${channelId}/messages`, {
      body: messagePayload
    }),
    "voice-message"
  );
  return res;
}
export {
  ensureOggOpus,
  generateWaveform,
  getAudioDuration,
  getVoiceMessageMetadata,
  sendDiscordVoiceMessage
};
