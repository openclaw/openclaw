import { GoogleGenAI } from "@google/genai";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  createWritableTransportEventStream,
  finalizeTransportStream,
  failTransportStream,
  sanitizeTransportPayloadText,
} from "./transport-stream-shared.js";

const log = createSubsystemLogger("google-genai");

export function createGoogleGenAiStreamFnForModel(
  model: { id: string; provider: string; baseUrl?: string; vertexai?: { project?: string; location?: string } },
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
        const project = model.vertexai?.project ?? env.GOOGLE_CLOUD_PROJECT;
        const location = model.vertexai?.location ?? (env.GOOGLE_CLOUD_LOCATION || "global"); // Default to global

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
              content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
              role: string;
            };

            let parts: any[] = [];

            if (typeof m.content === "string") {
              parts.push({ text: sanitizeTransportPayloadText(m.content) });
            } else if (Array.isArray(m.content)) {
              parts = m.content
                .map((part) => {
                  if (part.type === "text" && part.text) {
                    return { text: sanitizeTransportPayloadText(part.text) };
                  } else if (part.type === "image" && part.data && part.mimeType) {
                    return {
                      inlineData: {
                        mimeType: part.mimeType,
                        data: part.data,
                      },
                    };
                  }
                  return null;
                })
                .filter((p): p is nonNullable<typeof p> => p !== null);
            }

            return {
              role: m.role === "user" ? "user" : "model",
              parts: parts,
            };
          })
          .filter((c: { parts: any[] }) => c.parts.length > 0);

        const responseStream = await ai.models.generateContentStream({
          model: model.id,
          contents: contents,
          config: context.systemPrompt ? { systemInstruction: context.systemPrompt } : undefined,
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
        log.error("Stream error:", error);
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
        // Intercept 404 Not Found from Vertex AI
        if (errorMessage.includes("404") || errorMessage.includes("NOT_FOUND") || errorMessage.includes("not found")) {
          const currentLoc = env.GOOGLE_CLOUD_LOCATION || "global";
          if (currentLoc !== "global") {
            processedError = new Error(
              `${errorMessage}\nRecovery: Resource not found. Your current location is '${currentLoc}'. Some models/aliases (like 'gemini-flash-latest') are only available on the 'global' endpoint in Vertex AI. Try setting GOOGLE_CLOUD_LOCATION="global" in your environment or openclaw.json.`,
            );
          }
        }
        failTransportStream({ stream, output, signal: options?.signal, error: processedError });
      }
    })();

    return eventStream as unknown as ReturnType<StreamFn>;
  };
}
