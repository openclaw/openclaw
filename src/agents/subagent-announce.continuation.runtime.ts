// Co-located runtime entry for subagent-announce continuation drain.
//
// `subagent-announce.ts` lazy-loads
// `../auto-reply/continuation/delegate-dispatch.js` via
// `importRuntimeModule(import.meta.url, [...])`. The bundler does not rewrite
// the path expression inside `importRuntimeModule`, and the flat-dist emission
// drops the source-tree subdirectory, so at runtime the import resolves to a
// non-existent nested path and fails with `ERR_MODULE_NOT_FOUND`.
//
// The fix mirrors `subagent-registry.runtime.ts`: declare a co-located runtime
// entry whose path resolves cleanly post-bundle, and route the dynamic import
// through it. This keeps the cycle-avoidance property of the lazy import
// (delegate-dispatch never enters the static graph of subagent-announce)
// while giving the bundler a stable on-disk target.
//
// Registered as a tsdown bundler entry: `subagent-announce.continuation.runtime`
// in `tsdown.config.ts`.
export { dispatchToolDelegates } from "../auto-reply/continuation/delegate-dispatch.js";
export {
  loadContinuationChainState,
  persistContinuationChainState,
} from "../auto-reply/continuation/state.js";
export { updateSessionStore } from "../config/sessions/store.js";
export { resolveStorePath, resolveAgentIdFromSessionKey } from "../config/sessions.js";
