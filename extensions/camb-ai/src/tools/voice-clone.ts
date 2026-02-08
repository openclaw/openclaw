import { Type } from "@sinclair/typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CambClientWrapper } from "../client.js";
import type { CambAiConfig } from "../config.js";

/**
 * Create the camb_voice_clone tool for cloning voices from audio
 */
export function createVoiceCloneTool(clientWrapper: CambClientWrapper, config: CambAiConfig) {
  return {
    name: "camb_voice_clone",
    label: "Camb AI Voice Clone",
    description:
      "Clone a voice from an audio sample (2+ seconds). Creates a custom voice that can be used with camb_tts. " +
      "Accepts either a URL or local file path. " +
      "Use to give AI agents unique voice identities on MoltCast. Requires voiceCloning.enabled=true in config.",
    parameters: Type.Object({
      audio_source: Type.String({
        description:
          "URL or local file path of the audio file containing the voice to clone (min 2 seconds)",
      }),
      voice_name: Type.String({
        description: "Name for the cloned voice",
      }),
      gender: Type.String({
        description: "Gender: 'male' or 'female'",
      }),
    }),

    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const json = (payload: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        details: payload,
      });

      try {
        // Check if voice cloning is enabled
        if (!config.voiceCloning.enabled) {
          throw new Error(
            "Voice cloning is disabled. Set plugins.entries.camb-ai.config.voiceCloning.enabled=true to enable.",
          );
        }

        const client = clientWrapper.getClient();

        const audioSource =
          typeof params.audio_source === "string" ? params.audio_source.trim() : "";
        if (!audioSource) {
          throw new Error("audio_source is required");
        }

        const voiceName = typeof params.voice_name === "string" ? params.voice_name.trim() : "";
        if (!voiceName) {
          throw new Error("voice_name is required");
        }

        // Parse gender - accept string or number
        let genderNum: number;
        const genderParam = params.gender;
        if (typeof genderParam === "number") {
          genderNum = genderParam;
        } else if (typeof genderParam === "string") {
          genderNum = genderParam.toLowerCase() === "female" ? 2 : 1;
        } else {
          genderNum = 1; // Default to male
        }

        let audioFile: File;

        // Check if it's a local file path or URL
        if (audioSource.startsWith("http://") || audioSource.startsWith("https://")) {
          // Fetch from URL
          const audioResponse = await fetch(audioSource);
          if (!audioResponse.ok) {
            throw new Error(`Failed to fetch audio from URL: ${audioResponse.statusText}`);
          }
          const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
          const fileName = "voice_sample.mp3";
          audioFile = new File([audioBuffer], fileName, { type: "audio/mpeg" });
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

          audioFile = new File([audioBuffer], fileName, { type: mimeType });
        }

        // Create custom voice (same params as CLI)
        const response = await client.voiceCloning.createCustomVoice({
          file: audioFile,
          voice_name: voiceName,
          gender: genderNum,
        });

        return json({
          success: true,
          voice_id: response.id,
          voice_name: voiceName,
          gender: genderNum === 2 ? "female" : "male",
          result: response,
        });
      } catch (err) {
        return json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
