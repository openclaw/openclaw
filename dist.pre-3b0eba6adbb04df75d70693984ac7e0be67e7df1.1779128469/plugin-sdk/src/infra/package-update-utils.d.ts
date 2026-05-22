export declare function expectedIntegrityForUpdate(spec: string | undefined, integrity: string | undefined): string | undefined;
export declare function readInstalledPackageVersion(dir: string): Promise<string | undefined>;
export declare function readInstalledPackagePeerDependencies(dir: string): Record<string, string>;
export declare function installedPackageNeedsOpenClawPeerLinkRepair(dir: string): boolean;
