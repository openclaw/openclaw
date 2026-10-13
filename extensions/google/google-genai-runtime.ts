import { GoogleGenAI, type GoogleGenAIOptions } from "@google/genai";
import { resolveGoogleApiClientHeadersAsync } from "./google-api-client-header.js";

export type GoogleGenAIClient = InstanceType<typeof GoogleGenAI>;

export async function createGoogleGenAI(options: GoogleGenAIOptions): Promise<GoogleGenAIClient> {
  const httpOptions = options.httpOptions ?? {};
  return new GoogleGenAI({
    ...options,
    httpOptions: {
      ...httpOptions,
      headers: {
        ...httpOptions.headers,
        ...(await resolveGoogleApiClientHeadersAsync({
          baseUrl: typeof httpOptions.baseUrl === "string" ? httpOptions.baseUrl : undefined,
        })),
      },
    },
  });
}
