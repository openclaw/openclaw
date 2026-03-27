// Re-export EpisodicSearch from the canonical src/memory/episodic/search.ts.
// extensions/memory-core/src/memory/manager.ts imports from ./episodic/search.js;
// this shim makes that import resolvable without duplicating the implementation.
export { EpisodicSearch } from "../../../../../src/memory/episodic/search.js";
