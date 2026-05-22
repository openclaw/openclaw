import type { CompactEmbeddedPiSessionParams } from "./compact.types.js";
import type { EmbeddedPiCompactResult } from "./types.js";
/**
 * Compacts a session with lane queueing (session lane + global lane).
 * Use this from outside a lane context. If already inside a lane, use
 * `compactEmbeddedPiSessionDirect` to avoid deadlocks.
 */
export declare function compactEmbeddedPiSession(params: CompactEmbeddedPiSessionParams): Promise<EmbeddedPiCompactResult>;
