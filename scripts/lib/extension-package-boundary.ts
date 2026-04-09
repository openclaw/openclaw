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
  "openclaw/plugin-sdk": ["../dist/plugin-sdk/src/plugin-sdk/index.d.ts"],
  "openclaw/plugin-sdk/*": ["../dist/plugin-sdk/src/plugin-sdk/*.d.ts"],
  "openclaw/plugin-sdk/account-id": ["../dist/plugin-sdk/src/plugin-sdk/account-id.d.ts"],
  "openclaw/plugin-sdk/channel-entry-contract": [
    "../packages/plugin-sdk/dist/src/plugin-sdk/channel-entry-contract.d.ts",
  ],
  "openclaw/plugin-sdk/browser-maintenance": [
    "../packages/plugin-sdk/dist/extensions/browser/browser-maintenance.d.ts",
  ],
  "openclaw/plugin-sdk/browser-config-runtime": [
    "../dist/plugin-sdk/src/plugin-sdk/browser-config-runtime.d.ts",
  ],
  "openclaw/plugin-sdk/browser-node-runtime": [
    "../dist/plugin-sdk/src/plugin-sdk/browser-node-runtime.d.ts",
  ],
  "openclaw/plugin-sdk/browser-setup-tools": [
    "../dist/plugin-sdk/src/plugin-sdk/browser-setup-tools.d.ts",
  ],
  "openclaw/plugin-sdk/browser-security-runtime": [
    "../dist/plugin-sdk/src/plugin-sdk/browser-security-runtime.d.ts",
  ],
  "openclaw/plugin-sdk/channel-secret-basic-runtime": [
    "../packages/plugin-sdk/dist/src/plugin-sdk/channel-secret-basic-runtime.d.ts",
  ],
  "openclaw/plugin-sdk/channel-secret-runtime": [
    "../dist/plugin-sdk/src/plugin-sdk/channel-secret-runtime.d.ts",
  ],
  "openclaw/plugin-sdk/channel-secret-tts-runtime": [
    "../packages/plugin-sdk/dist/src/plugin-sdk/channel-secret-tts-runtime.d.ts",
  ],
  "openclaw/plugin-sdk/channel-streaming": [
    "../dist/plugin-sdk/src/plugin-sdk/channel-streaming.d.ts",
  ],
  "openclaw/plugin-sdk/error-runtime": ["../dist/plugin-sdk/src/plugin-sdk/error-runtime.d.ts"],
  "openclaw/plugin-sdk/provider-catalog-shared": [
    "../packages/plugin-sdk/dist/src/plugin-sdk/provider-catalog-shared.d.ts",
  ],
  "openclaw/plugin-sdk/provider-entry": [
    "../packages/plugin-sdk/dist/src/plugin-sdk/provider-entry.d.ts",
  ],
  "openclaw/plugin-sdk/secret-ref-runtime": [
    "../dist/plugin-sdk/src/plugin-sdk/secret-ref-runtime.d.ts",
  ],
  "openclaw/plugin-sdk/ssrf-runtime": ["../dist/plugin-sdk/src/plugin-sdk/ssrf-runtime.d.ts"],
  "@openclaw/*.js": ["../packages/plugin-sdk/dist/extensions/*.d.ts", "../extensions/*"],
  "@openclaw/*": ["../packages/plugin-sdk/dist/extensions/*", "../extensions/*"],
  "@openclaw/plugin-sdk/*": ["../dist/plugin-sdk/src/plugin-sdk/*.d.ts"],
} as const;

const XAI_FORBIDDEN_LEGACY_PLUGIN_SDK_EXACT_PATH = [
  "./.boundary-stubs/forbidden-openclaw-plugin-sdk.d.ts",
] as const;
const XAI_FORBIDDEN_LEGACY_PLUGIN_SDK_WILDCARD_PATH = [
  "./.boundary-stubs/forbidden-openclaw-plugin-sdk-*.d.ts",
] as const;

