type PluginPeerLinkLogger = {
    info?: (message: string) => void;
    warn?: (message: string) => void;
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
export {};
