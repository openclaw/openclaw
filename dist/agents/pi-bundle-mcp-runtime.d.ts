import { i as OpenClawConfig } from "../types.openclaw-BLF4DJTX.js";
import { n as SessionMcpRuntime, r as SessionMcpRuntimeManager } from "../pi-bundle-mcp-types-CatnStso.js";
import { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";

//#region src/agents/pi-bundle-mcp-runtime.d.ts
type CreateSessionMcpRuntime = (params: Parameters<typeof createSessionMcpRuntime>[0] & {
  configFingerprint?: string;
}) => SessionMcpRuntime;
declare function createBundleMcpJsonSchemaValidator(): jsonSchemaValidator;
declare function resolveSessionMcpRuntimeIdleTtlMs(cfg?: OpenClawConfig): number;
declare function createSessionMcpRuntime(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): SessionMcpRuntime;
declare function createSessionMcpRuntimeManager(opts?: {
  createRuntime?: CreateSessionMcpRuntime;
  now?: () => number;
  enableIdleSweepTimer?: boolean;
  idleSweepIntervalMs?: number;
}): SessionMcpRuntimeManager;
declare function getSessionMcpRuntimeManager(): SessionMcpRuntimeManager;
declare function getOrCreateSessionMcpRuntime(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): Promise<SessionMcpRuntime>;
declare function disposeSessionMcpRuntime(sessionId: string): Promise<void>;
declare function retireSessionMcpRuntime(params: {
  sessionId?: string | null;
  reason: string;
  onError?: (error: unknown, sessionId: string, reason: string) => void;
}): Promise<boolean>;
declare function retireSessionMcpRuntimeForSessionKey(params: {
  sessionKey?: string | null;
  reason: string;
  onError?: (error: unknown, sessionId: string, reason: string) => void;
}): Promise<boolean>;
declare function disposeAllSessionMcpRuntimes(): Promise<void>;
declare const testing: {
  createSessionMcpRuntimeManager: typeof createSessionMcpRuntimeManager;
  resetSessionMcpRuntimeManager(): Promise<void>;
  getCachedSessionIds(): string[];
  resolveSessionMcpRuntimeIdleTtlMs: typeof resolveSessionMcpRuntimeIdleTtlMs;
};
//#endregion
export { testing as __testing, testing, createBundleMcpJsonSchemaValidator, createSessionMcpRuntime, disposeAllSessionMcpRuntimes, disposeSessionMcpRuntime, getOrCreateSessionMcpRuntime, getSessionMcpRuntimeManager, retireSessionMcpRuntime, retireSessionMcpRuntimeForSessionKey };