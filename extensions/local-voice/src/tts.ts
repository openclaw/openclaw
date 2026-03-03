import type { OpenClawConfig } from "../../../src/config/config.js";

export type TTSProvider = "style-bert-vits2" | "elevenlabs" | "openai" | "voicevox";

export type StyleBertVITS2Config = {
  endpoint: string;
  modelId: string;
  speakerId: number;
  style: string;
  styleWeight: number;
  speed: number;
};

export type VoiceVoxConfig = {
  endpoint: string;
  speakerId: number;
};

export type TTSConfig = {
  provider: TTSProvider;
  styleBertVits2: StyleBertVITS2Config;
  voicevox: VoiceVoxConfig;
  openaiApiKey?: string;
  elevenLabsApiKey?: string;
};

export type PhonemeData = {
  phoneme: string;
  duration: number; // in seconds
};

export type TTSResult = {
  success: boolean;
  audioUrl?: string;
  audioData?: Buffer;
  phonemes?: PhonemeData[];
  error?: string;
};

const DEFAULT_SBV2_CONFIG: StyleBertVITS2Config = {
  endpoint: "http://localhost:5000",
  modelId: "Hakua",
  speakerId: 0,
  style: "Neutral",
  styleWeight: 1.0,
  speed: 1.0,
};

const DEFAULT_VV_CONFIG: VoiceVoxConfig = {
  endpoint: "http://localhost:50021",
  speakerId: 2, // Default "四国めたん" (Metan) or similar, can be adjusted
};

export function getTTSConfig(globalConfig: OpenClawConfig): TTSConfig {
  const talkVoiceCfg = globalConfig.plugins?.entries?.["talk-voice"]?.config as {
    provider?: TTSProvider;
    styleBertVits2?: Partial<StyleBertVITS2Config>;
  } | null;

  const localVoiceCfg = globalConfig.plugins?.entries?.["local-voice"]?.config as {
    ttsProvider?: TTSProvider;
    sbv2Endpoint?: string;
    sbv2ModelId?: string;
    vvEndpoint?: string;
    vvSpeakerId?: number;
    openaiApiKey?: string;
  } | null;

  const provider = localVoiceCfg?.ttsProvider ?? talkVoiceCfg?.provider ?? "style-bert-vits2";

  const sbv2Partial: Partial<StyleBertVITS2Config> = talkVoiceCfg?.styleBertVits2 ?? {};

  if (localVoiceCfg?.sbv2Endpoint) {
    sbv2Partial.endpoint = localVoiceCfg.sbv2Endpoint;
  }
  if (localVoiceCfg?.sbv2ModelId) {
    sbv2Partial.modelId = localVoiceCfg.sbv2ModelId;
  }

  const styleBertVits2: StyleBertVITS2Config = {
    ...DEFAULT_SBV2_CONFIG,
    ...sbv2Partial,
  };

  const voicevox: VoiceVoxConfig = {
    ...DEFAULT_VV_CONFIG,
    endpoint: localVoiceCfg?.vvEndpoint ?? DEFAULT_VV_CONFIG.endpoint,
    speakerId: localVoiceCfg?.vvSpeakerId ?? DEFAULT_VV_CONFIG.speakerId,
  };

  return {
    provider,
    styleBertVits2,
    voicevox,
    openaiApiKey: localVoiceCfg?.openaiApiKey,
  };
}

