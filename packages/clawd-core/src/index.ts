/**
 * Clawd Core - Standalone AI agent with workspace and skills
 *
 * This package provides:
 * - Agent runner with full conversation loop
 * - Session management and persistence
 * - Workspace system with bootstrap files (IDENTITY.md, SOUL.md, etc.)
 * - Skills system for extending agent capabilities
 * - Core tools (bash, file operations)
 *
 * @example
 * ```ts
 * import { runClawdAgent, loadConfig } from "clawd-core";
 *
 * const config = loadConfig();
 * const result = await runClawdAgent({
 *   message: "Hello! Who are you?",
 *   config,
 *   onTextChunk: (text) => process.stdout.write(text),
 * });
 * ```
 */

// Agents
export * from "./agents/index.js";
// Config
export * from "./config/index.js";

// Tools
export * from "./tools/index.js";

// Utils
export * from "./utils/index.js";
