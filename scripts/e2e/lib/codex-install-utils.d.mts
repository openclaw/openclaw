export function stateDir(): string;
export function configPath(): string;
export function managedNpmRoot(): string;
export function realPathMaybe(filePath: unknown): string;
export function assertPathInside(parentPath: unknown, childPath: unknown, label: unknown): void;
export function readInstallRecords(fallbackRecords?: Record<string, unknown>): unknown;
export function npmProjectRootForInstalledPackage(
  installPath: unknown,
  packageName: unknown,
): string;
export function findPackageJson(packageName: unknown, roots: unknown): unknown;
export { readJson };
import { readJson } from "./fixtures/common.mjs";
