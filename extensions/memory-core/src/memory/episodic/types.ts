// Re-export episodic types from the canonical location in src/memory/episodic/.
// extensions/memory-core lives alongside src/ in the same repo; these shims
// make `./episodic/*` imports in manager.ts resolvable without duplicating code.
export type {
  ConsolidationPattern,
  ConsolidationReport,
  EncodedEpisode,
  Episode,
  EpisodeAssociation,
  EpisodeSearchOptions,
  EpisodeSearchResult,
} from "../../../../src/memory/episodic/types.js";
