import type { Command } from "commander";
type JsonMode = "output" | "parse-only";
export declare function setCommandJsonMode(command: Command, mode: JsonMode): Command;
export declare function isCommandJsonOutputMode(command: Command, argv?: string[]): boolean;
export {};
