import { isNodeVersionManagerRuntime, resolveLinuxSystemCaBundle } from "../bootstrap/node-extra-ca-certs.js";
export { isNodeVersionManagerRuntime, resolveLinuxSystemCaBundle };
type MinimalServicePathOptions = {
    platform?: NodeJS.Platform;
    extraDirs?: string[];
    includeUserDirs?: boolean;
    home?: string;
    cwd?: string;
    env?: Record<string, string | undefined>;
    existsSync?: (candidate: string) => boolean;
    includeMissingUserBinDefaults?: boolean;
};
type BuildServicePathOptions = MinimalServicePathOptions & {
    env?: Record<string, string | undefined>;
};
export declare const SERVICE_PROXY_ENV_KEYS: readonly ["OPENCLAW_PROXY_URL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy"];
export declare function getMinimalServicePathParts(options?: MinimalServicePathOptions): string[];
export declare function getMinimalServicePathPartsFromEnv(options?: BuildServicePathOptions): string[];
export declare function buildMinimalServicePath(options?: BuildServicePathOptions): string;
export declare function buildServiceEnvironment(params: {
    env: Record<string, string | undefined>;
    port: number;
    launchdLabel?: string;
    platform?: NodeJS.Platform;
    extraPathDirs?: string[];
    execPath?: string;
}): Record<string, string | undefined>;
export declare function buildNodeServiceEnvironment(params: {
    env: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
    extraPathDirs?: string[];
    execPath?: string;
}): Record<string, string | undefined>;
