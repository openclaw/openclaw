import fs from "node:fs";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
export declare function isPrivateQaCliEnabled(env?: NodeJS.ProcessEnv): boolean;
export declare function loadPrivateQaCliModule(params?: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    argv1?: string;
    moduleUrl?: string;
    resolvePackageRootSync?: typeof resolveOpenClawPackageRootSync;
    existsSync?: typeof fs.existsSync;
    importModule?: (specifier: string) => Promise<Record<string, unknown>>;
}): Promise<Record<string, unknown>>;