export async function synthesizeSpeech(text: string, config: TTSConfig): Promise<TTSResult> {
  if (!text.trim()) {
    return { success: false, error: "Empty text" };
  }

  try {
    switch (config.provider) {
      case "style-bert-vits2":
        return await synthesizeWithSBV2(text, config.styleBertVits2);
      case "openai":
        return await synthesizeWithOpenAI(text, config.openaiApiKey);
      case "voicevox":
        return await synthesizeWithVoiceVox(text, config.voicevox);
      default:
        return { success: false, error: `Unsupported TTS provider: ${config.provider}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

async function synthesizeWithSBV2(text: string, config: StyleBertVITS2Config): Promise<TTSResult> {
  const base = config.endpoint.replace(/\/$/, "");
  const params = new URLSearchParams({
    text,
    model_id: config.modelId,
    speaker_id: String(config.speakerId),
    style: config.style,
    style_weight: String(config.styleWeight),
    speed: String(config.speed),
    language: "JP",
    auto_split: "true",
  });

  const url = `${base}/voice?${params.toString()}`;

  const response = await fetch(url);
  if (!response.ok) {
    return { success: false, error: `SBV2 API error: ${response.status}` };
  }

  return { success: true, audioUrl: url };
}

async function synthesizeWithOpenAI(text: string, apiKey?: string): Promise<TTSResult> {
  if (!apiKey) {
    return { success: false, error: "OpenAI API key not configured" };
  }

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1",
      input: text,
      voice: "alloy",
    }),
  });

  if (!response.ok) {
    return { success: false, error: `OpenAI TTS error: ${response.status}` };
  }

  const audioData = Buffer.from(await response.arrayBuffer());
  return { success: true, audioData };
}

async function synthesizeWithVoiceVox(text: string, config: VoiceVoxConfig): Promise<TTSResult> {
  const base = config.endpoint.replace(/\/$/, "");

  // 1. Audio Query
  const queryUrl = `${base}/audio_query?text=${encodeURIComponent(text)}&speaker=${config.speakerId}`;
  const queryRes = await fetch(queryUrl, { method: "POST" });
  if (!queryRes.ok) {
    return { success: false, error: `VoiceVox AudioQuery error: ${queryRes.status}` };
  }
  const queryData = await queryRes.json();

  // 2. Synthesis
  const synthUrl = `${base}/synthesis?speaker=${config.speakerId}`;
  const synthRes = await fetch(synthUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(queryData),
  });

  if (!synthRes.ok) {
    return { success: false, error: `VoiceVox Synthesis error: ${synthRes.status}` };
  }

  const audioData = Buffer.from(await synthRes.arrayBuffer());

  // 3. Extract Phonemes for OSC
  const phonemes: PhonemeData[] = [];
  if (queryData.accent_phrases) {
    for (const phrase of queryData.accent_phrases) {
      if (phrase.moras) {
        for (const mora of phrase.moras) {
          if (mora.consonant && mora.consonant_length) {
            phonemes.push({ phoneme: mora.consonant, duration: mora.consonant_length });
          }
          if (mora.vowel && mora.vowel_length) {
            phonemes.push({ phoneme: mora.vowel, duration: mora.vowel_length });
          }
        }
      }
      if (phrase.pause_mora) {
        phonemes.push({ phoneme: "pau", duration: phrase.pause_mora.vowel_length || 0.1 });
      }
    }
  }

  return { success: true, audioData, phonemes };
}

export function mapPhonemeToViseme(phoneme: string): number {
  const p = phoneme.toLowerCase();
  // VRChat Standard Visemes (approximate mapping)
  if (["p", "b", "m"].includes(p)) return 1;
  if (["f", "v"].includes(p)) return 2;
  if (["th"].includes(p)) return 3;
  if (["d", "t", "n"].includes(p)) return 4;
  if (["k", "g"].includes(p)) return 5;
  if (["ch", "j", "sh"].includes(p)) return 6;
  if (["s", "z"].includes(p)) return 7;
  if (["nn"].includes(p)) return 8;
  if (["r"].includes(p)) return 9;
  if (p === "a") return 10;
  if (p === "e") return 11;
  if (p === "i") return 12;
  if (p === "o") return 13;
  if (p === "u") return 14;
  return 0; // silence/pau
}

export async function playAudio(url: string): Promise<void> {
  const { exec } = require("child_process");
  const platform = process.platform;

  const command = getPlayCommand(url, platform);
  if (command) {
    exec(command, (error: Error | null) => {
      if (error) {
        console.error("[local-voice] Audio playback failed:", error.message);
      }
    });
  }
}

export async function playAudioData(data: Buffer): Promise<void> {
  const { exec } = require("child_process");
  const { writeFileSync, unlinkSync, existsSync } = require("fs");
  const { tmpdir } = require("os");
  const { join } = require("path");

  const tmpFile = join(tmpdir(), `tts-${Date.now()}.wav`);
  writeFileSync(tmpFile, data);

  // Try dual_audio.py first (supports VB-Cable), fallback to simple playback
  const pythonPath = join(
    process.cwd(),
    "extensions",
    "local-voice",
    "moonshine-venv",
    "Scripts",
    "python.exe",
  );
  const dualScript = join(process.cwd(), "extensions", "local-voice", "src", "dual_audio.py");

  const useDual = existsSync(pythonPath) && existsSync(dualScript);
  const command = useDual
    ? `"${pythonPath}" "${dualScript}" "${tmpFile}"`
    : getPlayCommand(tmpFile, process.platform);

  if (command) {
    exec(command, { timeout: 30000 }, () => {
      try {
        unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors
      }
    });
  }
}

function getPlayCommand(source: string, platform: string): string | null {
  switch (platform) {
    case "darwin":
      return `afplay "${source}"`;
    case "win32":
      return `powershell -c "(New-Object Media.SoundPlayer '${source}').PlaySync()"`;
    case "linux":
      return `mpv "${source}"`;
    default:
      return null;
  }
}
