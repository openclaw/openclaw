import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  CHROMIUM_FULL_VERSION,
  TRUSTED_CLIENT_TOKEN,
  generateSecMsGecToken,
} from "node-edge-tts/dist/drm.js";
import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/core";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/llm-task";
import { isVoiceCompatibleAudio } from "openclaw/plugin-sdk/media-runtime";
import type { SpeechVoiceOption } from "openclaw/plugin-sdk/speech";
import { edgeTTS, inferEdgeExtension } from "./tts.js";

const DEFAULT_EDGE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

type MicrosoftVoiceListEntry = {
  ShortName?: string;
  FriendlyName?: string;
  Locale?: string;
  Gender?: string;
  VoiceTag?: {
    ContentCategories?: string[];
    VoicePersonalities?: string[];
  };
};

function buildMicrosoftVoiceHeaders(): Record<string, string> {
  const major = CHROMIUM_FULL_VERSION.split(".")[0] || "0";
  return {
    Authority: "speech.platform.bing.com",
    Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    Accept: "*/*",
    "User-Agent":
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
    "Sec-MS-GEC": generateSecMsGecToken(),
    "Sec-MS-GEC-Version": `1-${CHROMIUM_FULL_VERSION}`,
  };
}

function formatMicrosoftVoiceDescription(entry: MicrosoftVoiceListEntry): string | undefined {
  const personalities = entry.VoiceTag?.VoicePersonalities?.filter(Boolean) ?? [];
  return personalities.length > 0 ? personalities.join(", ") : undefined;
}

export async function listMicrosoftVoices(): Promise<SpeechVoiceOption[]> {
  const response = await fetch(
    "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list" +
      `?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`,
    {
      headers: buildMicrosoftVoiceHeaders(),
    },
  );
  if (!response.ok) {
    throw new Error(`Microsoft voices API error (${response.status})`);
  }
  const voices = (await response.json()) as MicrosoftVoiceListEntry[];
  return Array.isArray(voices)
    ? voices
        .map((voice) => ({
          id: voice.ShortName?.trim() ?? "",
          name: voice.FriendlyName?.trim() || voice.ShortName?.trim() || undefined,
          category: voice.VoiceTag?.ContentCategories?.find((value) => value.trim().length > 0),
          description: formatMicrosoftVoiceDescription(voice),
          locale: voice.Locale?.trim() || undefined,
          gender: voice.Gender?.trim() || undefined,
          personalities: voice.VoiceTag?.VoicePersonalities?.filter(
            (value): value is string => value.trim().length > 0,
          ),
        }))
        .filter((voice) => voice.id.length > 0)
    : [];
}

export function buildMicrosoftSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "microsoft",
    label: "Microsoft",
    aliases: ["edge"],
    listVoices: async () => await listMicrosoftVoices(),
    isConfigured: ({ config }) => config.edge.enabled,
    synthesize: async (req) => {
      const tempRoot = resolvePreferredOpenClawTmpDir();
      mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
      const tempDir = mkdtempSync(path.join(tempRoot, "tts-microsoft-"));
      let outputFormat = req.overrides?.microsoft?.outputFormat ?? req.config.edge.outputFormat;
      const fallbackOutputFormat =
        outputFormat !== DEFAULT_EDGE_OUTPUT_FORMAT ? DEFAULT_EDGE_OUTPUT_FORMAT : undefined;

      try {
        const runEdge = async (format: string) => {
          const fileExtension = inferEdgeExtension(format);
          const outputPath = path.join(tempDir, `speech${fileExtension}`);
          await edgeTTS({
            text: req.text,
            outputPath,
            config: {
              ...req.config.edge,
              voice: req.overrides?.microsoft?.voice ?? req.config.edge.voice,
              outputFormat: format,
            },
            timeoutMs: req.config.timeoutMs,
          });
          const audioBuffer = readFileSync(outputPath);
          return {
            audioBuffer,
            outputFormat: format,
            fileExtension,
            voiceCompatible: isVoiceCompatibleAudio({ fileName: outputPath }),
          };
        };

        try {
          return await runEdge(outputFormat);
        } catch (err) {
          if (!fallbackOutputFormat || fallbackOutputFormat === outputFormat) {
            throw err;
          }
          outputFormat = fallbackOutputFormat;
          return await runEdge(outputFormat);
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  };
}
