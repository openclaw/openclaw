import { Type } from "@sinclair/typebox";
import type { CambClientWrapper } from "../client.js";

/**
 * Create the camb_translate tool for text translation
 */
export function createTranslateTool(clientWrapper: CambClientWrapper) {
  return {
    name: "camb_translate",
    label: "Camb AI Translate",
    description:
      "Translate text between 140+ languages using Camb AI. " +
      "Use for creating multilingual content on Moltbook or preparing text for international audiences.",
    parameters: Type.Object({
      text: Type.String({
        description: "Text to translate",
      }),
      source_language: Type.Number({
        description: "Source language ID. Use camb_list_languages to get available language IDs.",
      }),
      target_language: Type.Number({
        description: "Target language ID. Use camb_list_languages to get available language IDs.",
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

        const sourceLanguage = params.source_language;
        const targetLanguage = params.target_language;

        if (typeof sourceLanguage !== "number" || typeof targetLanguage !== "number") {
          throw new Error("source_language and target_language (numeric IDs) are required");
        }

        // Use task-based translation (same as CLI)
        const taskResponse = await client.translation.createTranslation({
          texts: [text],
          source_language: sourceLanguage,
          target_language: targetLanguage,
        });

        const taskId = (taskResponse as { task_id?: string }).task_id;
        if (!taskId) {
          // Might be a direct result
          const result = taskResponse as { texts?: string[]; translations?: string[] };
          const translations = result.texts ?? result.translations;
          if (Array.isArray(translations) && translations.length > 0) {
            return json({
              success: true,
              original_text: text,
              translated_text: translations[0],
              source_language: sourceLanguage,
              target_language: targetLanguage,
            });
          }
          throw new Error("Failed to create translation task");
        }

        // Poll for completion
        const result = await clientWrapper.pollForCompletion(
          async () => {
            const status = await client.translation.getTranslationTaskStatus({
              task_id: taskId,
            });
            return {
              status: status.status || "PENDING",
              run_id: status.run_id,
            };
          },
          async (runId: number) => {
            const result = await client.translation.getTranslationResult({
              run_id: runId,
            });
            return result;
          },
        );

        // Extract translated text from result
        const resultData = result as { texts?: string[]; translations?: string[] };
        const translations = resultData.texts ?? resultData.translations;
        const translatedText = Array.isArray(translations) ? translations[0] : undefined;

        return json({
          success: true,
          original_text: text,
          translated_text: translatedText,
          source_language: sourceLanguage,
          target_language: targetLanguage,
        });
      } catch (err) {
        return json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
