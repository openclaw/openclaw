import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type MediaGenerationTaskHandle } from "./media-generate-background-shared.js";
export type MusicGenerationTaskHandle = MediaGenerationTaskHandle;
declare const musicGenerationTaskLifecycle: {
    createTaskRun(runParams: {
        sessionKey?: string;
        requesterOrigin?: import("../subagent-announce-origin.ts").DeliveryContext;
        prompt: string;
        providerId?: string;
    }): MediaGenerationTaskHandle | null;
    recordTaskProgress(progressParams: {
        handle: MediaGenerationTaskHandle | null;
        progressSummary: string;
        eventSummary?: string;
    }): void;
    completeTaskRun(completionParams: {
        handle: MediaGenerationTaskHandle | null;
        provider: string;
        model: string;
        count: number;
        paths: string[];
    }): void;
    failTaskRun(failureParams: {
        handle: MediaGenerationTaskHandle | null;
        error: unknown;
    }): void;
    wakeTaskCompletion(completionParams: {
        config?: OpenClawConfig;
        handle: MediaGenerationTaskHandle | null;
        status: "ok" | "error";
        statusLabel: string;
        result: string;
        mediaUrls?: string[];
        statsLine?: string;
    }): Promise<void>;
};
export declare const createMusicGenerationTaskRun: (...params: Parameters<typeof musicGenerationTaskLifecycle.createTaskRun>) => MediaGenerationTaskHandle | null;
export declare const recordMusicGenerationTaskProgress: (...params: Parameters<typeof musicGenerationTaskLifecycle.recordTaskProgress>) => void;
export declare const completeMusicGenerationTaskRun: (...params: Parameters<typeof musicGenerationTaskLifecycle.completeTaskRun>) => void;
export declare const failMusicGenerationTaskRun: (...params: Parameters<typeof musicGenerationTaskLifecycle.failTaskRun>) => void;
export declare function wakeMusicGenerationTaskCompletion(params: {
    config?: OpenClawConfig;
    handle: MusicGenerationTaskHandle | null;
    status: "ok" | "error";
    statusLabel: string;
    result: string;
    mediaUrls?: string[];
    statsLine?: string;
}): Promise<void>;
export {};
