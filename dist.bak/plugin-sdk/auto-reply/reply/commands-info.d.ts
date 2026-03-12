import type { CommandHandler } from "./commands-types.js";
export declare const handleHelpCommand: CommandHandler;
export declare const handleCommandsListCommand: CommandHandler;
export declare function buildCommandsPaginationKeyboard(currentPage: number, totalPages: number, agentId?: string): Array<Array<{
    text: string;
    callback_data: string;
}>>;
export declare const handleStatusCommand: CommandHandler;
export declare const handleContextCommand: CommandHandler;
export declare const handleExportSessionCommand: CommandHandler;
export declare const handleWhoamiCommand: CommandHandler;
