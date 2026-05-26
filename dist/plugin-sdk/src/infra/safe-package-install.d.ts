import type { NpmProjectInstallEnvOptions } from "./npm-install-env.js";
type SafeNpmInstallEnvOptions = NpmProjectInstallEnvOptions & {
    ignoreWorkspaces?: boolean;
    legacyPeerDeps?: boolean;
    packageLock?: boolean;
    quiet?: boolean;
};
type SafeNpmInstallArgsOptions = {
    ignoreWorkspaces?: boolean;
    legacyPeerDeps?: boolean;
    loglevel?: "error" | "silent";
    noAudit?: boolean;
    noFund?: boolean;
    omitDev?: boolean;
    omitPeer?: boolean;
};
export declare function createSafeNpmInstallEnv(env: NodeJS.ProcessEnv, options?: SafeNpmInstallEnvOptions): NodeJS.ProcessEnv;
export declare function createSafeNpmInstallArgs(options?: SafeNpmInstallArgsOptions): string[];
export {};
