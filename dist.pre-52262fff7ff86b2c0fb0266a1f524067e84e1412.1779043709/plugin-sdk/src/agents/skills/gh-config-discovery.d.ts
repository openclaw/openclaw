export type GhConfigDiscoveryEnv = {
    HOME?: string;
    XDG_CONFIG_HOME?: string;
    GH_CONFIG_DIR?: string;
    APPDATA?: string;
    SUDO_USER?: string;
    USER?: string;
    USERPROFILE?: string;
};
export type GhConfigDiscoveryInput = {
    platform: NodeJS.Platform;
    env: GhConfigDiscoveryEnv;
    fileExists: (absolutePath: string) => boolean;
    candidateOperatorHomes?: readonly string[];
};
export type GhConfigDirMismatch = {
    effectiveConfigDir: string;
    alternateConfigDir: string;
    alternateHostsFile: string;
    alternateHomeHint?: string;
    suggestedEnvValue: string;
};
export type GhConfigDiscoveryResult = {
    kind: "no-gh-binary";
} | {
    kind: "explicit-gh-config-dir-set";
    ghConfigDir: string;
} | {
    kind: "no-process-home";
} | {
    kind: "auth-discoverable";
    effectiveConfigDir: string;
} | {
    kind: "no-known-auth";
    effectiveConfigDir: string;
} | ({
    kind: "mismatch";
} & GhConfigDirMismatch);
export declare function detectGhConfigDirMismatch(input: GhConfigDiscoveryInput): GhConfigDiscoveryResult;
export declare function formatGhConfigDirMismatchHint(mismatch: GhConfigDirMismatch): string[];
