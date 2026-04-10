/**
 * Shared SSE audio stream collector for OpenRouter's /chat/completions
 * streaming audio responses. Used by both the music generation and speech
 * providers.
 */

type SseAudioChunk = {
  choices?: Array<{
    delta?: {
      audio?: {
        data?: string;
        transcript?: string;
      };
    };
  }>;
};

export async function collectStreamedAudio(
  response: Response,
): Promise<{ audioBuffer: Buffer; transcript: string }> {
  // Decode each base64 chunk individually to avoid corruption from padding chars mid-string.
  const audioBuffers: Buffer[] = [];
  const transcriptParts: string[] = [];

  const body = response.body;
  if (!body) {
    throw new Error("OpenRouter audio response missing stream body");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        continue;
      }
      let parsed: SseAudioChunk;
      try {
        parsed = JSON.parse(payload) as SseAudioChunk;
      } catch {
        continue;
      }
      const audioDelta = parsed.choices?.[0]?.delta?.audio;
      if (!audioDelta) {
        continue;
      }
      const data = audioDelta.data;
      if (typeof data === "string" && data.length > 0) {
        audioBuffers.push(Buffer.from(data, "base64"));
      }
      const transcript = audioDelta.transcript;
      if (typeof transcript === "string" && transcript.length > 0) {
        transcriptParts.push(transcript);
      }
    }
  }

  return {
    audioBuffer: Buffer.concat(audioBuffers),
    transcript: transcriptParts.join(""),
  };
}
