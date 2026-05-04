import type { ModelCompatConfig } from "../config/types.models.js";

export type ModelInputType = "text" | "image" | "audio" | "video" | "document";

export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  alias?: string;
  catalogSource?: "provider-supplemental";
  contextWindow?: number;
  reasoning?: boolean;
  input?: ModelInputType[];
  compat?: ModelCompatConfig;
};
