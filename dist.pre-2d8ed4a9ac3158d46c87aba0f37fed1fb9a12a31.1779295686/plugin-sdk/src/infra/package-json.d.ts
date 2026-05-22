type PackageJson = {
    name?: unknown;
    packageManager?: unknown;
    version?: unknown;
};
export declare function readPackageJson(root: string): Promise<PackageJson | null>;
export declare function readPackageVersion(root: string): Promise<string | null>;
export declare function readPackageName(root: string): Promise<string | null>;
export declare function readPackageManagerSpec(root: string): Promise<string | null>;
export {};
