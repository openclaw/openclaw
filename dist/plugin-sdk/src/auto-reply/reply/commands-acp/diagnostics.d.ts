import type { CommandHandlerResult, HandleCommandsParams } from "../commands-types.js";
export declare function handleAcpDoctorAction(params: HandleCommandsParams, restTokens: string[]): Promise<CommandHandlerResult>;
export declare function handleAcpInstallAction(params: HandleCommandsParams, restTokens: string[]): CommandHandlerResult;
export declare function handleAcpSessionsAction(params: HandleCommandsParams, restTokens: string[]): CommandHandlerResult;
