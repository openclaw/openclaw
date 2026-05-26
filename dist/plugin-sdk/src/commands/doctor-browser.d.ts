import type { OpenClawConfig } from "../config/types.openclaw.js";
import { note } from "../terminal/note.js";
type BrowserDoctorDeps = {
    platform?: NodeJS.Platform;
    noteFn?: typeof note;
    env?: NodeJS.ProcessEnv;
    getUid?: () => number;
    resolveManagedExecutable?: (resolved: unknown, platform: NodeJS.Platform) => {
        path: string;
    } | null;
    resolveChromeExecutable?: (platform: NodeJS.Platform) => {
        path: string;
    } | null;
    readVersion?: (executablePath: string) => string | null;
    configDir?: string;
    pathExists?: (targetPath: string) => boolean;
};
export type BrowserDoctorRepairDeps = {
    env?: NodeJS.ProcessEnv;
    configDir?: string;
    pathExists?: (targetPath: string) => boolean;
    movePathToTrash?: (targetPath: string) => Promise<string>;
};
export type LegacyClawdBrowserProfileResidue = {
    legacyProfileDir: string;
    legacyUserDataDir: string;
    canonicalUserDataDir: string;
};
export declare function noteChromeMcpBrowserReadiness(cfg: OpenClawConfig, deps?: BrowserDoctorDeps): Promise<void>;
export declare function detectLegacyClawdBrowserProfileResidue(cfg: OpenClawConfig, deps?: BrowserDoctorRepairDeps): Promise<LegacyClawdBrowserProfileResidue | null>;
export declare function maybeArchiveLegacyClawdBrowserProfileResidue(cfg: OpenClawConfig, deps?: BrowserDoctorRepairDeps): Promise<{
    changes: string[];
    warnings: string[];
}>;
export {};
