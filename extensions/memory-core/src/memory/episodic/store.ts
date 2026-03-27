// Re-export EpisodicStore from the canonical src/memory/episodic/store.ts.
// extensions/memory-core/src/memory/manager.ts imports from ./episodic/store.js;
// this shim makes that import resolvable without duplicating the implementation.
export { EpisodicStore } from "../../../../../src/memory/episodic/store.js";
