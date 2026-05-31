import type { ModelApi, ModelCompatConfig, ModelMediaInputConfig } from "../config/types.models.js";

/** Input modalities a model catalog row can advertise to tools and UI pickers. */
export type ModelInputType = "text" | "image" | "audio" | "video" | "document";

/** Normalized model catalog row shared by model selection, gateway lists, and media checks. */
export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  alias?: string;
  api?: ModelApi;
  contextWindow?: number;
  contextTokens?: number;
  reasoning?: boolean;
  input?: ModelInputType[];
  compat?: ModelCompatConfig;
  mediaInput?: ModelMediaInputConfig;
};
