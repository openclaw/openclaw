import { readServiceStatusSummary } from "./status.service-summary.js";
type DaemonStatusSummary = {
    label: string;
    installed: boolean | null;
    loaded: boolean;
    managedByOpenClaw: boolean;
    externallyManaged: boolean;
    loadedText: string;
    runtime: Awaited<ReturnType<typeof readServiceStatusSummary>>["runtime"];
    runtimeShort: string | null;
    layout: Awaited<ReturnType<typeof readServiceStatusSummary>>["layout"];
};
export declare function getDaemonStatusSummary(): Promise<DaemonStatusSummary>;
export declare function getNodeDaemonStatusSummary(): Promise<DaemonStatusSummary>;
export {};
