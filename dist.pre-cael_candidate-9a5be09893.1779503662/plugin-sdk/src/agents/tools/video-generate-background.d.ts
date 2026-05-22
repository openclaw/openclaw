import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentGeneratedAttachment } from "../generated-attachments.js";
import { type MediaGenerationTaskHandle } from "./media-generate-background-shared.js";
export type VideoGenerationTaskHandle = MediaGenerationTaskHandle;
export declare const videoGenerationTaskLifecycle: {
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
export declare const createVideoGenerationTaskRun: (...params: Parameters<typeof videoGenerationTaskLifecycle.createTaskRun>) => MediaGenerationTaskHandle | null;
export declare const recordVideoGenerationTaskProgress: (...params: Parameters<typeof videoGenerationTaskLifecycle.recordTaskProgress>) => void;
export declare const completeVideoGenerationTaskRun: (...params: Parameters<typeof videoGenerationTaskLifecycle.completeTaskRun>) => void;
export declare const failVideoGenerationTaskRun: (...params: Parameters<typeof videoGenerationTaskLifecycle.failTaskRun>) => void;
export declare function wakeVideoGenerationTaskCompletion(params: {
    config?: OpenClawConfig;
    handle: VideoGenerationTaskHandle | null;
    status: "ok" | "error";
    statusLabel: string;
    result: string;
    attachments?: AgentGeneratedAttachment[];
    mediaUrls?: string[];
    statsLine?: string;
}): Promise<boolean>;
