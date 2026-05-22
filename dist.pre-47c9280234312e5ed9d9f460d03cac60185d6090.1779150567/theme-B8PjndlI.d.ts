import * as _$chalk from "chalk";
import { Command } from "commander";

//#region src/cli/cli-utils.d.ts
type ManagerLookupResult<T> = {
  manager: T | null;
  error?: string;
};
declare function withManager<T>(params: {
  getManager: () => Promise<ManagerLookupResult<T>>;
  onMissing: (error?: string) => void;
  run: (manager: T) => Promise<void>;
  close: (manager: T) => Promise<void>;
  onCloseError?: (err: unknown) => void;
}): Promise<void>;
declare function runCommandWithRuntime(runtime: {
  error: (message: string) => void;
  exit: (code: number) => void;
}, action: () => Promise<void>, onError?: (error: unknown) => void): Promise<void>;
//#endregion
//#region src/cli/help-format.d.ts
type HelpExample = readonly [command: string, description: string];
declare function formatHelpExamples(examples: ReadonlyArray<HelpExample>, inline?: boolean): string;
//#endregion
//#region src/cli/parse-duration.d.ts
type DurationMsParseOptions = {
  defaultUnit?: "ms" | "s" | "m" | "h" | "d";
};
declare function parseDurationMs(raw: string, opts?: DurationMsParseOptions): number;
//#endregion
//#region src/terminal/theme.d.ts
declare const theme: {
  readonly accent: _$chalk.ChalkInstance;
  readonly accentBright: _$chalk.ChalkInstance;
  readonly accentDim: _$chalk.ChalkInstance;
  readonly info: _$chalk.ChalkInstance;
  readonly success: _$chalk.ChalkInstance;
  readonly warn: _$chalk.ChalkInstance;
  readonly error: _$chalk.ChalkInstance;
  readonly muted: _$chalk.ChalkInstance;
  readonly heading: _$chalk.ChalkInstance;
  readonly command: _$chalk.ChalkInstance;
  readonly option: _$chalk.ChalkInstance;
};
declare const isRich: () => boolean;
declare const colorize: (rich: boolean, color: (value: string) => string, value: string) => string;
//#endregion
export { parseDurationMs as a, withManager as c, DurationMsParseOptions as i, isRich as n, formatHelpExamples as o, theme as r, runCommandWithRuntime as s, colorize as t };