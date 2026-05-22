export type CommandArgValue = string | number | boolean | bigint;
export type CommandArgValues = Record<string, CommandArgValue>;
export type CommandArgs = {
    raw?: string;
    values?: CommandArgValues;
};
