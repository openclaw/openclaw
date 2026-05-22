type PluginPeerLinkLogger = {
    info?: (message: string) => void;
    warn?: (message: string) => void;
};
type RelinkManagedNpmRootResult = {
    checked: number;
    attempted: number;
};
/**
 * Symlink the host openclaw package for plugins that declare it as a peer.
 * Plugin package managers still own third-party dependencies; this only wires
 * the host SDK package into the plugin-local Node graph.
 */
export declare function linkOpenClawPeerDependencies(params: {
    installedDir: string;
    peerDependencies: Record<string, string>;
    logger: PluginPeerLinkLogger;
}): Promise<void>;
export declare function relinkOpenClawPeerDependenciesInManagedNpmRoot(params: {
    npmRoot: string;
    logger: PluginPeerLinkLogger;
}): Promise<RelinkManagedNpmRootResult>;
export {};
