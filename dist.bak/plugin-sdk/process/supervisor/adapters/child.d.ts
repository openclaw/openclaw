import type { SpawnProcessAdapter } from "../types.js";
export type ChildAdapter = SpawnProcessAdapter<NodeJS.Signals | null>;
export declare function createChildAdapter(params: {
    argv: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    windowsVerbatimArguments?: boolean;
    input?: string;
    stdinMode?: "inherit" | "pipe-open" | "pipe-closed";
}): Promise<ChildAdapter>;
