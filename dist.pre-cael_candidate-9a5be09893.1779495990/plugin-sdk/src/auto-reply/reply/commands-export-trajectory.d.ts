import { createExecTool } from "../../agents/bash-tools.js";
import type { ReplyPayload } from "../types.js";
import { type PrivateCommandRouteTarget } from "./commands-private-route.js";
import type { HandleCommandsParams } from "./commands-types.js";
type ExportTrajectoryCommandDeps = {
    createExecTool: typeof createExecTool;
    resolvePrivateTrajectoryTargets: (params: HandleCommandsParams, request: TrajectoryExportExecRequest) => Promise<PrivateCommandRouteTarget[]>;
    deliverPrivateTrajectoryReply: (params: {
        commandParams: HandleCommandsParams;
        targets: PrivateCommandRouteTarget[];
        reply: ReplyPayload;
    }) => Promise<boolean>;
};
export declare function buildExportTrajectoryCommandReply(params: HandleCommandsParams, deps?: Partial<ExportTrajectoryCommandDeps>): Promise<ReplyPayload>;
export declare function buildExportTrajectoryReply(params: HandleCommandsParams): Promise<ReplyPayload>;
type TrajectoryExportCliRequest = {
    sessionKey: string;
    workspace: string;
    output?: string;
    store?: string;
    agent?: string;
};
type TrajectoryExportExecRequest = {
    argv: string[];
    command: string;
    displayCommand: string;
    encodedRequest: string;
    request: TrajectoryExportCliRequest;
};
export {};
