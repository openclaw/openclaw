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
};
export declare function noteChromeMcpBrowserReadiness(cfg: OpenClawConfig, deps?: BrowserDoctorDeps): Promise<void>;
export {};
