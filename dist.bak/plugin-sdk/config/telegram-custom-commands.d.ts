export declare const TELEGRAM_COMMAND_NAME_PATTERN: RegExp;
export type TelegramCustomCommandInput = {
    command?: string | null;
    description?: string | null;
};
export type TelegramCustomCommandIssue = {
    index: number;
    field: "command" | "description";
    message: string;
};
export declare function normalizeTelegramCommandName(value: string): string;
export declare function normalizeTelegramCommandDescription(value: string): string;
export declare function resolveTelegramCustomCommands(params: {
    commands?: TelegramCustomCommandInput[] | null;
    reservedCommands?: Set<string>;
    checkReserved?: boolean;
    checkDuplicates?: boolean;
}): {
    commands: Array<{
        command: string;
        description: string;
    }>;
    issues: TelegramCustomCommandIssue[];
};
