import type { PluginHookAfterToolCallEvent, PluginHookBeforeMessageWriteEvent, PluginHookMessageContext, PluginHookMessageReceivedEvent, PluginHookSubagentContext, PluginHookSubagentEndedEvent, PluginHookSubagentSpawnedEvent, PluginHookToolContext, PluginHookToolResultPersistContext, PluginHookToolResultPersistEvent } from "../../types.js";
import type { RelationshipIndexUpdate } from "./store.js";
type SessionWorkspaceInfo = {
    workspaceDir?: string;
    repoRoot?: string;
};
export declare function buildMessageReceivedGraphUpdate(event: PluginHookMessageReceivedEvent, ctx: PluginHookMessageContext): RelationshipIndexUpdate;
export declare function buildAfterToolCallGraphUpdate(event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext, workspace: SessionWorkspaceInfo): RelationshipIndexUpdate;
export declare function buildToolResultPersistGraphUpdate(event: PluginHookToolResultPersistEvent, ctx: PluginHookToolResultPersistContext, workspace: SessionWorkspaceInfo): RelationshipIndexUpdate;
export declare function buildBeforeMessageWriteGraphUpdate(event: PluginHookBeforeMessageWriteEvent, workspace: SessionWorkspaceInfo): RelationshipIndexUpdate;
export declare function buildSubagentSpawnedGraphUpdate(event: PluginHookSubagentSpawnedEvent, ctx: PluginHookSubagentContext, workspace: SessionWorkspaceInfo): RelationshipIndexUpdate;
export declare function buildSubagentEndedGraphUpdate(event: PluginHookSubagentEndedEvent, ctx: PluginHookSubagentContext): RelationshipIndexUpdate;
export {};
