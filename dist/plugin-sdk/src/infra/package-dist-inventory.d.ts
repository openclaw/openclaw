export { LOCAL_BUILD_METADATA_DIST_PATHS } from "../../scripts/lib/local-build-metadata-paths.mjs";
export declare const PACKAGE_DIST_INVENTORY_RELATIVE_PATH = "dist/postinstall-inventory.json";
export declare function isLegacyPluginDependencyInstallStagePath(relativePath: string): boolean;
export declare function collectPackageDistInventory(packageRoot: string): Promise<string[]>;
export declare function collectLegacyPluginDependencyStagingDebrisPaths(packageRoot: string): Promise<string[]>;
export declare function assertNoLegacyPluginDependencyStagingDebris(packageRoot: string): Promise<void>;
export declare function writePackageDistInventory(packageRoot: string): Promise<string[]>;
export declare function readPackageDistInventoryIfPresent(packageRoot: string): Promise<string[] | null>;
export declare function collectPackageDistInventoryErrors(packageRoot: string): Promise<string[]>;
