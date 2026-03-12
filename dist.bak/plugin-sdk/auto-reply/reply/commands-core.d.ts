import type { CommandHandlerResult, HandleCommandsParams } from "./commands-types.js";
export type ResetCommandAction = "new" | "reset";
export declare function emitResetCommandHooks(params: {
    action: ResetCommandAction;
    ctx: HandleCommandsParams["ctx"];
    cfg: HandleCommandsParams["cfg"];
    command: Pick<HandleCommandsParams["command"], "surface" | "senderId" | "channel" | "from" | "to" | "resetHookTriggered">;
    sessionKey?: string;
    sessionEntry?: HandleCommandsParams["sessionEntry"];
    previousSessionEntry?: HandleCommandsParams["previousSessionEntry"];
    workspaceDir: string;
}): Promise<void>;
export declare function handleCommands(params: HandleCommandsParams): Promise<CommandHandlerResult>;
