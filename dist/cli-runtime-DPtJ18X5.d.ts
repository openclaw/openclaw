import { Command } from "commander";

//#region src/cli/command-options.d.ts
declare function inheritOptionFromParent<T = unknown>(command: Command | undefined, name: string): T | undefined;
//#endregion
//#region src/cli/program/register-command-groups.d.ts
type CommandGroupPlaceholder = {
  name: string;
  description: string;
  options?: readonly CommandGroupPlaceholderOption[];
};
type CommandGroupPlaceholderOption = {
  flags: string;
  description: string;
};
type CommandGroupEntry = {
  placeholders: readonly CommandGroupPlaceholder[];
  names?: readonly string[];
  register: (program: Command) => Promise<void> | void;
};
declare function registerCommandGroups(program: Command, entries: readonly CommandGroupEntry[], params: {
  eager: boolean;
  primary: string | null;
  registerPrimaryOnly: boolean;
}): void;
//#endregion
//#region src/cli/argv-invocation.d.ts
type CliArgvInvocation = {
  argv: string[];
  commandPath: string[];
  primary: string | null;
  hasHelpOrVersion: boolean;
  isRootHelpInvocation: boolean;
};
declare function resolveCliArgvInvocation(argv: string[]): CliArgvInvocation;
//#endregion
//#region src/cli/command-registration-policy.d.ts
declare function shouldEagerRegisterSubcommands(env?: NodeJS.ProcessEnv): boolean;
//#endregion
//#region src/terminal/note.d.ts
declare function note(message: unknown, title?: string): void;
//#endregion
//#region src/terminal/prompt-style.d.ts
declare const stylePromptTitle: (title?: string) => string | undefined;
//#endregion
export { resolveCliArgvInvocation as a, registerCommandGroups as c, CliArgvInvocation as i, inheritOptionFromParent as l, note as n, CommandGroupEntry as o, shouldEagerRegisterSubcommands as r, CommandGroupPlaceholder as s, stylePromptTitle as t };