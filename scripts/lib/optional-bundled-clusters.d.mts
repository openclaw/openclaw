export const optionalBundledClusters: string[];
export const optionalBundledClusterSet: Set<string>;
export const OPTIONAL_BUNDLED_BUILD_ENV: string;
export function isOptionalBundledCluster(cluster: string): boolean;
export function shouldIncludeOptionalBundledClusters(env?: NodeJS.ProcessEnv): boolean;
export function shouldBuildBundledCluster(cluster: string, env?: NodeJS.ProcessEnv): boolean;
