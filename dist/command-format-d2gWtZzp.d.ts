//#region src/cli/command-format.d.ts
declare function formatCliCommand(command: string, env?: Record<string, string | undefined>): string;
//#endregion
export { formatCliCommand as t };