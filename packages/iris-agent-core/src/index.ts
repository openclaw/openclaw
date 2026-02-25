/**
 * @mariozechner/pi-agent-core — iris-claw fork
 *
 * Drop-in replacement for the original pi-agent-core with parallel tool execution.
 * All imports of @mariozechner/pi-agent-core across the dependency tree now use
 * this package via pnpm.overrides, giving the full stack the parallel engine.
 */

export * from "./types.js";
export * from "./agent-loop.js";
export * from "./agent.js";
export * from "./proxy.js";
export * from "./context-compressor.js";
