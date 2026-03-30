import type { CommandHandlerResult, HandleCommandsParams } from "../commands-types.js";
export declare function handleAcpSpawnAction(params: HandleCommandsParams, restTokens: string[]): Promise<CommandHandlerResult>;
export declare function handleAcpCancelAction(params: HandleCommandsParams, restTokens: string[]): Promise<CommandHandlerResult>;
export declare function handleAcpSteerAction(params: HandleCommandsParams, restTokens: string[]): Promise<CommandHandlerResult>;
export declare function handleAcpCloseAction(params: HandleCommandsParams, restTokens: string[]): Promise<CommandHandlerResult>;
