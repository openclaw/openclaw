import type { Command } from "commander";
export type QaRunnerCliRegistration = {
    commandName: string;
    register(qa: Command): void;
};
type QaRuntimeSurface = {
    defaultQaRuntimeModelForMode: (mode: string, options?: {
        alternate?: boolean;
        preferredLiveModel?: string;
    }) => string;
    startQaLiveLaneGateway: (...args: unknown[]) => Promise<unknown>;
};
export type QaRunnerCliContribution = {
    pluginId: string;
    commandName: string;
    description?: string;
    status: "available";
    registration: QaRunnerCliRegistration;
} | {
    pluginId: string;
    commandName: string;
    description?: string;
    status: "blocked";
};
export declare function loadQaRuntimeModule(): QaRuntimeSurface;
export declare function loadQaRunnerBundledPluginTestApi<T extends object>(pluginId: string): T;
export declare function isQaRuntimeAvailable(): boolean;
export declare function listQaRunnerCliContributions(): readonly QaRunnerCliContribution[];
export {};
