import { Type } from "@sinclair/typebox";
import type { CambClientWrapper } from "../client.js";
import type { CambAiConfig } from "../config.js";
import { saveAudioFile } from "../media.js";

// SpeechModel string literal type matching the SDK
type SpeechModel = "auto" | "mars-pro" | "mars-flash" | "mars-instruct";

/**
 * Map model parameter to SpeechModel enum
 */
function mapSpeechModel(modelParam: string): SpeechModel | undefined {
  switch (modelParam) {
    case "mars-flash":
      return "mars-flash";
    case "mars-pro":
      return "mars-pro";
    case "mars-instruct":
      return "mars-instruct";
    case "auto":
      return "auto";
    default:
      return undefined;
  }
}

/**
 * Create the camb_tts tool for text-to-speech
 */
export function createTtsTool(clientWrapper: CambClientWrapper, config: CambAiConfig) {
  return {
    name: "camb_tts",
    label: "Camb AI TTS",
    description:
      "Convert text to speech using Camb AI MARS models. Returns audio in MP3/WAV format. " +
      "Supports 80+ languages and multiple voice styles. Use for generating speech for MoltCast debates, " +
      "voice replies, or any audio content needs.",
    parameters: Type.Object({
      text: Type.String({
        description: "The text to convert to speech",
      }),
      language: Type.Optional(
        Type.String({
          description:
            "Language code (e.g., 'en-us', 'es-es', 'fr-fr'). Defaults to configured language.",
        }),
      ),
      voice_id: Type.Optional(
        Type.Number({
          description:
            "Voice ID to use. Get available voices with camb_list_voices. Defaults to configured voice.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "MARS model: 'mars-flash' (fast), 'mars-pro' (quality), 'mars-instruct' (instruction-following)",
        }),
      ),
      instructions: Type.Optional(
        Type.String({
          description:
            "Style instructions for mars-instruct model (e.g., 'speak slowly and clearly')",
        }),
      ),
    }),

    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const json = (payload: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        details: payload,
      });

      try {
        const client = clientWrapper.getClient();

        const text = typeof params.text === "string" ? params.text.trim() : "";
        if (!text) {
          throw new Error("text is required");
        }

        const languageStr =
          typeof params.language === "string" ? params.language.trim() : config.tts.defaultLanguage;

        const voiceId =
          typeof params.voice_id === "number" ? params.voice_id : config.tts.defaultVoiceId;

        if (!voiceId) {
          throw new Error(
            "voice_id is required. Use camb_list_voices to get available voices, or configure a default.",
          );
        }

        // Map model string to API enum value
        const modelParam =
          typeof params.model === "string" ? params.model.trim() : config.tts.model;
        const speechModel = mapSpeechModel(modelParam);

        const instructions =
          typeof params.instructions === "string" ? params.instructions.trim() : undefined;

        // Use streaming TTS for immediate audio generation
        const response = await client.textToSpeech.tts({
          text,
          language: languageStr,
          voice_id: voiceId,
          speech_model: speechModel,
          user_instructions: instructions,
          output_configuration: {
            format: config.tts.outputFormat,
          },
        });

        // The response is a binary audio stream (BinaryResponse)
        // Save to file for easy access
        const audioBuffer = Buffer.from(await response.arrayBuffer());
        const filePath = await saveAudioFile(audioBuffer, "tts", config.tts.outputFormat);

        return json({
          success: true,
          file_path: filePath,
          format: config.tts.outputFormat,
          language: languageStr,
          voice_id: voiceId,
          model: speechModel,
          text_length: text.length,
          audio_size_bytes: audioBuffer.length,
          play_command: `afplay "${filePath}"`,
        });
      } catch (err) {
        return json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
