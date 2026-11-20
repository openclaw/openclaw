import type {
  ModelCatalogContextWindowOption,
  ModelCatalogStatus,
  ModelInferenceCapabilities,
} from "@openclaw/model-catalog-core/model-catalog-types";
import type { ModelDataMediaInputConfig as ModelMediaInputConfig } from "../../packages/llm-core/src/model-data.js";
import type { ModelApi } from "../config/model-config-vocabulary.js";
import type { ModelCompatConfig } from "../config/zod-schema.model-compat.js";
import type { ThinkingLevelMap } from "../llm/types.js";

export type ModelInputType = "text" | "image" | "audio" | "video" | "document";

export type ModelCatalogEntry = {
  /** Native catalog owner, not a physical provider route or transferable readiness fact. */
  nativeRuntime?: string;
  id: string;
  name: string;
  provider: string;
  /** Provider-owned strongest-first picker order; internal and never projected to clients. */
  providerOrder?: number;
  alias?: string;
  api?: ModelApi;
  /** Declared task support for the exact physical route; not authorization or readiness. */
  inference?: ModelInferenceCapabilities;
  /** Private transport provenance for route matching; never project directly to clients. */
  baseUrl?: string;
  contextWindow?: number;
  contextWindows?: ModelCatalogContextWindowOption[];
  contextWindowDefault?: string;
  contextTokens?: number;
  /** Provider/catalog-declared total parameter count. */
  parameterCount?: number;
  /** Provider/catalog-declared developer lineage for this exact route; never inferred from ids. */
  family?: string;
  /** Visible failed-acquisition starter; sizing comes from current static or accepted owner facts. */
  contextCapacitySource?: "unaccepted-starter";
  /** Provider-declared unknown-model estimate; not an authored or curated static limit. */
  contextWindowSource?: "synthetic";
  reasoning?: boolean;
  /** Config-authored reasoning override; internal provenance, never project to clients. */
  configuredReasoning?: boolean;
  /** Concrete runtime owner of thinking policy; internal and never project to clients. */
  thinkingPolicyProvider?: string;
  /** Provider-owned effort support for this exact physical model route. */
  thinkingLevelMap?: ThinkingLevelMap;
  input?: ModelInputType[];
  params?: Record<string, unknown>;
  compat?: ModelCompatConfig;
  mediaInput?: ModelMediaInputConfig;
  status?: ModelCatalogStatus;
  statusReason?: string;
  replaces?: string[];
  replacedBy?: string;
};
