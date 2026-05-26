//#region src/plugin-sdk/telegram-command-config.d.ts
/**
 * @deprecated Public SDK subpath has no bundled extension production imports.
 * Use plugin-local Telegram command config handling for new plugin code.
 */
type TelegramCustomCommandInput = {
  command?: string | null;
  description?: string | null;
};
type TelegramCustomCommandIssue = {
  index: number;
  field: "command" | "description";
  message: string;
};
declare function getTelegramCommandNamePattern(): RegExp;
declare const TELEGRAM_COMMAND_NAME_PATTERN: RegExp;
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
export { normalizeTelegramCommandDescription as a, getTelegramCommandNamePattern as i, TelegramCustomCommandInput as n, normalizeTelegramCommandName as o, TelegramCustomCommandIssue as r, resolveTelegramCustomCommands as s, TELEGRAM_COMMAND_NAME_PATTERN as t };