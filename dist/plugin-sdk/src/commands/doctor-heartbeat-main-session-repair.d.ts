import { type resolveSessionFilePathOptions } from "../config/sessions/paths.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { note } from "../terminal/note.js";
type DoctorPrompterLike = {
    confirmRuntimeRepair: (params: {
        message: string;
        initialValue?: boolean;
        requiresInteractiveConfirmation?: boolean;
    }) => Promise<boolean>;
    note?: typeof note;
};
type TranscriptHeartbeatSummary = {
    inspectedMessages: number;
    userMessages: number;
    heartbeatUserMessages: number;
    nonHeartbeatUserMessages: number;
    assistantMessages: number;
    heartbeatOkAssistantMessages: number;
};
export type HeartbeatMainSessionRepairCandidate = {
    reason: "metadata" | "transcript";
    summary?: TranscriptHeartbeatSummary;
};
export declare function resolveHeartbeatMainSessionRepairCandidate(params: {
    entry: SessionEntry | undefined;
    transcriptPath?: string;
}): HeartbeatMainSessionRepairCandidate | null;
export declare function moveHeartbeatMainSessionEntry(params: {
    store: Record<string, SessionEntry>;
    mainKey: string;
    recoveredKey: string;
}): boolean;
export declare function clearTuiLastSessionPointers(params: {
    filePath: string;
    sessionKeys: ReadonlySet<string>;
}): number;
export declare function repairHeartbeatPoisonedMainSession(params: {
    cfg: OpenClawConfig;
    store: Record<string, SessionEntry>;
    absoluteStorePath: string;
    stateDir: string;
    sessionPathOpts: ReturnType<typeof resolveSessionFilePathOptions>;
    prompter: DoctorPrompterLike;
    warnings: string[];
    changes: string[];
}): Promise<void>;
export {};
