#!/usr/bin/env bun
/**
 * Bun-optimized entry point for openclaw.
 * Used when OPENCLAW_RUNTIME=bun is set.
 * Bun has native TypeScript support and faster startup.
 */

// Bun has built-in compile cache, no need for module.enableCompileCache
await import("./dist/entry.js");
