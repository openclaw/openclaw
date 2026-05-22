import type { AgentMessage } from "@earendil-works/pi-agent-core";
export type HardenedManualCompactionBoundary = {
    applied: boolean;
    firstKeptEntryId?: string;
    leafId?: string;
    messages: AgentMessage[];
};
export declare function hardenManualCompactionBoundary(params: {
    sessionFile: string;
    preserveRecentTail?: boolean;
}): Promise<HardenedManualCompactionBoundary>;
