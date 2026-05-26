import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
import { sn as ProviderPlugin } from "../../types-Vx7Jq4_-2.js";
import { d as matchesExactOrPrefix, u as cloneFirstTemplateModel } from "../../provider-model-shared-fqN4xxDB.js";
import { u as findCatalogTemplate } from "../../provider-catalog-shared-COv85EY6.js";

//#region extensions/openai/shared.d.ts
type SyntheticOpenAIModelCatalogCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
type SyntheticOpenAIModelCatalogEntry = {
  provider: string;
  id: string;
  name: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  contextTokens?: number;
  cost?: SyntheticOpenAIModelCatalogCost;
};
declare function toOpenAIDataUrl(buffer: Buffer, mimeType: string): string;
declare function resolveConfiguredOpenAIBaseUrl(cfg: OpenClawConfig | undefined): string;
type OpenAIResponsesProviderHooks = Pick<ProviderPlugin, "buildReplayPolicy" | "prepareExtraParams" | "wrapStreamFn" | "resolveTransportTurnState" | "resolveWebSocketSessionPolicy">;
declare function buildOpenAIResponsesProviderHooks(options?: {
  transport?: "auto" | "sse" | "websocket";
}): OpenAIResponsesProviderHooks;
declare function buildOpenAISyntheticCatalogEntry(template: ReturnType<typeof findCatalogTemplate>, entry: {
  id: string;
  reasoning: boolean;
  input: readonly ("text" | "image")[];
  contextWindow: number;
  contextTokens?: number;
  cost?: SyntheticOpenAIModelCatalogCost;
}): SyntheticOpenAIModelCatalogEntry | undefined;
//#endregion
export { buildOpenAIResponsesProviderHooks, buildOpenAISyntheticCatalogEntry, cloneFirstTemplateModel, findCatalogTemplate, matchesExactOrPrefix, resolveConfiguredOpenAIBaseUrl, toOpenAIDataUrl };