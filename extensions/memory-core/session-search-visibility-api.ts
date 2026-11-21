// Cross-plugin consumers need the visibility policy without loading dreaming dependencies.
export {
  filterMemorySearchHitsBySessionVisibility,
  prepareMemorySearchChannelRead,
  type MemorySearchChannelRead,
  type MemorySearchChannelTargets,
} from "./src/session-search-visibility.js";
