import { Type } from "@sinclair/typebox";
import type { CambClientWrapper } from "../client.js";

/**
 * Create the camb_list_languages tool for listing available languages
 */
export function createListLanguagesTool(clientWrapper: CambClientWrapper) {
  return {
    name: "camb_list_languages",
    label: "Camb AI List Languages",
    description:
      "List all available languages for transcription and translation. Returns language IDs and names. " +
      "Use to find the right language_id for camb_transcribe, camb_translate, or camb_translated_tts.",
    parameters: Type.Object({
      type: Type.Optional(
        Type.String({
          description:
            "Filter by language type: 'source' for input languages, 'target' for output languages. " +
            "Defaults to 'source'.",
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

        const languageType = typeof params.type === "string" ? params.type.trim() : "source";

        let languages;
        if (languageType === "target") {
          languages = await client.languages.getTargetLanguages();
        } else {
          languages = await client.languages.getSourceLanguages();
        }

        return json({
          success: true,
          type: languageType,
          count: languages.length,
          languages: languages.map((l) => ({
            id: l.id,
            name: l.language,
            code: l.shortName,
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
