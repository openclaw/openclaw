import { i as GoogleThinkingLevel } from "./provider-stream-shared-BeJa0RWE.js";
import { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { StreamFn } from "@earendil-works/pi-agent-core";

//#region extensions/google/transport-stream.d.ts
type CanonicalGoogleTransportApi = "google-generative-ai" | "google-vertex";
type GoogleTransportApi = CanonicalGoogleTransportApi | "openclaw-google-generative-ai-transport";
type GoogleTransportModel = Model<GoogleTransportApi> & {
  headers?: Record<string, string>;
  provider: string;
};
type GoogleTransportOptions = SimpleStreamOptions & {
  cachedContent?: string;
  toolChoice?: "auto" | "none" | "any" | "required" | {
    type: "function";
    function: {
      name: string;
    };
  };
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
    level?: GoogleThinkingLevel;
  };
};
type GoogleGenerateContentRequest = {
  cachedContent?: string;
  contents: Array<Record<string, unknown>>;
  generationConfig?: Record<string, unknown>;
  systemInstruction?: Record<string, unknown>;
  tools?: Array<Record<string, unknown>>;
  toolConfig?: Record<string, unknown>;
};
declare function buildGoogleGenerativeAiParams(model: GoogleTransportModel, context: Context, options?: GoogleTransportOptions): GoogleGenerateContentRequest;
declare function buildGoogleGemini3FirstResponseRetryParams(params: {
  model: GoogleTransportModel;
  request: GoogleGenerateContentRequest;
}): GoogleGenerateContentRequest | undefined;
declare function createGoogleGenerativeAiTransportStreamFn(): StreamFn;
declare function createGoogleVertexTransportStreamFn(): StreamFn;
//#endregion
export { createGoogleVertexTransportStreamFn as i, buildGoogleGenerativeAiParams as n, createGoogleGenerativeAiTransportStreamFn as r, buildGoogleGemini3FirstResponseRetryParams as t };