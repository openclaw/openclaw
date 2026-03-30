import type { Command } from "commander";
type MemoryCommandOptions = {
    agent?: string;
    json?: boolean;
    deep?: boolean;
    index?: boolean;
    force?: boolean;
    verbose?: boolean;
};
export declare function runMemoryStatus(opts: MemoryCommandOptions): Promise<void>;
export declare function registerMemoryCli(program: Command): void;
export {};
