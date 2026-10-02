/** Chrome MCP existing-session adapter public facade. */
export { ChromeMcpDocumentUnavailableError } from "./chrome-mcp-contracts.js";
export type { ChromeMcpOperationOptions, ChromeMcpProfileOptions } from "./chrome-mcp-contracts.js";
export { parseChromeMcpUnixProcessListForTest } from "./chrome-mcp-process.js";
export {
  closeChromeMcpSession,
  getChromeMcpPid,
  resetChromeMcpSessionsForTest,
  setChromeMcpProcessCleanupDepsForTest,
  setChromeMcpSessionFactoryForTest,
} from "./chrome-mcp-session.js";
export {
  countChromeMcpTabs,
  ensureChromeMcpAvailable,
  listChromeMcpTabs,
  openChromeMcpTab,
} from "./chrome-mcp-tabs.js";
export {
  clickChromeMcpCoords,
  clickChromeMcpElement,
  closeChromeMcpTab,
  dragChromeMcpElement,
  evaluateChromeMcpScript,
  fillChromeMcpElement,
  fillChromeMcpForm,
  focusChromeMcpTab,
  hoverChromeMcpElement,
  navigateChromeMcpPage,
  pressChromeMcpKey,
  resizeChromeMcpPage,
  selectChromeMcpOption,
  resolveChromeMcpNavigateCallTimeoutMs,
  takeChromeMcpScreenshot,
  takeChromeMcpSnapshot,
  uploadChromeMcpFile,
  withChromeMcpDocument,
} from "./chrome-mcp-actions.js";
