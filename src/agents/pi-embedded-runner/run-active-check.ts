/**
 * Lightweight re-export for plugins that only need to check whether an
 * embedded run is active.  Importing this module does NOT pull in the
 * full embedded-runner / agent-session stack, keeping the module graph
 * shallow for channel plugins.
 */
export { isEmbeddedPiRunActiveForSessionKey } from "./runs.js";
