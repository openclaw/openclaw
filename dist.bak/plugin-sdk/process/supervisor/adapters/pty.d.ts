import type { SpawnProcessAdapter } from "../types.js";
export type PtyAdapter = SpawnProcessAdapter;
export declare function createPtyAdapter(params: {
    shell: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    cols?: number;
    rows?: number;
    name?: string;
}): Promise<PtyAdapter>;
