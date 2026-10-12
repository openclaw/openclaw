import type { StdioOptions } from "node:child_process";

export type CliShimOptions = {
  implementation: string | URL;
  detached?: boolean;
  executable?: string;
  execArgv?: readonly string[];
  failureTool?: string;
  forceKillDelayMs?: number;
  stdio?: StdioOptions;
  terminationOwner?: "implementation";
  toolingDependencies?: string;
};

export function resolveForwardedNodeCompilerArgs(execArgv?: readonly string[]): string[];
export function resolveConfiguredModulesDir(checkoutRoot: string): string | undefined;
export function resolveTsxImport(checkoutRoot: string): string;
export function registerToolingTsx(): Promise<void>;
export function runNodeCliShim(moduleUrl: string | URL, options: CliShimOptions): Promise<void>;
export function runTsxCliShim(moduleUrl: string | URL, options: CliShimOptions): Promise<void>;
