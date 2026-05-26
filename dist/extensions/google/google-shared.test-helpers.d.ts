import { Model } from "@earendil-works/pi-ai";

//#region extensions/google/google-shared.test-helpers.d.ts
declare const asRecord: (value: unknown) => Record<string, unknown>;
type ConvertedTools = ReadonlyArray<{
  functionDeclarations?: ReadonlyArray<{
    parametersJsonSchema?: unknown;
    parameters?: unknown;
  }>;
}>;
declare const getFirstToolParameters: (converted: ConvertedTools) => Record<string, unknown>;
declare const makeModel: (id: string) => Model<"google-generative-ai">;
declare const makeGeminiCliModel: (id: string) => Model<"google-gemini-cli">;
declare function makeGoogleAssistantMessage(model: string, content: unknown): {
  role: string;
  content: unknown;
  api: string;
  provider: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    reasoningTokens: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
  stopReason: string;
  timestamp: number;
};
declare function makeGeminiCliAssistantMessage(model: string, content: unknown): {
  role: string;
  content: unknown;
  api: string;
  provider: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    reasoningTokens: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
  stopReason: string;
  timestamp: number;
};
declare function expectConvertedRoles(contents: Array<{
  role?: string;
}>, expectedRoles: string[]): void;
//#endregion
export { asRecord, expectConvertedRoles, getFirstToolParameters, makeGeminiCliAssistantMessage, makeGeminiCliModel, makeGoogleAssistantMessage, makeModel };