import { GoogleGenAI } from "@google/genai";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, SimpleStreamOptions } from "@mariozechner/pi-ai";
import {
  createWritableTransportEventStream,
  finalizeTransportStream,
  failTransportStream,
  sanitizeTransportPayloadText,
} from "./transport-stream-shared.js";

export function createGoogleGenAiStreamFnForModel(
  model: { id: string; provider: string; baseUrl?: string },
  env: NodeJS.ProcessEnv = process.env,
): StreamFn {
  return (rawModel: unknown, context: Context, options?: SimpleStreamOptions) => {
    const { eventStream, stream } = createWritableTransportEventStream();

    void (async () => {
      const output = {
        role: "assistant",
        content: [] as Array<{ type: "text"; text: string }>,
        api: "google-genai",
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, totalTokens: 0 },
        stopReason: "stop",
        timestamp: Date.now(),
      };

      try {
        const apiKey = options?.apiKey ?? env.GEMINI_API_KEY;
        const project = env.GOOGLE_CLOUD_PROJECT;
        const location = env.GOOGLE_CLOUD_LOCATION;

        let ai: GoogleGenAI;

        if (apiKey) {
          ai = new GoogleGenAI({ apiKey });
        } else {
          // Vertex AI / ADC mode
          if (!project) {
            throw new Error(
              "Google Vertex ADC Error: Project ID is missing.\nRecovery: Vertex AI requires a project ID. Either define 'GOOGLE_CLOUD_PROJECT' in your environment or set 'models.providers.google-genai.vertexai.project' in openclaw.json.",
            );
          }
          if (!location) {
            throw new Error(
              "Google Vertex ADC Error: Location is missing.\nRecovery: Vertex AI requires a location (e.g., 'us-central1'). Either define 'GOOGLE_CLOUD_LOCATION' in your environment or set 'models.providers.google-genai.vertexai.location' in openclaw.json.",
            );
          }

          ai = new GoogleGenAI({
            vertexai: true,
            project: project,
            location: location,
          });
        }

        stream.push({ type: "start", partial: output as never });

        // Simplified message conversion for now
        const contents = context.messages
          .map((msg: unknown) => {
            const m = msg as {
              content: string | Array<{ type: string; text?: string }>;
              role: string;
            };
            let text = "";
            if (typeof m.content === "string") {
              text = m.content;
            } else if (Array.isArray(m.content)) {
              text = m.content
                .filter((part) => part.type === "text")
                .map((part) => part.text || "")
                .join("\n");
            }
            return {
              role: m.role === "user" ? "user" : "model",
              parts: [{ text: sanitizeTransportPayloadText(text) }],
            };
          })
          .filter((c: { parts: Array<{ text: string }> }) => c.parts[0].text.length > 0);

        const responseStream = await ai.models.generateContentStream({
          model: model.id,
          contents: contents,
        });

        let currentBlockIndex = -1;

        for await (const chunk of responseStream) {
          const text = chunk.text;
          if (text) {
            if (currentBlockIndex < 0) {
              output.content.push({ type: "text", text: "" });
              currentBlockIndex = output.content.length - 1;
              stream.push({
                type: "text_start",
                contentIndex: currentBlockIndex,
                partial: output as never,
              });
            }

            const activeBlock = output.content[currentBlockIndex];
            if (activeBlock && activeBlock.type === "text") {
              activeBlock.text += text;
              stream.push({
                type: "text_delta",
                contentIndex: currentBlockIndex,
                delta: text,
                partial: output as never,
              });
            }
          }
        }

        if (currentBlockIndex >= 0) {
          const activeBlock = output.content[currentBlockIndex];
          if (activeBlock && activeBlock.type === "text") {
            stream.push({
              type: "text_end",
              contentIndex: currentBlockIndex,
              content: activeBlock.text,
              partial: output as never,
            });
          }
        }

        finalizeTransportStream({ stream, output, signal: options?.signal });
      } catch (error: unknown) {
        console.error("Stream error:", error);
        let processedError = error;
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Intercept 401 Unauthorized from Vertex AI
        if (errorMessage.includes("401") || errorMessage.includes("UNAUTHENTICATED")) {
          const apiKey = options?.apiKey ?? env.GEMINI_API_KEY;
          if (!apiKey) {
            const project = env.GOOGLE_CLOUD_PROJECT || "[PROJECT_ID]";
            processedError = new Error(
              `${errorMessage}\nRecovery: Received 401 from Vertex AI. Ensure the authenticated Service Account or User has the 'Vertex AI User' (roles/aiplatform.user) IAM role assigned for project ${project}. Run 'gcloud auth application-default login' to refresh credentials.`,
            );
          }
        }
        failTransportStream({ stream, output, signal: options?.signal, error: processedError });
      }
    })();

    return eventStream as unknown as ReturnType<StreamFn>;
  };
}
