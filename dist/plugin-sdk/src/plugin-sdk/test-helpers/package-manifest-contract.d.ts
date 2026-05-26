type PackageManifestContractParams = {
    pluginId: string;
    pluginLocalRuntimeDeps?: string[];
    minHostVersionBaseline?: string;
};
export declare function describePackageManifestContract(params: PackageManifestContractParams): void;
export {};
