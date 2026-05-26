import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentGeneratedAttachment } from "../generated-attachments.js";
import { type MediaGenerationTaskHandle } from "./media-generate-background-shared.js";
export type ImageGenerationTaskHandle = MediaGenerationTaskHandle;
export declare const imageGenerationTaskLifecycle: {
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
export declare const createImageGenerationTaskRun: (...params: Parameters<typeof imageGenerationTaskLifecycle.createTaskRun>) => MediaGenerationTaskHandle | null;
export declare const recordImageGenerationTaskProgress: (...params: Parameters<typeof imageGenerationTaskLifecycle.recordTaskProgress>) => void;
export declare const completeImageGenerationTaskRun: (...params: Parameters<typeof imageGenerationTaskLifecycle.completeTaskRun>) => void;
export declare const failImageGenerationTaskRun: (...params: Parameters<typeof imageGenerationTaskLifecycle.failTaskRun>) => void;
export declare function wakeImageGenerationTaskCompletion(params: {
    config?: OpenClawConfig;
    handle: ImageGenerationTaskHandle | null;
    status: "ok" | "error";
    statusLabel: string;
    result: string;
    attachments?: AgentGeneratedAttachment[];
    mediaUrls?: string[];
    statsLine?: string;
}): Promise<boolean>;
