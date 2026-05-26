import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
import { n as moonshotMediaUnderstandingProvider } from "../../media-understanding-provider-DfQNGUCx.js";

//#region extensions/moonshot/src/kimi-web-search-provider.runtime.d.ts
type KimiConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};
type KimiToolCall = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};
type KimiMessage = {
  role?: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: KimiToolCall[];
};
type KimiSearchResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: KimiMessage;
  }>;
  search_results?: Array<{
    title?: string;
    url?: string;
    content?: string;
  }>;
};
declare function resolveKimiApiKey(kimi?: KimiConfig): string | undefined;
declare function resolveKimiModel(kimi?: KimiConfig): string;
declare function resolveKimiBaseUrl(kimi?: KimiConfig, openClawConfig?: OpenClawConfig): string;
declare function extractKimiCitations(data: KimiSearchResponse): string[];
declare function hasKimiSearchResults(data: KimiSearchResponse): boolean;
declare function extractKimiToolResultContent(toolCall: KimiToolCall): string | undefined;
declare const testing: {
  readonly resolveKimiApiKey: typeof resolveKimiApiKey;
  readonly resolveKimiModel: typeof resolveKimiModel;
  readonly resolveKimiBaseUrl: typeof resolveKimiBaseUrl;
  readonly extractKimiCitations: typeof extractKimiCitations;
  readonly hasKimiSearchResults: typeof hasKimiSearchResults;
  readonly extractKimiToolResultContent: typeof extractKimiToolResultContent;
};
//#endregion
export { testing as __testing, testing, moonshotMediaUnderstandingProvider };