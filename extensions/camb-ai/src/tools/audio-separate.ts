import { Type } from "@sinclair/typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CambClientWrapper } from "../client.js";
import { downloadAndSaveAudio } from "../media.js";

/**
 * Create the camb_audio_separate tool for isolating vocals from background
 */
export function createAudioSeparateTool(clientWrapper: CambClientWrapper) {
  return {
    name: "camb_audio_separate",
    label: "Camb AI Audio Separate",
    description:
      "Separate vocals from background music/sounds in an audio file. " +
      "Accepts either a URL or a local file path. " +
      "Use for isolating speech from noisy recordings or extracting vocals from music.",
    parameters: Type.Object({
      audio_source: Type.String({
        description: "URL or local file path of the audio file to process",
      }),
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

        let audioBlob: Blob;

        // Check if it's a local file path or URL
        if (audioSource.startsWith("http://") || audioSource.startsWith("https://")) {
          // Fetch from URL
          const audioResponse = await fetch(audioSource);
          if (!audioResponse.ok) {
            throw new Error(`Failed to fetch audio from URL: ${audioResponse.statusText}`);
          }
          audioBlob = await audioResponse.blob();
        } else {
          // Read local file
          const filePath = audioSource.startsWith("~")
            ? audioSource.replace("~", process.env.HOME || "")
            : audioSource;

          const audioBuffer = await fs.readFile(filePath);
          const ext = path.extname(filePath).toLowerCase();
          const mimeType =
            ext === ".wav" ? "audio/wav" : ext === ".flac" ? "audio/flac" : "audio/mpeg";

          audioBlob = new Blob([audioBuffer], { type: mimeType });
        }

        // Create audio separation task
        const taskResponse = await client.audioSeparation.createAudioSeparation({
          media_file: audioBlob,
        });

        const taskId = taskResponse.task_id;
        if (!taskId) {
          throw new Error("Failed to create audio separation task");
        }

        // Poll for completion
        const result = await clientWrapper.pollForCompletion(
          async () => {
            const status = await client.audioSeparation.getAudioSeparationStatus({
              task_id: taskId,
            });
            return {
              status: status.status || "PENDING",
              run_id: status.run_id,
            };
          },
          async (runId: number) => {
            const result = await client.audioSeparation.getAudioSeparationRunInfo({
              run_id: runId,
            });
            return result;
          },
        );

        // Download and save the separated tracks
        const resultData = result as {
          foreground_audio_url?: string;
          background_audio_url?: string;
        };

        let vocalsPath: string | undefined;
        let backgroundPath: string | undefined;

        if (resultData.foreground_audio_url) {
          vocalsPath = await downloadAndSaveAudio(
            resultData.foreground_audio_url,
            "vocals",
            "flac",
          );
        }
        if (resultData.background_audio_url) {
          backgroundPath = await downloadAndSaveAudio(
            resultData.background_audio_url,
            "background",
            "flac",
          );
        }

        return json({
          success: true,
          task_id: taskId,
          vocals_file: vocalsPath,
          background_file: backgroundPath,
          separated_tracks: result,
          play_vocals: vocalsPath ? `afplay "${vocalsPath}"` : undefined,
          play_background: backgroundPath ? `afplay "${backgroundPath}"` : undefined,
        });
      } catch (err) {
        return json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
