import { isRecord } from "./record-shared.mjs";

export function listBundleDependencies(packageJson: unknown): string[] {
  if (!isRecord(packageJson)) {
    return [];
  }
  if (packageJson.bundleDependencies === true || packageJson.bundledDependencies === true) {
    return Object.keys(isRecord(packageJson.dependencies) ? packageJson.dependencies : {});
  }
  const bundleDependencies = Array.isArray(packageJson.bundleDependencies)
    ? packageJson.bundleDependencies
    : packageJson.bundledDependencies;
  return Array.isArray(bundleDependencies)
    ? bundleDependencies.filter((name): name is string => typeof name === "string")
    : [];
}
