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
  repoPathToSlug,
  resolveSession,
  saveSession,
  updateSessionStats,
  deleteSession,
  listSessions,
  listAllSessions,
  parseJsonlHeader,
  discoverSessions,
} from "./sessions.js";
export { startMcpBridge } from "./mcp-bridge.js";
export { gatherProjectStatus } from "./project-status.js";
export type { ProjectStatus } from "./project-status.js";
export {
  selectSession,
  assessTaskRelevance,
  keywordFallback,
  scoreSession,
  DEFAULT_SESSION_SELECTION_CONFIG,
} from "./session-selection.js";
export type {
  SessionSelection,
  SessionScore,
  ScoreFactors,
  TaskRelevanceResult,
} from "./session-selection.js";
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
  DiscoveredSession,
  JsonlHeader,
  SessionSelectionConfig,
} from "./types.js";
export type {
  CCOutboundMessage,
  CCInboundMessage,
  CCResultMessage,
  CCAssistantMessage,
  CCSystemMessage,
} from "./protocol.js";
