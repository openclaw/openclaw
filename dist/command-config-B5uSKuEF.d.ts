//#region extensions/telegram/src/command-config.d.ts
declare const TELEGRAM_COMMAND_NAME_PATTERN: RegExp;
type TelegramCustomCommandInput = {
  command?: string | null;
  description?: string | null;
};
type TelegramCustomCommandIssue = {
  index: number;
  field: "command" | "description";
  message: string;
};
declare function normalizeTelegramCommandName(value: string): string;
declare function normalizeTelegramCommandDescription(value: string): string;
declare function resolveTelegramCustomCommands(params: {
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
//#endregion
export { normalizeTelegramCommandName as a, normalizeTelegramCommandDescription as i, TelegramCustomCommandInput as n, resolveTelegramCustomCommands as o, TelegramCustomCommandIssue as r, TELEGRAM_COMMAND_NAME_PATTERN as t };