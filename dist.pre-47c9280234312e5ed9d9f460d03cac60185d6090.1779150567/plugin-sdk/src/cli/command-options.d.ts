import type { Command } from "commander";
export declare function hasExplicitOptions(command: Command, names: readonly string[]): boolean;
export declare function inheritOptionFromParent<T = unknown>(command: Command | undefined, name: string): T | undefined;