export const EXTENSION_PACKAGE_BOUNDARY_XAI_PATHS = {
  "openclaw/extension-api": ["../../src/extensionAPI.ts"],
  "openclaw/plugin-sdk": [...XAI_FORBIDDEN_LEGACY_PLUGIN_SDK_EXACT_PATH],
  "openclaw/plugin-sdk/*": [...XAI_FORBIDDEN_LEGACY_PLUGIN_SDK_WILDCARD_PATH],
  "openclaw/plugin-sdk/account-id": [...XAI_FORBIDDEN_LEGACY_PLUGIN_SDK_EXACT_PATH],
  "openclaw/plugin-sdk/channel-entry-contract": [...XAI_FORBIDDEN_LEGACY_PLUGIN_SDK_EXACT_PATH],
  "openclaw/plugin-sdk/browser-maintenance": [...XAI_FORBIDDEN_LEGACY_PLUGIN_SDK_EXACT_PATH],
  "openclaw/plugin-sdk/browser-config-runtime": [...XAI_FORBIDDEN_LEGACY_PLUGIN_SDK_EXACT_PATH],
  "openclaw/plugin-sdk/browser-node-runtime": [...XAI_FORBIDDEN_LEGACY_PLUGIN_SDK_EXACT_PATH],
  "openclaw/plugin-sdk/browser-setup-tools": [...XAI_FORBIDDEN_LEGACY_PLUGIN_SDK_EXACT_PATH],
  "openclaw/plugin-sdk/browser-security-runtime": [...XAI_FORBIDDEN_LEGACY_PLUGIN_SDK_EXACT_PATH],
  "openclaw/plugin-sdk/channel-secret-runtime": [...XAI_FORBIDDEN_LEGACY_PLUGIN_SDK_EXACT_PATH],
  "openclaw/plugin-sdk/channel-streaming": [...XAI_FORBIDDEN_LEGACY_PLUGIN_SDK_EXACT_PATH],
  "openclaw/plugin-sdk/cli-runtime": [...XAI_FORBIDDEN_LEGACY_PLUGIN_SDK_EXACT_PATH],
  "openclaw/plugin-sdk/error-runtime": [...XAI_FORBIDDEN_LEGACY_PLUGIN_SDK_EXACT_PATH],
  "openclaw/plugin-sdk/provider-catalog-shared": [...XAI_FORBIDDEN_LEGACY_PLUGIN_SDK_EXACT_PATH],
  "openclaw/plugin-sdk/provider-env-vars": [...XAI_FORBIDDEN_LEGACY_PLUGIN_SDK_EXACT_PATH],
  "openclaw/plugin-sdk/provider-entry": [...XAI_FORBIDDEN_LEGACY_PLUGIN_SDK_EXACT_PATH],
  "openclaw/plugin-sdk/provider-web-search-contract": [
    ...XAI_FORBIDDEN_LEGACY_PLUGIN_SDK_EXACT_PATH,
  ],
  "openclaw/plugin-sdk/secret-ref-runtime": [...XAI_FORBIDDEN_LEGACY_PLUGIN_SDK_EXACT_PATH],
  "openclaw/plugin-sdk/ssrf-runtime": [...XAI_FORBIDDEN_LEGACY_PLUGIN_SDK_EXACT_PATH],
  "@openclaw/*.js": ["../../packages/plugin-sdk/dist/extensions/*.d.ts", "../*"],
  "@openclaw/*": ["../*"],
  "@openclaw/plugin-sdk/*": ["../../dist/plugin-sdk/src/plugin-sdk/*.d.ts"],
  "@openclaw/anthropic-vertex/api.js": ["./.boundary-stubs/anthropic-vertex-api.d.ts"],
  "@openclaw/ollama/api.js": ["./.boundary-stubs/ollama-api.d.ts"],
  "@openclaw/ollama/runtime-api.js": ["./.boundary-stubs/ollama-runtime-api.d.ts"],
  "@openclaw/speech-core/runtime-api.js": ["./.boundary-stubs/speech-core-runtime-api.d.ts"],
} as const;

export type ExtensionPackageBoundaryTsConfigJson = {
  extends?: unknown;
  compilerOptions?: {
    rootDir?: unknown;
    paths?: Record<string, readonly string[]>;
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
