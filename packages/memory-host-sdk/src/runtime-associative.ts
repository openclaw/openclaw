// Read-only associative context surface: topic boxes plus their linked tags/entities,
// for memory search ranking. No write APIs cross this boundary.
export {
  readAssociativeContext,
  type AssociativeBoxContext,
  type AssociativeContext,
  readTagCooccurrence,
  type TagGraphNeighbor,
  type TagGraphTargetRef,
  type TagGraphTraversal,
} from "./host/openclaw-runtime.js";
