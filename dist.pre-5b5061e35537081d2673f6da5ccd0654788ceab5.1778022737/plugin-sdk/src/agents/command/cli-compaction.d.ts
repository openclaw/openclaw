import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { buildEmbeddedCompactionRuntimeContext } from "../pi-embedded-runner/compaction-runtime-context.js";
import { runContextEngineMaintenance as runContextEngineMaintenanceImpl } from "../pi-embedded-runner/context-engine-maintenance.js";
import { shouldPreemptivelyCompactBeforePrompt as shouldPreemptivelyCompactBeforePromptImpl } from "../pi-embedded-runner/run/preemptive-compaction.js";
import { resolveLiveToolResultMaxChars as resolveLiveToolResultMaxCharsImpl } from "../pi-embedded-runner/tool-result-truncation.js";
import type { SkillSnapshot } from "../skills.js";
import { recordCliCompactionInStore as recordCliCompactionInStoreImpl } from "./session-store.js";
type SessionManagerLike = ReturnType<typeof SessionManager.open>;
type SettingsManagerLike = {
    getCompactionReserveTokens: () => number;
    getCompactionKeepRecentTokens: () => number;
    applyOverrides: (overrides: {
        compaction: {
            reserveTokens?: number;
            keepRecentTokens?: number;
        };
    }) => void;
    setCompactionEnabled?: (enabled: boolean) => void;
};
type CliCompactionDeps = {
    openSessionManager: (sessionFile: string) => SessionManagerLike;
    resolveContextEngine: (cfg: OpenClawConfig) => Promise<ContextEngine>;
    createPreparedEmbeddedPiSettingsManager: (params: {
        cwd: string;
        agentDir: string;
        cfg?: OpenClawConfig;
        contextTokenBudget?: number;
    }) => SettingsManagerLike | Promise<SettingsManagerLike>;
    applyPiAutoCompactionGuard: (params: {
        settingsManager: SettingsManagerLike;
        contextEngineInfo?: ContextEngine["info"];
    }) => unknown;
    shouldPreemptivelyCompactBeforePrompt: typeof shouldPreemptivelyCompactBeforePromptImpl;
    resolveLiveToolResultMaxChars: typeof resolveLiveToolResultMaxCharsImpl;
    runContextEngineMaintenance: typeof runContextEngineMaintenanceImpl;
    recordCliCompactionInStore: typeof recordCliCompactionInStoreImpl;
};
declare const cliCompactionDeps: CliCompactionDeps;
export declare function setCliCompactionTestDeps(overrides: Partial<typeof cliCompactionDeps>): void;
export declare function resetCliCompactionTestDeps(): void;
export declare function runCliTurnCompactionLifecycle(params: {
    cfg: OpenClawConfig;
    sessionId: string;
    sessionKey: string;
    sessionEntry: SessionEntry | undefined;
    sessionStore?: Record<string, SessionEntry>;
    storePath?: string;
    sessionAgentId: string;
    workspaceDir: string;
    agentDir: string;
    provider: string;
    model: string;
    skillsSnapshot?: SkillSnapshot;
    messageChannel?: string;
    agentAccountId?: string;
    senderIsOwner?: boolean;
    thinkLevel?: Parameters<typeof buildEmbeddedCompactionRuntimeContext>[0]["thinkLevel"];
    extraSystemPrompt?: string;
}): Promise<SessionEntry | undefined>;
export {};
