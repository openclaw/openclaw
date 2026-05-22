//#region src/auto-reply/commands-args.types.d.ts
type CommandArgValue = string | number | boolean | bigint;
type CommandArgValues = Record<string, CommandArgValue>;
type CommandArgs = {
  raw?: string;
  values?: CommandArgValues;
};
//#endregion
export { CommandArgs as n, CommandArgValues as t };