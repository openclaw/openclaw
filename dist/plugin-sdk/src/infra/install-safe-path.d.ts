import "./fs-safe-defaults.js";
export { assertCanonicalPathWithinBase, resolveSafeInstallDir, safeDirName, safePathSegmentHashed, } from "@openclaw/fs-safe/advanced";
export declare function unscopedPackageName(name: string): string;
export declare function packageNameMatchesId(packageName: string, id: string): boolean;
