import type { DatabaseSync } from "node:sqlite";
export declare function loadSqliteVecExtension(params: {
    db: DatabaseSync;
    extensionPath?: string;
}): Promise<{
    ok: boolean;
    extensionPath?: string;
    error?: string;
}>;
