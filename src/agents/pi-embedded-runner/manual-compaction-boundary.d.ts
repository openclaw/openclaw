import type { AgentMessage } from "@mariozechner/pi-agent-core";
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
