export const DEFAULT_INWORLD_BASE_URL = "https://api.inworld.ai";

export const INWORLD_TTS_MODELS = ["inworld-tts-1.5-max", "inworld-tts-1.5-mini"] as const;

export async function inworldTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  modelId: string;
  voiceId: string;
  timeoutMs: number;
}): Promise<Buffer> {
  const { text, apiKey, baseUrl, modelId, voiceId, timeoutMs } = params;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/tts/v1/voice`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text, voiceId, modelId }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(
        `Inworld TTS API error (${response.status})${errBody.trim() ? `: ${errBody.trim()}` : ""}`,
      );
    }

    const body = (await response.json()) as { audioContent?: string };
    const audioContent = body?.audioContent;
    if (!audioContent) {
      throw new Error("Inworld TTS API returned no audio data");
    }

    return Buffer.from(audioContent, "base64");
  } finally {
    clearTimeout(timeout);
  }
}
