export const FLAG_TERMINATOR: "--";

export function isValueToken(arg: string | undefined): boolean;
export function consumeRootOptionToken(args: ReadonlyArray<string>, index: number): number;
export function consumeRootCommandOptionToken(args: readonly string[], index: number): number;
export function getRootOptionAwareCommandPath(argv: readonly string[], depth: number): string[];

type CommandPositionalsParseOptions = {
  commandPath: ReadonlyArray<string>;
  booleanFlags?: ReadonlyArray<string>;
  valueFlags?: ReadonlyArray<string>;
  maxPositionals?: number;
  mode?: "route" | "command-path";
};

export function getCommandPositionalsWithRootOptions(
  argv: readonly string[],
  options: CommandPositionalsParseOptions,
): string[] | null;
export function getCommandArgsWithRootOptions(
  argv: readonly string[],
  options: Omit<CommandPositionalsParseOptions, "maxPositionals">,
): string[] | null;
export function getCommandOptionsWithRootOptions(
  argv: readonly string[],
  options: Omit<CommandPositionalsParseOptions, "maxPositionals">,
): { rootOptions: string[]; commandOptions: string[] } | null;

export function rewriteUpdateFlagArgv(argv: string[]): string[];

export const UPDATE_OPTION_SPECS: readonly [
  flags: string,
  description: string,
  defaultValue?: boolean,
][];
export function getUpdateCommandPath(argv: readonly string[]): string[] | null;
