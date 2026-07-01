/**
 * Types for the lazy embedded-agent compaction runtime boundary.
 */
import type { CompactEmbeddedAgentSessionRuntimeParams } from "./compact.types.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

/**
 * Lazy-runtime signature for direct embedded session compaction.
 */
export type CompactEmbeddedAgentSessionDirect = (
  params: CompactEmbeddedAgentSessionRuntimeParams,
) => Promise<EmbeddedAgentCompactResult>;
