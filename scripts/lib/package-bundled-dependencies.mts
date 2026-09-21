import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { coerceErrorMessage } from "./error-format.mts";
import { collectPackageDistImportErrors } from "./package-dist-imports.mjs";
import { isRecord } from "./record-shared.mjs";

const PATCHED_MCP_NAME = "chrome-devtools-mcp";
const PATCHED_MCP_VERSION = "1.8.0";
const PATCHED_MCP_CLI = "build/src/bin/chrome-devtools-mcp.js";
// pnpm patches installed bytes; npm consumers must receive that same runtime.
const REQUIRED_MCP_FILE_HASHES = new Map([
  [PATCHED_MCP_CLI, "9f380d06e1ac05b257e27e708c0cc4b4ba190e285ed6eb6c8aa50978d98a12c5"],
  [
    "build/src/bin/chrome-devtools-mcp-main.js",
    "fc383cb3e5db5f18cf1e8c49221212c669825248874ba91c90ba9035e175f5b4",
  ],
  ["LICENSE", "58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd"],
  [
    "build/src/third_party/THIRD_PARTY_NOTICES",
    "8f10277934fe6888173f41f7cbbd9112d208c8c931bf163db59110f69f119e53",
  ],
  ["build/src/TextSnapshot.js", "299833ad0e4cfc171a417afaec41df594e4862fe53a7ada6ba160409f979788b"],
  ["build/src/McpPage.js", "b9e791d758e4d28589525e2d427600e24b271d365a5879893a392043a11cf426"],
  [
    "build/src/third_party/index.js",
    "a8f5cb1e02405d347117114141b58572f71c083861fb50ab31a27511e3a279bf",
  ],
  [
    "build/src/OPENCLAW_PATCH_NOTICE.md",
    "8f5a32aaedf4bb6f8ad39f226bd343bf804132c11ebc6c3c19f667669856287c",
  ],
]);
const REQUIRED_MCP_FILES = [
  "build/src/third_party/devtools-formatter-worker.js",
  "build/src/third_party/devtools-heap-snapshot-worker.js",
  "build/src/third_party/lighthouse-devtools-mcp-bundle.js",
  "build/src/third_party/bundled-packages.json",
];

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
const REQUIRED_BUNDLED_WORKSPACE_RUNTIME_ENTRIES = new Map([
  [
    "@openclaw/ai",
    [
      { specifier: "@openclaw/ai", entry: "dist/index.mjs" },
      { specifier: "@openclaw/ai/providers", entry: "dist/providers.mjs" },
      {
        specifier: "@openclaw/ai/transports",
        entry: "dist/transports.mjs",
        whenExported: "./transports",
      },
      {
        specifier: "@openclaw/ai/internal/openai-completions-compat",
        entry: "dist/internal/openai-completions-compat.mjs",
        whenExported: "./internal/openai-completions-compat",
      },
      {
        specifier: "@openclaw/ai/internal/openai-responses-payload-policy",
        entry: "dist/internal/openai-responses-payload-policy.mjs",
        whenExported: "./internal/openai-responses-payload-policy",
      },
      {
        specifier: "@openclaw/ai/internal/runtime",
        entry: "dist/internal/runtime.mjs",
      },
      {
        specifier: "@openclaw/ai/internal/tool-schema",
        entry: "dist/internal/tool-schema.mjs",
        whenExported: "./internal/tool-schema",
      },
    ],
  ],
]);

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

function collectBundledPackageRuntimeErrors(
  { name, entries, files, packageRoot, readText }: BundledPackage,
  bundledPackageJson: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  const packagePrefix = `node_modules/${name}/`;
  const packageExports = isRecord(bundledPackageJson.exports) ? bundledPackageJson.exports : {};
  // Trusted current-main harnesses validate frozen release targets. Require
  // post-cut runtime subpaths only when the candidate manifest owns them.
  const runtimeEntries = (REQUIRED_BUNDLED_WORKSPACE_RUNTIME_ENTRIES.get(name) ?? []).filter(
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
): string[] {
  const errors: string[] = [];
  const prefix = `node_modules/${PATCHED_MCP_NAME}/`;
  if (manifest.version !== PATCHED_MCP_VERSION || manifest.type !== "module") {
    errors.push(`bundled ${PATCHED_MCP_NAME} must be ESM version ${PATCHED_MCP_VERSION}`);
  }
  if (!isRecord(manifest.bin) || manifest.bin[PATCHED_MCP_NAME] !== `./${PATCHED_MCP_CLI}`) {
    errors.push(`bundled ${PATCHED_MCP_NAME} must expose CLI ${PATCHED_MCP_CLI}`);
  }
  for (const file of [...REQUIRED_MCP_FILES, ...REQUIRED_MCP_FILE_HASHES.keys()]) {
    if (!entries.has(`${prefix}${file}`)) {
      errors.push(`bundled ${PATCHED_MCP_NAME} is missing required runtime entry ${file}`);
      continue;
    }
    const expectedHash = REQUIRED_MCP_FILE_HASHES.get(file);
    if (
      expectedHash &&
      createHash("sha256")
        .update(readText(`${prefix}${file}`))
        .digest("hex") !== expectedHash
    ) {
      errors.push(`bundled ${PATCHED_MCP_NAME} has unpatched or changed runtime entry ${file}`);
    }
  }
  if (
    ![...entries].some(
      (entry) =>
        entry.startsWith(`${prefix}build/src/third_party/issue-descriptions/`) &&
        entry.endsWith(".md"),
    )
  ) {
    errors.push(`bundled ${PATCHED_MCP_NAME} is missing third-party issue descriptions`);
  }
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
    typeof dependencies[PATCHED_MCP_NAME] === "string" &&
    dependencies[PATCHED_MCP_NAME] !== PATCHED_MCP_VERSION
  ) {
    errors.push(
      `package.json dependencies.${PATCHED_MCP_NAME} must be pinned to ${PATCHED_MCP_VERSION}`,
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
    const bundled = { ...runtime, name };
    if (name === PATCHED_MCP_NAME) {
      errors.push(...collectPatchedMcpErrors(bundled, manifest));
    } else if (REQUIRED_BUNDLED_WORKSPACE_RUNTIME_ENTRIES.has(name)) {
      errors.push(...collectBundledPackageRuntimeErrors(bundled, manifest));
    }
  }
  return errors;
}
