import type { ProgressReporter } from "../../cli/progress.js";
import { appendStatusAllDiagnosis } from "./diagnosis.js";
type OverviewRow = {
    Item: string;
    Value: string;
};
type ChannelsTable = {
    rows: Array<{
        id: string;
        label: string;
        enabled: boolean;
        state: "ok" | "warn" | "off" | "setup";
        detail: string;
    }>;
    details: Array<{
        title: string;
        columns: string[];
        rows: Array<Record<string, string>>;
    }>;
};
type ChannelIssueLike = {
    channel: string;
    message: string;
};
type AgentStatusLike = {
    agents: Array<{
        id: string;
        name?: string | null;
        bootstrapPending?: boolean | null;
        sessionsCount: number;
        lastActiveAgeMs?: number | null;
        sessionsPath: string;
    }>;
};
export declare function buildStatusAllReportLines(params: {
    progress: ProgressReporter;
    overviewRows: OverviewRow[];
    channels: ChannelsTable;
    channelIssues: ChannelIssueLike[];
    agentStatus: AgentStatusLike;
    connectionDetailsForReport: string;
    diagnosis: Omit<Parameters<typeof appendStatusAllDiagnosis>[0], "lines" | "progress" | "muted" | "ok" | "warn" | "fail" | "connectionDetailsForReport">;
}): Promise<string[]>;
export {};
