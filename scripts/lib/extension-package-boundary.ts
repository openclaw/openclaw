import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const EXTENSION_PACKAGE_BOUNDARY_BASE_CONFIG =
  "extensions/tsconfig.package-boundary.base.json" as const;

export const EXTENSION_PACKAGE_BOUNDARY_INCLUDE = ["./*.ts", "./src/**/*.ts"] as const;
export const EXTENSION_PACKAGE_BOUNDARY_EXCLUDE = [
  "./**/*.test.ts",
  "./dist/**",
  "./node_modules/**",
  "./src/test-support/**",
  "./src/**/*test-helpers.ts",
  "./src/**/*test-harness.ts",
  "./src/**/*test-support.ts",
] as const;
export const EXTENSION_PACKAGE_BOUNDARY_BASE_PATHS = {
  "openclaw/extension-api": ["../src/extensionAPI.ts"],
  "openclaw/plugin-sdk": ["../dist/plugin-sdk/index.d.ts"],
  "openclaw/plugin-sdk/*": ["../dist/plugin-sdk/*.d.ts"],
  "@openclaw/*.js": ["../packages/plugin-sdk/dist/extensions/*.d.ts", "../extensions/*"],
  "@openclaw/*": ["../packages/plugin-sdk/dist/extensions/*", "../extensions/*"],
  "@openclaw/plugin-sdk/*": ["../dist/plugin-sdk/*.d.ts"],
} as const;

export type ExtensionPackageBoundaryTsConfigJson = {
  extends?: unknown;
  compilerOptions?: {
    rootDir?: unknown;
    paths?: unknown;
  };
  include?: unknown;
  exclude?: unknown;
};

export type ExtensionPackageBoundaryPackageJson = {
  devDependencies?: Record<string, string>;
};

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

export function collectBundledExtensionIds(rootDir = resolve(".")): string[] {
  return readdirSync(join(rootDir, "extensions"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

export function resolveExtensionTsconfigPath(extensionId: string, rootDir = resolve(".")): string {
  return join(rootDir, "extensions", extensionId, "tsconfig.json");
}

export function resolveExtensionPackageJsonPath(
  extensionId: string,
  rootDir = resolve("."),
): string {
  return join(rootDir, "extensions", extensionId, "package.json");
}

export function readExtensionPackageBoundaryTsconfig(
  extensionId: string,
  rootDir = resolve("."),
): ExtensionPackageBoundaryTsConfigJson {
  return readJsonFile<ExtensionPackageBoundaryTsConfigJson>(
    resolveExtensionTsconfigPath(extensionId, rootDir),
  );
}

export function readExtensionPackageBoundaryPackageJson(
  extensionId: string,
  rootDir = resolve("."),
): ExtensionPackageBoundaryPackageJson {
  return readJsonFile<ExtensionPackageBoundaryPackageJson>(
    resolveExtensionPackageJsonPath(extensionId, rootDir),
  );
}

export function isOptInExtensionPackageBoundaryTsconfig(
  tsconfig: ExtensionPackageBoundaryTsConfigJson,
): boolean {
  return tsconfig.extends === "../tsconfig.package-boundary.base.json";
}

export function collectExtensionsWithTsconfig(rootDir = resolve(".")): string[] {
  return collectBundledExtensionIds(rootDir).filter((extensionId) =>
    existsSync(resolveExtensionTsconfigPath(extensionId, rootDir)),
  );
}

export function collectOptInExtensionPackageBoundaries(rootDir = resolve(".")): string[] {
  return collectExtensionsWithTsconfig(rootDir).filter((extensionId) =>
    isOptInExtensionPackageBoundaryTsconfig(
      readExtensionPackageBoundaryTsconfig(extensionId, rootDir),
    ),
  );
}

export function renderExtensionPackageBoundaryTsconfig(params?: {
  paths?: Record<string, readonly string[]>;
}): {
  extends: "../tsconfig.package-boundary.base.json";
  compilerOptions: { rootDir: "."; paths?: Record<string, readonly string[]> };
  include: typeof EXTENSION_PACKAGE_BOUNDARY_INCLUDE;
  exclude: typeof EXTENSION_PACKAGE_BOUNDARY_EXCLUDE;
} {
  return {
    extends: "../tsconfig.package-boundary.base.json",
    compilerOptions: {
      rootDir: ".",
      ...(params?.paths
        ? {
            paths: {
              ...EXTENSION_PACKAGE_BOUNDARY_BASE_PATHS,
              ...params.paths,
            },
          }
        : {}),
    },
    include: EXTENSION_PACKAGE_BOUNDARY_INCLUDE,
    exclude: EXTENSION_PACKAGE_BOUNDARY_EXCLUDE,
  };
}
