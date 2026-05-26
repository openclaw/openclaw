//#region src/plugin-sdk/agent-dir-compat.d.ts
/**
 * @deprecated Prefer resolveAgentDir(cfg, agentId) or resolveDefaultAgentDir(cfg).
 * Kept for third-party plugin SDK compatibility.
 */
declare function resolveOpenClawAgentDir(env?: NodeJS.ProcessEnv): string;
//#endregion
export { resolveOpenClawAgentDir as t };