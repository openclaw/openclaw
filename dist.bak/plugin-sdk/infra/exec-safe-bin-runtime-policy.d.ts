import { type SafeBinProfile, type SafeBinProfileFixture, type SafeBinProfileFixtures } from "./exec-safe-bin-policy.js";
import { type WritableTrustedSafeBinDir } from "./exec-safe-bin-trust.js";
export type ExecSafeBinConfigScope = {
    safeBins?: string[] | null;
    safeBinProfiles?: SafeBinProfileFixtures | null;
    safeBinTrustedDirs?: string[] | null;
};
export declare function isInterpreterLikeSafeBin(raw: string): boolean;
export declare function listInterpreterLikeSafeBins(entries: Iterable<string>): string[];
export declare function resolveMergedSafeBinProfileFixtures(params: {
    global?: ExecSafeBinConfigScope | null;
    local?: ExecSafeBinConfigScope | null;
}): Record<string, SafeBinProfileFixture> | undefined;
export declare function resolveExecSafeBinRuntimePolicy(params: {
    global?: ExecSafeBinConfigScope | null;
    local?: ExecSafeBinConfigScope | null;
    onWarning?: (message: string) => void;
}): {
    safeBins: Set<string>;
    safeBinProfiles: Readonly<Record<string, SafeBinProfile>>;
    trustedSafeBinDirs: ReadonlySet<string>;
    unprofiledSafeBins: string[];
    unprofiledInterpreterSafeBins: string[];
    writableTrustedSafeBinDirs: ReadonlyArray<WritableTrustedSafeBinDir>;
};
