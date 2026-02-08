import { Type } from "@sinclair/typebox";
import type { CambClientWrapper } from "../client.js";
import type { CambAiConfig } from "../config.js";
import { downloadAndSaveAudio } from "../media.js";

/**
 * Create the camb_create_voice tool for generating voices from text descriptions
 */
export function createVoiceCreateTool(clientWrapper: CambClientWrapper, _config: CambAiConfig) {
  return {
    name: "camb_create_voice",
    label: "Camb AI Create Voice",
    description:
      "Generate a new synthetic voice from a text description. Describe the voice characteristics " +
      "(age, gender, accent, tone, etc.) and receive sample audio. Use to create unique agent voices " +
      "without needing an audio sample.",
    parameters: Type.Object({
      text: Type.String({
        description: "Sample text to speak with the generated voice",
      }),
      voice_description: Type.String({
        description:
          "Text description of the desired voice characteristics (e.g., 'young female with British accent, warm and friendly tone')",
      }),
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
        if (text.length < 100) {
          throw new Error("text must be at least 100 characters for voice creation");
        }

        const voiceDescription =
          typeof params.voice_description === "string" ? params.voice_description.trim() : "";
        if (!voiceDescription) {
          throw new Error("voice_description is required");
        }

        // Create text-to-voice task
        const taskResponse = await client.textToVoice.createTextToVoice({
          text,
          voice_description: voiceDescription,
        });

        const taskId = taskResponse.task_id;
        if (!taskId) {
          throw new Error("Failed to create voice generation task");
        }

        // Poll for completion
        const result = await clientWrapper.pollForCompletion(
          async () => {
            const status = await client.textToVoice.getTextToVoiceStatus({
              task_id: taskId,
            });
            return {
              status: status.status || "PENDING",
              run_id: status.run_id,
            };
          },
          async (runId: number) => {
            const result = await client.textToVoice.getTextToVoiceResult({
              run_id: runId,
            });
            return result;
          },
        );

        // Download and save voice samples - recursively find all URLs in result
        const savedFiles: string[] = [];
        const playCommands: string[] = [];

        // Recursively find all URLs in any object structure
        const findUrls = (obj: unknown): string[] => {
          const urls: string[] = [];
          if (typeof obj === "string" && obj.startsWith("http")) {
            urls.push(obj);
          } else if (Array.isArray(obj)) {
            for (const item of obj) {
              urls.push(...findUrls(item));
            }
          } else if (typeof obj === "object" && obj !== null) {
            for (const value of Object.values(obj)) {
              urls.push(...findUrls(value));
            }
          }
          return urls;
        };

        const urls = findUrls(result);

        // Download all found URLs
        for (let i = 0; i < urls.length; i++) {
          const ext = urls[i].includes(".mp3") ? "mp3" : "wav";
          const filePath = await downloadAndSaveAudio(urls[i], `voice_sample_${i}`, ext);
          savedFiles.push(filePath);
          playCommands.push(`afplay "${filePath}"`);
        }

        return json({
          success: true,
          task_id: taskId,
          saved_files: savedFiles,
          voice_description: voiceDescription,
          sample_text: text,
          samples: result,
          play_commands: playCommands,
        });
      } catch (err) {
        return json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
