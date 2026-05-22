export declare const MIN_HOST_VERSION_FORMAT = "openclaw.install.minHostVersion must use a semver floor in the form \">=x.y.z[-prerelease][+build]\"";
export type MinHostVersionRequirement = {
    raw: string;
    minimumLabel: string;
};
export type MinHostVersionCheckResult = {
    ok: true;
    requirement: MinHostVersionRequirement | null;
} | {
    ok: false;
    kind: "invalid";
    error: string;
} | {
    ok: false;
    kind: "unknown_host_version";
    requirement: MinHostVersionRequirement;
} | {
    ok: false;
    kind: "incompatible";
    requirement: MinHostVersionRequirement;
    currentVersion: string;
};
export declare function parseMinHostVersionRequirement(raw: unknown, options?: {
    allowLegacyBareSemver?: boolean;
}): MinHostVersionRequirement | null;
export declare function validateMinHostVersion(raw: unknown): string | null;
export declare function checkMinHostVersion(params: {
    currentVersion: string | undefined;
    minHostVersion: unknown;
    allowLegacyBareSemver?: boolean;
}): MinHostVersionCheckResult;
