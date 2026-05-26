import type { OpenClawConfig } from "./config.js";
type DangerousNameMatchingConfig = {
    dangerouslyAllowNameMatching?: boolean;
};
type ProviderDangerousNameMatchingScope = {
    prefix: string;
    account: Record<string, unknown>;
    dangerousNameMatchingEnabled: boolean;
    dangerousFlagPath: string;
};
type DangerousNameMatchingResolverInput = {
    providerConfig?: DangerousNameMatchingConfig | null | undefined;
    accountConfig?: DangerousNameMatchingConfig | null | undefined;
};
export declare function isDangerousNameMatchingEnabled(config: DangerousNameMatchingConfig | null | undefined): boolean;
export declare function resolveDangerousNameMatchingEnabled(input: DangerousNameMatchingResolverInput): boolean;
export declare function collectProviderDangerousNameMatchingScopes(cfg: OpenClawConfig, provider: string): ProviderDangerousNameMatchingScope[];
export {};
