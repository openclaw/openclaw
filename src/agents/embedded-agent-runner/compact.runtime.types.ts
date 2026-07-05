/**
 * Types for the lazy embedded-agent compaction runtime boundary.
 */
<<<<<<< HEAD
import type { CompactEmbeddedAgentSessionRuntimeParams } from "./compact.types.js";
=======
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import type { EmbeddedAgentCompactResult } from "./types.js";

/**
 * Lazy-runtime signature for direct embedded session compaction.
 */
export type CompactEmbeddedAgentSessionDirect = (
<<<<<<< HEAD
  params: CompactEmbeddedAgentSessionRuntimeParams,
=======
  params: CompactEmbeddedAgentSessionParams,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
) => Promise<EmbeddedAgentCompactResult>;
