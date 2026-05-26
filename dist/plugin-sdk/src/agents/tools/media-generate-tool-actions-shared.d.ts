import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type MediaGenerationCatalogKind } from "../../media-generation/catalog.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
type MediaGenerateActionResult = {
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: Record<string, unknown>;
};
type TaskStatusTextBuilder<Task> = (task: Task, params?: {
    duplicateGuard?: boolean;
}) => string;
type MediaGenerateProvider = {
    id: string;
    aliases?: string[];
    label?: string;
    defaultModel?: string;
    models?: readonly string[];
    capabilities: unknown;
    isConfigured?: (ctx: {
        cfg?: OpenClawConfig;
        agentDir?: string;
    }) => boolean;
};
export type { MediaGenerateActionResult };
export declare function createMediaGenerateProviderListActionResult<TProvider extends MediaGenerateProvider>(params: {
    kind: MediaGenerationCatalogKind;
    providers: TProvider[];
    emptyText: string;
    cfg?: OpenClawConfig;
    workspaceDir?: string;
    agentDir?: string;
    authStore?: AuthProfileStore;
    listModes: (provider: TProvider) => string[];
    summarizeCapabilities: (provider: TProvider) => string;
    formatAuthHint?: (provider: {
        id: string;
        authEnvVars: readonly string[];
    }) => string | undefined;
}): MediaGenerateActionResult;
export declare function createMediaGenerateTaskStatusActions<Task>(params: {
    inactiveText: string;
    findActiveTask: (sessionKey?: string) => Task | undefined;
    buildStatusText: TaskStatusTextBuilder<Task>;
    buildStatusDetails: (task: Task) => Record<string, unknown>;
}): {
    createStatusActionResult(sessionKey?: string): MediaGenerateActionResult;
    createDuplicateGuardResult(sessionKey?: string): MediaGenerateActionResult | undefined;
};
