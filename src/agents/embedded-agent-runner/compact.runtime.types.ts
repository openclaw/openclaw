import type { CompactEmbeddedAgentSessionRuntimeParams } from "./compact.types.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

export type CompactEmbeddedAgentSessionDirect = (
  params: CompactEmbeddedAgentSessionRuntimeParams,
) => Promise<EmbeddedAgentCompactResult>;
