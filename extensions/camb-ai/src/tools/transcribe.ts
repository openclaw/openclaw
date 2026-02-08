import { Type } from "@sinclair/typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CambClientWrapper } from "../client.js";
import type { CambAiConfig } from "../config.js";

/**
 * Create the camb_transcribe tool for speech-to-text
 */
export function createTranscribeTool(clientWrapper: CambClientWrapper, _config: CambAiConfig) {
  return {
    name: "camb_transcribe",
    label: "Camb AI Transcribe",
    description:
      "Transcribe audio to text using Camb AI. Supports speaker identification and word-level timestamps. " +
      "Accepts either a URL or a local file path. " +
      "Use for processing audio from MoltCast debates or converting voice messages to text.",
    parameters: Type.Object({
      audio_source: Type.String({
        description: "URL or local file path of the audio file to transcribe",
      }),
      language: Type.Optional(
        Type.Number({
          description:
            "Language ID for transcription. Use camb_list_languages to get available language IDs.",
        }),
      ),
      word_timestamps: Type.Optional(
        Type.Boolean({
          description: "Include word-level timestamps in the result. Defaults to false.",
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

        const audioSource =
          typeof params.audio_source === "string" ? params.audio_source.trim() : "";
        if (!audioSource) {
          throw new Error("audio_source is required");
        }

        // Default to English (US) language ID if not specified
        const languageId = typeof params.language === "number" ? params.language : 47;
        const wordTimestamps = params.word_timestamps === true;

        let taskResponse;

        // Check if it's a local file path or URL
        if (audioSource.startsWith("http://") || audioSource.startsWith("https://")) {
          // Use URL
          taskResponse = await client.transcription.createTranscription({
            media_url: audioSource,
            language: languageId,
          });
        } else {
          // Read local file
          const filePath = audioSource.startsWith("~")
            ? audioSource.replace("~", process.env.HOME || "")
            : audioSource;

          const audioBuffer = await fs.readFile(filePath);
          const fileName = path.basename(filePath);
          const ext = path.extname(filePath).toLowerCase();
          const mimeType =
            ext === ".wav" ? "audio/wav" : ext === ".flac" ? "audio/flac" : "audio/mpeg";

          const audioFile = new File([audioBuffer], fileName, { type: mimeType });

          taskResponse = await client.transcription.createTranscription({
            media_file: audioFile,
            language: languageId,
          });
        }

        const taskId = taskResponse.task_id;
        if (!taskId) {
          throw new Error("Failed to create transcription task");
        }

        // Poll for completion
        const result = await clientWrapper.pollForCompletion(
          async () => {
            const status = await client.transcription.getTranscriptionTaskStatus({
              task_id: taskId,
            });
            return {
              status: status.status || "PENDING",
              run_id: status.run_id,
            };
          },
          async (runId: number) => {
            const result = await client.transcription.getTranscriptionResult({
              run_id: runId,
              word_level_timestamps: wordTimestamps,
            });
            return result;
          },
        );

        return json({
          success: true,
          task_id: taskId,
          transcript: result.transcript,
          language_id: languageId,
          word_timestamps: wordTimestamps ? result : undefined,
        });
      } catch (err) {
        return json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
