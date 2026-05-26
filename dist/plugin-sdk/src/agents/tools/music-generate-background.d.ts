import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentGeneratedAttachment } from "../generated-attachments.js";
import { type MediaGenerationTaskHandle } from "./media-generate-background-shared.js";
export type MusicGenerationTaskHandle = MediaGenerationTaskHandle;
export declare const musicGenerationTaskLifecycle: {
    createTaskRun: (params: {
        sessionKey?: string;
        requesterOrigin?: import("../subagent-announce-origin.ts").DeliveryContext;
        prompt: string;
        providerId?: string;
    }) => MediaGenerationTaskHandle | null;
    recordTaskProgress: (params: {
        handle: MediaGenerationTaskHandle | null;
        progressSummary: string;
        eventSummary?: string;
    }) => void;
    completeTaskRun: (params: {
        handle: MediaGenerationTaskHandle | null;
        provider: string;
        model: string;
        count: number;
        paths: string[];
    }) => void;
    failTaskRun: (params: {
        handle: MediaGenerationTaskHandle | null;
        error: unknown;
    }) => void;
    wakeTaskCompletion: (params: {
        config?: OpenClawConfig;
        handle: MediaGenerationTaskHandle | null;
        status: "ok" | "error";
        statusLabel: string;
        result: string;
        attachments?: AgentGeneratedAttachment[];
        mediaUrls?: string[];
        statsLine?: string;
    }) => Promise<boolean>;
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
    attachments?: AgentGeneratedAttachment[];
    mediaUrls?: string[];
    statsLine?: string;
}): Promise<boolean>;
