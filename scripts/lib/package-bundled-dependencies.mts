import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { coerceErrorMessage } from "./error-format.mts";
import {
  collectPatchedMcpArtifactErrors,
  isSupportedPatchedMcpVersion,
  PATCHED_MCP_CLI,
  PATCHED_MCP_NAME,
} from "./package-bundled-mcp.mts";
import { collectPackageDistImportErrors } from "./package-dist-imports.mjs";
import { isRecord } from "./record-shared.mjs";

type BundledPackage = {
  entries: ReadonlySet<string>;
  files: string[];
  name: string;
  packageRoot: string;
  readText: (relativePath: string) => string;
};
// Strict Docker artifacts bundle this private runtime rather than resolving it
// from npm. Keep the concrete load-bearing entries explicit instead of
// reimplementing Node's conditional package-exports resolver here.
const REQUIRED_AI_RUNTIME_ENTRIES = [
  { subpath: "", whenExported: false },
  { subpath: "providers", whenExported: false },
  { subpath: "transports", whenExported: true },
  { subpath: "internal/openai-completions-compat", whenExported: true },
  { subpath: "internal/openai-responses-payload-policy", whenExported: true },
  { subpath: "internal/runtime", whenExported: false },
  { subpath: "internal/tool-schema", whenExported: true },
].map(({ subpath, whenExported }) => ({
  specifier: subpath ? `@openclaw/ai/${subpath}` : "@openclaw/ai",
  entry: `dist/${subpath || "index"}.mjs`,
  whenExported: whenExported ? `./${subpath}` : undefined,
}));

