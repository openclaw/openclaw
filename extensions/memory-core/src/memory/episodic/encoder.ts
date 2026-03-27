// Re-export episodic encoder from the canonical src/memory/episodic/encoder.ts.
// extensions/memory-core/src/memory/manager.ts imports from ./episodic/encoder.js;
// this shim makes that import resolvable without duplicating the implementation.
export { createEpisodeEncoder, EpisodeEncoder } from "../../../../src/memory/episodic/encoder.js";
export type { EncoderConfig } from "../../../../src/memory/episodic/encoder.js";
