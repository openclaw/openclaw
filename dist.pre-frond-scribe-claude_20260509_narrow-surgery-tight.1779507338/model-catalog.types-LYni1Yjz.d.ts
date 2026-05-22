import { o as ModelCompatConfig } from "./types.models-tqxsISRc.js";

//#region src/agents/model-catalog.types.d.ts
type ModelInputType = "text" | "image" | "audio" | "video" | "document";
type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  alias?: string;
  contextWindow?: number;
  contextTokens?: number;
  reasoning?: boolean;
  input?: ModelInputType[];
  compat?: ModelCompatConfig;
};
//#endregion
export { ModelInputType as n, ModelCatalogEntry as t };