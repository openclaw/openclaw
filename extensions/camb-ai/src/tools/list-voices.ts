import { Type } from "@sinclair/typebox";
import type { CambClientWrapper } from "../client.js";

/**
 * Create the camb_list_voices tool for listing available voices
 */
export function createListVoicesTool(clientWrapper: CambClientWrapper) {
  return {
    name: "camb_list_voices",
    label: "Camb AI List Voices",
    description:
      "List all available voices for text-to-speech. Returns voice IDs, names, genders, and languages. " +
      "Use to find the right voice_id for camb_tts or camb_translated_tts.",
    parameters: Type.Object({}),

    async execute(_toolCallId: string, _params: Record<string, unknown>) {
      const json = (payload: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        details: payload,
      });

      try {
        const client = clientWrapper.getClient();

        const voices = await client.voiceCloning.listVoices();

        return json({
          success: true,
          count: voices.length,
          voices: voices.map((v) => ({
            id: v.id,
            name: v.voice_name,
            gender: v.gender,
            language: v.language,
          })),
        });
      } catch (err) {
        return json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
