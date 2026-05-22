export { parseClawHubPluginSpec } from "./clawhub-spec.js";
export type ClawHubPackageFamily = "skill" | "code-plugin" | "bundle-plugin";
export type ClawHubPackageChannel = "official" | "community" | "private";
export type ClawHubPackageCompatibility = {
    pluginApiRange?: string;
    builtWithOpenClawVersion?: string;
    pluginSdkVersion?: string;
    minGatewayVersion?: string;
};
export type ClawHubPackageHostTarget = {
    os?: string | null;
    arch?: string | null;
    libc?: string | null;
    key?: string | null;
};
export type ClawHubPackageEnvironmentSummary = {
    requiresLocalDesktop?: boolean;
    requiresBrowser?: boolean;
    requiresAudioDevice?: boolean;
    requiresNetwork?: boolean;
    requiresExternalServices?: string[];
    requiresOsPermissions?: string[];
    supportsRemoteHost?: boolean;
    knownUnsupported?: string[];
};
export type ClawHubPackageArtifactSummary = {
    kind?: string | null;
    sha256?: string | null;
    size?: number | null;
    format?: string | null;
    npmIntegrity?: string | null;
    npmShasum?: string | null;
    npmTarballName?: string | null;
    npmUnpackedSize?: number | null;
    npmFileCount?: number | null;
    downloadUrl?: string | null;
    tarballUrl?: string | null;
    legacyDownloadUrl?: string | null;
};
export type ClawHubArtifactKind = "legacy-zip" | "npm-pack";
export type ClawHubArtifactScanState = "pending" | "clean" | "suspicious" | "malicious" | "not-run" | (string & {});
export type ClawHubArtifactModerationState = "approved" | "quarantined" | "revoked" | (string & {});
export type ClawHubPackageSecurityState = "pending" | "approved" | "limited" | "quarantined" | "rejected" | "revoked" | (string & {});
export type ClawHubResolvedArtifact = {
    source: "clawhub";
    artifactKind: "legacy-zip";
    packageName: string;
    version: string;
    downloadUrl?: string | null;
    artifactSha256?: string | null;
    scanState?: ClawHubArtifactScanState | null;
    moderationState?: ClawHubArtifactModerationState | null;
} | {
    source: "clawhub";
    artifactKind: "npm-pack";
    packageName: string;
    version: string;
    downloadUrl?: string | null;
    npmIntegrity: string;
    npmShasum?: string | null;
    artifactSha256?: string | null;
    scanState?: ClawHubArtifactScanState | null;
    moderationState?: ClawHubArtifactModerationState | null;
};
export type ClawHubPackageArtifactResolverResponse = {
    package?: {
        name?: string | null;
        displayName?: string | null;
        family?: ClawHubPackageFamily | (string & {}) | null;
    } | null;
    version?: ({
        version?: string | null;
        createdAt?: number | null;
        changelog?: string | null;
        distTags?: string[];
        files?: unknown[];
        sha256hash?: string | null;
        compatibility?: ClawHubPackageCompatibility | null;
        artifact?: ClawHubPackageArtifactSummary | null;
        clawpack?: ClawHubPackageClawPackSummary | null;
    } & Record<string, unknown>) | string | null;
    artifact?: ClawHubResolvedArtifact | null;
};
export type ClawHubPackageSecurityResponse = {
    packageId?: string | null;
    releaseId?: string | null;
    state: ClawHubPackageSecurityState;
    reasonCode?: string | null;
    moderatorNote?: string | null;
    actorId?: string | null;
    createdAt?: number | null;
    scanState?: ClawHubArtifactScanState | null;
    moderationState?: ClawHubArtifactModerationState | null;
};
export type ClawHubPackageClawPackSummary = {
    available: boolean;
    specVersion?: number | null;
    format?: string | null;
    sha256?: string | null;
    size?: number | null;
    fileCount?: number | null;
    manifestSha256?: string | null;
    npmIntegrity?: string | null;
    npmShasum?: string | null;
    npmTarballName?: string | null;
    builtAt?: number | null;
    buildVersion?: string | null;
    hostTargets?: ClawHubPackageHostTarget[];
    environment?: ClawHubPackageEnvironmentSummary | null;
    runtimeBundles?: unknown[];
};
export type ClawHubPackageReadinessPhase = "planned" | "published" | "clawpack-ready" | "legacy-zip-only" | "metadata-ready" | "blocked" | "ready-for-openclaw" | (string & {});
export type ClawHubPackageReadiness = {
    ready?: boolean | null;
    readyForOpenClaw?: boolean | null;
    installReady?: boolean | null;
    phase?: ClawHubPackageReadinessPhase | null;
    status?: ClawHubPackageReadinessPhase | null;
    package?: {
        name?: string | null;
        family?: ClawHubPackageFamily | (string & {}) | null;
        channel?: ClawHubPackageChannel | (string & {}) | null;
        isOfficial?: boolean | null;
    } | null;
    packageName?: string | null;
    artifactKind?: ClawHubArtifactKind | (string & {}) | null;
    blockers?: string[];
    scanState?: ClawHubArtifactScanState | null;
    moderationState?: ClawHubArtifactModerationState | null;
};
export type ClawHubPackageListItem = {
    name: string;
    displayName: string;
    family: ClawHubPackageFamily;
    runtimeId?: string | null;
    channel: ClawHubPackageChannel;
    isOfficial: boolean;
    summary?: string | null;
    ownerHandle?: string | null;
    createdAt: number;
    updatedAt: number;
    latestVersion?: string | null;
    capabilityTags?: string[];
    executesCode?: boolean;
    verificationTier?: string | null;
    clawpackAvailable?: boolean;
    hostTargetKeys?: string[];
    environmentFlags?: string[];
    artifact?: ClawHubPackageArtifactSummary | null;
    clawpack?: ClawHubPackageClawPackSummary;
};
export type ClawHubPackageDetail = {
    package: (ClawHubPackageListItem & {
        tags?: Record<string, string>;
        compatibility?: ClawHubPackageCompatibility | null;
        capabilities?: {
            executesCode?: boolean;
            runtimeId?: string;
            capabilityTags?: string[];
            bundleFormat?: string;
            hostTargets?: string[];
            pluginKind?: string;
            channels?: string[];
            providers?: string[];
            hooks?: string[];
            bundledSkills?: string[];
        } | null;
        verification?: {
            tier?: string;
            scope?: string;
            summary?: string;
            sourceRepo?: string;
            sourceCommit?: string;
            hasProvenance?: boolean;
            scanStatus?: string;
        } | null;
        artifact?: ClawHubPackageArtifactSummary | null;
        clawpack?: ClawHubPackageClawPackSummary;
    }) | null;
    owner?: {
        handle?: string | null;
        displayName?: string | null;
        image?: string | null;
    } | null;
};
export type ClawHubPackageVersion = {
    package: {
        name: string;
        displayName: string;
        family: ClawHubPackageFamily;
    } | null;
    version: {
        version: string;
        createdAt: number;
        changelog: string;
        distTags?: string[];
        files?: Array<{
            path: string;
            size?: number;
            sha256: string;
            contentType?: string;
        }>;
        sha256hash?: string | null;
        compatibility?: ClawHubPackageCompatibility | null;
        capabilities?: ClawHubPackageDetail["package"] extends infer T ? T extends {
            capabilities?: infer C;
        } ? C : never : never;
        verification?: ClawHubPackageDetail["package"] extends infer T ? T extends {
            verification?: infer C;
        } ? C : never : never;
        artifact?: ClawHubPackageArtifactSummary | null;
        clawpack?: ClawHubPackageClawPackSummary;
    } | null;
};
export type ClawHubPackageSearchResult = {
    score: number;
    package: ClawHubPackageListItem;
};
export type ClawHubSkillSearchResult = {
    score: number;
    slug: string;
    displayName: string;
    summary?: string;
    version?: string;
    updatedAt?: number;
};
export type ClawHubSkillDetail = {
    skill: {
        slug: string;
        displayName: string;
        summary?: string;
        tags?: Record<string, string>;
        createdAt: number;
        updatedAt: number;
    } | null;
    latestVersion?: {
        version: string;
        createdAt: number;
        changelog?: string;
    } | null;
    metadata?: {
        os?: string[] | null;
        systems?: string[] | null;
    } | null;
    owner?: {
        handle?: string | null;
        displayName?: string | null;
        image?: string | null;
    } | null;
};
export type ClawHubSkillListResponse = {
    items: Array<{
        slug: string;
        displayName: string;
        summary?: string;
        tags?: Record<string, string>;
        latestVersion?: {
            version: string;
            createdAt: number;
            changelog?: string;
        } | null;
        metadata?: {
            os?: string[] | null;
            systems?: string[] | null;
        } | null;
        createdAt: number;
        updatedAt: number;
    }>;
    nextCursor?: string | null;
};
export type ClawHubDownloadResult = {
    archivePath: string;
    integrity: string;
    sha256Hex: string;
    artifact: "archive" | "clawpack";
    clawpackHeaderSha256?: string;
    clawpackHeaderSpecVersion?: number;
    npmIntegrity?: string;
    npmShasum?: string;
    npmTarballName?: string;
    cleanup: () => Promise<void>;
};
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export declare class ClawHubRequestError extends Error {
    readonly status: number;
    readonly requestPath: string;
    readonly responseBody: string;
    constructor(params: {
        path: string;
        status: number;
        body: string;
    });
}
export declare function resolveClawHubAuthToken(): Promise<string | undefined>;
export declare function resolveClawHubBaseUrl(baseUrl?: string): string;
export declare function normalizeClawHubSha256Integrity(value: string): string | null;
export declare function normalizeClawHubSha256Hex(value: string): string | null;
export declare function fetchClawHubPackageDetail(params: {
    name: string;
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
}): Promise<ClawHubPackageDetail>;
export declare function fetchClawHubPackageVersion(params: {
    name: string;
    version: string;
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
}): Promise<ClawHubPackageVersion>;
export declare function fetchClawHubPackageArtifact(params: {
    name: string;
    version: string;
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
}): Promise<ClawHubPackageArtifactResolverResponse>;
export declare function fetchClawHubPackageSecurity(params: {
    name: string;
    version: string;
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
}): Promise<ClawHubPackageSecurityResponse>;
export declare function fetchClawHubPackageReadiness(params: {
    name: string;
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
}): Promise<ClawHubPackageReadiness>;
export declare function searchClawHubPackages(params: {
    query: string;
    family?: ClawHubPackageFamily;
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    limit?: number;
}): Promise<ClawHubPackageSearchResult[]>;
export declare function searchClawHubSkills(params: {
    query: string;
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    limit?: number;
}): Promise<ClawHubSkillSearchResult[]>;
export declare function fetchClawHubSkillDetail(params: {
    slug: string;
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
}): Promise<ClawHubSkillDetail>;
export declare function listClawHubSkills(params: {
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    limit?: number;
}): Promise<ClawHubSkillListResponse>;
export declare function downloadClawHubPackageArchive(params: {
    name: string;
    version?: string;
    tag?: string;
    artifact?: "archive" | "clawpack";
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
}): Promise<ClawHubDownloadResult>;
export declare function downloadClawHubSkillArchive(params: {
    slug: string;
    version?: string;
    tag?: string;
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
}): Promise<ClawHubDownloadResult>;
export declare function resolveLatestVersionFromPackage(detail: ClawHubPackageDetail): string | null;
export declare function isClawHubFamilySkill(detail: ClawHubPackageDetail | ClawHubSkillDetail): boolean;
export declare function satisfiesPluginApiRange(pluginApiVersion: string, pluginApiRange?: string | null): boolean;
export declare function satisfiesGatewayMinimum(currentVersion: string, minGatewayVersion?: string | null): boolean;
