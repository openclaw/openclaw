// Episodic memory engine surface — CLS-inspired hippocampal memory layer.
// Exposes the encoder, store, search, and types needed by the memory-core
// extension without requiring cross-boundary src/ imports.

export { EpisodeEncoder, createEpisodeEncoder } from "../../../src/memory/episodic/encoder.js";
export type { EncoderConfig } from "../../../src/memory/episodic/encoder.js";
export { EpisodicStore } from "../../../src/memory/episodic/store.js";
export { EpisodicSearch } from "../../../src/memory/episodic/search.js";
export type {
  ConsolidationPattern,
  ConsolidationReport,
  EncodedEpisode,
  Episode,
  EpisodeAssociation,
  EpisodeSearchOptions,
  EpisodeSearchResult,
} from "../../../src/memory/episodic/types.js";
