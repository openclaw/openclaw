import type { CommandArgValues } from "./commands-registry.types.js";
export type CommandArgsFormatter = (values: CommandArgValues) => string | undefined;
export declare const COMMAND_ARG_FORMATTERS: Record<string, CommandArgsFormatter>;
