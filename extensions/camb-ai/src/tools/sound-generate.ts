import { Type } from "@sinclair/typebox";
import type { CambClientWrapper } from "../client.js";
import type { CambAiConfig } from "../config.js";
import { saveAudioFile } from "../media.js";

/**
 * Create the camb_sound_generate tool for generating music and sound effects
 */
export function createSoundGenerateTool(clientWrapper: CambClientWrapper, config: CambAiConfig) {
  return {
    name: "camb_sound_generate",
    label: "Camb AI Sound Generate",
    description:
      "Generate music or sound effects from a text prompt. " +
      "Use for creating background music, sound effects, or audio content for posts and debates.",
    parameters: Type.Object({
      prompt: Type.String({
        description:
          "Description of the sound/music to generate (e.g., 'upbeat electronic music with synths', 'thunder storm with rain')",
      }),
      duration: Type.Optional(
        Type.Number({
          description: "Duration in seconds. Defaults to 10 seconds.",
        }),
      ),
    }),

    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const json = (payload: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        details: payload,
      });

      try {
        // Check if sound generation is enabled
        if (!config.soundGeneration.enabled) {
          throw new Error(
            "Sound generation is disabled. Set plugins.entries.camb-ai.config.soundGeneration.enabled=true to enable.",
          );
        }

        const client = clientWrapper.getClient();

        const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
        if (!prompt) {
          throw new Error("prompt is required");
        }

        // Ensure duration is a valid integer (API might reject floats)
        let duration = 10;
        if (typeof params.duration === "number") {
          duration = Math.floor(params.duration);
        } else if (typeof params.duration === "string") {
          duration = parseInt(params.duration, 10) || 10;
        }

        // Clamp duration to valid range (API typically accepts 1-30 seconds)
        duration = Math.max(1, Math.min(30, duration));

        // Create text-to-audio task - only pass required params
        const taskResponse = await client.textToAudio.createTextToAudio({
          prompt: prompt.slice(0, 500), // Limit prompt length
          duration,
        });

        const taskId = taskResponse.task_id;
        if (!taskId) {
          throw new Error("Failed to create sound generation task");
        }

        // Poll for completion
        const result = await clientWrapper.pollForCompletion(
          async () => {
            const status = await client.textToAudio.getTextToAudioStatus({
              task_id: taskId,
            });
            return {
              status: status.status || "PENDING",
              run_id: status.run_id,
            };
          },
          async (runId: number) => {
            // Get audio result - returns binary audio data
            const audioResponse = await client.textToAudio.getTextToAudioResult({
              run_id: runId,
            });
            return audioResponse;
          },
        );

        // Result is binary audio data - save directly to file
        const audioBuffer = Buffer.from(await result.arrayBuffer());
        const filePath = await saveAudioFile(audioBuffer, "sound", "wav");

        return json({
          success: true,
          task_id: taskId,
          file_path: filePath,
          prompt,
          duration,
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
