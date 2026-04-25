import type { SpeechVoiceOption } from "openclaw/plugin-sdk/speech";

const DEFAULT_AZURE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

type AzureVoiceListEntry = {
  Name?: string;
  DisplayName?: string;
  LocalName?: string;
  ShortName?: string;
  Gender?: string;
  Locale?: string;
  VoiceType?: string;
  Status?: string;
};

function normalizeAzureBaseUrl(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\/+$/, "");
}

export type AzureSpeechTTSResult = {
  audioBuffer: Buffer;
  fileExtension: string;
  voiceCompatible: boolean;
};

function getFileExtension(outputFormat: string): string {
  if (outputFormat.includes("mp3")) return ".mp3";
  if (outputFormat.includes("wav") || outputFormat.includes("riff") || outputFormat.includes("pcm")) return ".wav";
  if (outputFormat.includes("ogg")) return ".ogg";
  if (outputFormat.includes("webm")) return ".webm";
  return ".mp3";
}

function isVoiceCompatibleFormat(outputFormat: string): boolean {
  return outputFormat.includes("mp3") || outputFormat.includes("opus");
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildAzureSSML(text: string, voice: string, lang: string): string {
  const escapedText = escapeXml(text);
  const escapedVoice = escapeXml(voice);
  const escapedLang = escapeXml(lang);
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${escapedLang}'><voice name='${escapedVoice}'>${escapedText}</voice></speak>`;
}

export async function listAzureVoices(params: {
  apiKey: string;
  region?: string;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<SpeechVoiceOption[]> {
  const timeout = params.timeoutMs ?? 30000;
  const url = params.baseUrl
    ? `${normalizeAzureBaseUrl(params.baseUrl)}/cognitiveservices/voices/list`
    : `https://${params.region ?? "eastus"}.tts.speech.microsoft.com/cognitiveservices/voices/list`;

  const response = await fetch(url, {
    headers: {
      "Ocp-Apim-Subscription-Key": params.apiKey,
    },
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    throw new Error(`Azure voices API error (${response.status})`);
  }

  const voices = (await response.json()) as AzureVoiceListEntry[];
  return Array.isArray(voices)
    ? voices
        .filter((voice) => voice.Status !== "Deprecated")
        .map((voice) => ({
          id: voice.ShortName?.trim() ?? "",
          name: voice.DisplayName?.trim() || voice.ShortName?.trim() || undefined,
          category: voice.VoiceType?.trim() || undefined,
          locale: voice.Locale?.trim() || undefined,
          gender: voice.Gender?.trim() || undefined,
        }))
        .filter((voice) => voice.id.length > 0)
    : [];
}

export async function azureSpeechTTS(params: {
  text: string;
  apiKey: string;
  region: string;
  baseUrl?: string;
  voice: string;
  lang: string;
  outputFormat: string;
  timeoutMs?: number;
}): Promise<AzureSpeechTTSResult> {
  const endpoint = params.baseUrl
    ? `${normalizeAzureBaseUrl(params.baseUrl)}/cognitiveservices/v1`
    : `https://${params.region}.tts.speech.microsoft.com/cognitiveservices/v1`;

  const timeout = params.timeoutMs ?? 30000;
  const ssml = buildAzureSSML(params.text, params.voice, params.lang);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": params.apiKey,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": params.outputFormat,
    },
    body: ssml,
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    throw new Error(`Azure TTS failed: ${response.status} ${response.statusText}`);
  }

  const audioBuffer = await response.arrayBuffer();
  return {
    audioBuffer: Buffer.from(audioBuffer),
    outputFormat: params.outputFormat,
    fileExtension: getFileExtension(params.outputFormat),
    voiceCompatible: isVoiceCompatibleFormat(params.outputFormat),
  };
}