import type {
  AssistantMessage,
  ModelRequestHeaders,
  ProviderCallStreamOptions,
  ProviderModel,
  SimpleStreamOptions,
} from "openclaw/plugin-sdk/llm";
import type { GoogleStreamChunk } from "openclaw/plugin-sdk/provider-transport-runtime";
import type { GoogleThinkingLevel } from "./thinking-api.js";

/** Explicit replay of a completed ClawRouter Google response; never starts a hop itself. */
export type GoogleContinuationOptions = {
  googleContinuation?: AssistantMessage["providerReplay"];
  authProfileId?: string;
  sessionId?: string;
};

export type CanonicalGoogleTransportApi = "google-generative-ai" | "google-vertex";
export type GoogleTransportApi =
  | CanonicalGoogleTransportApi
  | "openclaw-google-generative-ai-transport";

export type GoogleTransportModel = ProviderModel<GoogleTransportApi> & {
  headers?: ModelRequestHeaders;
  provider: string;
};

export type GoogleTransportOptions = SimpleStreamOptions &
  ProviderCallStreamOptions & {
    cachedContent?: string;
    topP?: number;
    toolChoice?:
      | "auto"
      | "none"
      | "any"
      | "required"
      | {
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
  } & GoogleContinuationOptions;

export type GoogleGenerateContentRequest = {
  continuationToken?: string;
  cachedContent?: string;
  contents: Array<Record<string, unknown>>;
  generationConfig?: Record<string, unknown>;
  systemInstruction?: Record<string, unknown>;
  tools?: Array<Record<string, unknown>>;
  toolConfig?: Record<string, unknown>;
};
export type GoogleSseAttempt =
  | {
      type: "ready";
      chunks: AsyncGenerator<GoogleStreamChunk>;
    }
  | { type: "timeout" };
