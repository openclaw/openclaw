type PluginPeerLinkLogger = {
    info?: (message: string) => void;
    warn?: (message: string) => void;
};
type RelinkManagedNpmRootResult = {
    checked: number;
    attempted: number;
    repaired: number;
    skipped: number;
};
export type OpenClawPeerLinkAuditIssue = {
    packageName: string;
    packageDir: string;
    reason: string;
};
type AuditManagedNpmRootResult = {
    checked: number;
    broken: number;
    issues: OpenClawPeerLinkAuditIssue[];
};
export declare function auditOpenClawPeerDependencyLink(params: {
    packageDir: string;
    packageName?: string;
}): Promise<OpenClawPeerLinkAuditIssue | null>;
/**
 * Symlink the host openclaw package for plugins that declare it as a peer.
 * Plugin package managers still own third-party dependencies; this only wires
 * the host SDK package into the plugin-local Node graph.
 */
export declare function linkOpenClawPeerDependencies(params: {
    installedDir: string;
    peerDependencies: Record<string, string>;
    logger: PluginPeerLinkLogger;
}): Promise<{
    repaired: number;
    skipped: number;
}>;
export declare function relinkOpenClawPeerDependenciesInManagedNpmRoot(params: {
    npmRoot: string;
    logger: PluginPeerLinkLogger;
}): Promise<RelinkManagedNpmRootResult>;
export declare function auditOpenClawPeerDependenciesInManagedNpmRoot(params: {
    npmRoot: string;
}): Promise<AuditManagedNpmRootResult>;
export {};
