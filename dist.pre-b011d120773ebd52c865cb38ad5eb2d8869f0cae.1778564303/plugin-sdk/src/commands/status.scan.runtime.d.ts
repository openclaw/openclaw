import { collectChannelStatusIssues } from "../infra/channels-status-issues.js";
import { buildChannelsTable } from "./status-all/channels.js";
export declare const statusScanRuntime: {
    collectChannelStatusIssues: typeof collectChannelStatusIssues;
    buildChannelsTable: typeof buildChannelsTable;
};