function listBundleDependencies(packageJson: unknown): string[] {
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

function resolveBundledPackageSpecifiers(
  packageRoot: string,
  specifiers: string[],
): Record<string, string> | null {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const resolutions = {};
for (const specifier of JSON.parse(process.argv[1])) {
  try {
    resolutions[specifier] = import.meta.resolve(specifier);
  } catch {
    resolutions[specifier] = "";
  }
}
process.stdout.write(JSON.stringify(resolutions));`,
      JSON.stringify(specifiers),
    ],
    { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    return null;
  }
  try {
    return JSON.parse(result.stdout) as Record<string, string>;
  } catch {
    return null;
  }
}

function collectBundledAiRuntimeErrors(
  { name, entries, files, packageRoot, readText }: BundledPackage,
  bundledPackageJson: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  const packagePrefix = `node_modules/${name}/`;
  const packageExports = isRecord(bundledPackageJson.exports) ? bundledPackageJson.exports : {};
  // Trusted current-main harnesses validate frozen release targets. Require
  // post-cut runtime subpaths only when the candidate manifest owns them.
  const runtimeEntries = REQUIRED_AI_RUNTIME_ENTRIES.filter(
    ({ whenExported }) => !whenExported || Object.hasOwn(packageExports, whenExported),
  );
  const resolutions = resolveBundledPackageSpecifiers(
    packageRoot,
    runtimeEntries.map(({ specifier }) => specifier),
  );
  if (!resolutions) {
    errors.push(`bundled ${name} runtime specifier resolution failed`);
  }
  for (const { entry, specifier } of runtimeEntries) {
    if (!entries.has(`${packagePrefix}${entry}`)) {
      errors.push(`bundled ${name} is missing required runtime entry ${entry}`);
    }
    const resolvedUrl = resolutions?.[specifier] ?? "";
    if (!resolvedUrl) {
      errors.push(`bundled ${name} runtime specifier ${specifier} is not resolvable`);
      continue;
    }
    const expectedUrl = pathToFileURL(path.join(packageRoot, packagePrefix, entry)).href;
    if (resolvedUrl !== expectedUrl) {
      errors.push(
        `bundled ${name} runtime specifier ${specifier} resolves to ${resolvedUrl} instead of ${expectedUrl}`,
      );
    }
  }
  const bundledFiles = files
    .filter((file) => file.startsWith(packagePrefix))
    .map((file) => file.slice(packagePrefix.length));
  errors.push(
    ...collectPackageDistImportErrors({
      files: bundledFiles,
      readText: (file: string) => readText(`${packagePrefix}${file}`),
    }).map((error) => `bundled ${name} ${error}`),
  );
  return errors;
}

function collectPatchedMcpErrors(
  { entries, packageRoot, readText }: BundledPackage,
  manifest: Record<string, unknown>,
  declaredVersion: unknown,
): string[] {
  const prefix = `node_modules/${PATCHED_MCP_NAME}/`;
  const errors = collectPatchedMcpArtifactErrors({
    declaredVersion,
    manifest,
    files: new Set(
      [...entries]
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => entry.slice(prefix.length)),
    ),
    sha256: (file) =>
      createHash("sha256")
        .update(readText(`${prefix}${file}`))
        .digest("hex"),
  });
  const specifier = `${PATCHED_MCP_NAME}/${PATCHED_MCP_CLI}`;
  const resolved = resolveBundledPackageSpecifiers(packageRoot, [specifier]);
  if (
    resolved?.[specifier] !== pathToFileURL(path.join(packageRoot, prefix, PATCHED_MCP_CLI)).href
  ) {
    errors.push(`bundled ${PATCHED_MCP_NAME} CLI does not resolve inside its bundled package`);
  }
  return errors;
}

export function collectBundledDependencyErrors({
  packageJson,
  requireBundledWorkspaceDeps = false,
  ...runtime
}: Omit<BundledPackage, "name"> & {
  packageJson: unknown;
  requireBundledWorkspaceDeps?: boolean;
}): string[] {
  if (!isRecord(packageJson)) {
    return [];
  }
  const errors: string[] = [];
  const dependencies = isRecord(packageJson.dependencies) ? packageJson.dependencies : {};
  const bundledDependencies = new Set(listBundleDependencies(packageJson));
  const required = new Map<string, string>([
    [PATCHED_MCP_NAME, "its patched runtime must not be replaced by the registry package"],
  ]);
  if (requireBundledWorkspaceDeps) {
    required.set("@openclaw/ai", "it is private to the OpenClaw workspace");
  }
  const names = new Set(bundledDependencies);
  for (const [name, reason] of required) {
    if (typeof dependencies[name] !== "string") {
      continue;
    }
    names.add(name);
    if (!bundledDependencies.has(name)) {
      errors.push(
        `package.json dependencies.${name} must be listed in bundleDependencies because ${reason}`,
      );
    }
  }
  if (
    names.has(PATCHED_MCP_NAME) &&
    !isSupportedPatchedMcpVersion(dependencies[PATCHED_MCP_NAME])
  ) {
    errors.push(
      `package.json dependencies.${PATCHED_MCP_NAME} must be pinned to a supported patched version`,
    );
  }
  for (const name of names) {
    const manifestPath = `node_modules/${name}/package.json`;
    if (!runtime.entries.has(manifestPath)) {
      errors.push(`package.json dependencies.${name} must be bundled in node_modules/${name}`);
      continue;
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(runtime.readText(manifestPath));
    } catch (error) {
      errors.push(`unreadable bundled ${name} package.json: ${coerceErrorMessage(error)}`);
      continue;
    }
    if (!isRecord(manifest) || manifest.name !== name) {
      errors.push(`bundled ${name} package.json must name ${name}`);
      continue;
    }
    // npm infers peers of bundled packages are already in the bundle, while
    // packlist excludes them unless explicitly bundled. Missing peers are not
    // installed, even when the root declares them as required dependencies.
    const peers = isRecord(manifest.peerDependencies) ? manifest.peerDependencies : {};
    for (const peer of Object.keys(peers)) {
      if (
        typeof dependencies[peer] === "string" &&
        !runtime.entries.has(`node_modules/${peer}/package.json`)
      ) {
        errors.push(`bundled ${name} is missing its root dependency peer ${peer}`);
      }
    }
    const bundled = { ...runtime, name };
    if (name === PATCHED_MCP_NAME) {
      errors.push(...collectPatchedMcpErrors(bundled, manifest, dependencies[PATCHED_MCP_NAME]));
    } else if (name === "@openclaw/ai") {
      errors.push(...collectBundledAiRuntimeErrors(bundled, manifest));
    }
  }
  return errors;
}
