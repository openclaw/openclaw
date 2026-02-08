import { Type } from "@sinclair/typebox";
import type { CambClientWrapper } from "../client.js";
import type { CambAiConfig } from "../config.js";
import { downloadAndSaveAudio } from "../media.js";

/**
 * Create the camb_translated_tts tool for translate + speak in one step
 */
export function createTranslatedTtsTool(clientWrapper: CambClientWrapper, config: CambAiConfig) {
  return {
    name: "camb_translated_tts",
    label: "Camb AI Translated TTS",
    description:
      "Translate text and convert to speech in one step. " +
      "Combine translation and TTS for efficient multilingual voice content. " +
      "Use for voice replies in the user's preferred language on Moltbook/MoltCast.",
    parameters: Type.Object({
      text: Type.String({
        description: "Text to translate and speak",
      }),
      source_language: Type.Number({
        description: "Source language ID. Use camb_list_languages to get available language IDs.",
      }),
      target_language: Type.Number({
        description: "Target language ID. Use camb_list_languages to get available language IDs.",
      }),
      voice_id: Type.Optional(
        Type.Number({
          description:
            "Voice ID to use for TTS. Get available voices with camb_list_voices. Defaults to configured voice.",
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

        const sourceLanguage = params.source_language;
        const targetLanguage = params.target_language;

        if (typeof sourceLanguage !== "number" || typeof targetLanguage !== "number") {
          throw new Error("source_language and target_language (numeric IDs) are required");
        }

        const voiceId =
          typeof params.voice_id === "number" ? params.voice_id : config.tts.defaultVoiceId;

        if (!voiceId) {
          throw new Error(
            "voice_id is required. Use camb_list_voices to get available voices, or configure a default.",
          );
        }

        // Create translated TTS task
        const taskResponse = await client.translatedTts.createTranslatedTts({
          text,
          voice_id: voiceId,
          source_language: sourceLanguage,
          target_language: targetLanguage,
        });

        const taskId = taskResponse.task_id;
        if (!taskId) {
          throw new Error("Failed to create translated TTS task");
        }

        // Poll for completion
        const result = await clientWrapper.pollForCompletion(
          async () => {
            const status = await client.translatedTts.getTranslatedTtsTaskStatus({
              task_id: taskId,
            });
            return {
              status: status.status || "PENDING",
              run_id: status.run_id,
            };
          },
          async (runId: number) => {
            // Wait 1 second after SUCCESS before fetching result (backend processing delay)
            await new Promise((r) => setTimeout(r, 1000));

            // Fetch the audio URL using getTtsRunInfo
            const ttsResult = await client.textToSpeech.getTtsRunInfo({
              run_id: runId,
              output_type: "file_url",
            });
            return ttsResult;
          },
        );

        // Download and save the audio file
        const outputUrl = result.output_url;
        if (!outputUrl) {
          throw new Error("No output URL returned from translated TTS");
        }

        const filePath = await downloadAndSaveAudio(outputUrl, "translated_tts", "wav");

        return json({
          success: true,
          task_id: taskId,
          file_path: filePath,
          output_url: outputUrl,
          original_text: text,
          source_language: sourceLanguage,
          target_language: targetLanguage,
          voice_id: voiceId,
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
