import type { CompactHit, FullHit } from "./retrieval-contract.js";

/** Narrow a tool hit; operator (non-agent) calls always receive full hits. */
export const isFullHit = (h: FullHit | CompactHit): h is FullHit => "citation" in h;
