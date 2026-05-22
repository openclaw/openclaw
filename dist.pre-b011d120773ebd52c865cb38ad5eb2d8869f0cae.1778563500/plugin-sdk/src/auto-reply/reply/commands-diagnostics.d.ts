import { createExecTool } from "../../agents/bash-tools.js";
import type { ReplyPayload } from "../types.js";
import { type PrivateCommandRouteTarget } from "./commands-private-route.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";
type DiagnosticsCommandDeps = {
    createExecTool: typeof createExecTool;
    resolvePrivateDiagnosticsTargets: (params: HandleCommandsParams) => Promise<PrivateCommandRouteTarget[]>;
    deliverPrivateDiagnosticsReply: (params: {
        commandParams: HandleCommandsParams;
        targets: PrivateCommandRouteTarget[];
        reply: ReplyPayload;
    }) => Promise<boolean>;
};
export declare function createDiagnosticsCommandHandler(deps?: Partial<DiagnosticsCommandDeps>): CommandHandler;
export declare const handleDiagnosticsCommand: CommandHandler;
export {};
