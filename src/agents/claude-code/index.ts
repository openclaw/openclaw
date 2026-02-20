/**
 * Claude Code spawn mode — barrel export.
 */

export { resolveClaudeBinary } from "./binary.js";
export { spawnClaudeCode, sendFollowUp, respondToPermission } from "./runner.js";
export {
  killClaudeCode,
  killAllClaudeCode,
  isClaudeCodeRunning,
  getLiveSession,
  getAllLiveSessions,
} from "./live-state.js";
export type { LiveSession } from "./live-state.js";
export {
  registryKey,
  resolveSession,
  saveSession,
  updateSessionStats,
  deleteSession,
  listSessions,
  listAllSessions,
} from "./sessions.js";
export { startMcpBridge } from "./mcp-bridge.js";
export type { McpBridgeHandle } from "./mcp-bridge.js";
export type {
  ClaudeCodeSubagentConfig,
  ClaudeCodePermissionMode,
  ClaudeCodeSpawnOptions,
  ClaudeCodeProgressEvent,
  ClaudeCodeResult,
  ClaudeCodeSessionEntry,
  ClaudeCodeSessionRegistry,
  ClaudeCodeTaskHistoryEntry,
} from "./types.js";
export type {
  CCOutboundMessage,
  CCInboundMessage,
  CCResultMessage,
  CCAssistantMessage,
  CCSystemMessage,
} from "./protocol.js";
