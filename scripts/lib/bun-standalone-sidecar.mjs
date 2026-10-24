import fs from "node:fs";
import path from "node:path";

const developmentFile = /(?:\.map|\.d\.[cm]?ts|\.tsbuildinfo)$/;

export function isStandalonePrivateDocumentation(name) {
  return (
    name === "docs/internal" ||
    name.startsWith("docs/internal/") ||
    /^docs\/(?:AGENTS|CLAUDE)\.md$/.test(name)
  );
}

/** Disk resources have owners; compiled modules never become a second code distribution. */
export function standaloneResourceCategory(name, declaredPluginAssets = new Set()) {
  if (developmentFile.test(name) || isStandalonePrivateDocumentation(name)) {
    return undefined;
  }
  if (name === "LICENSE" || name === "THIRD_PARTY_NOTICES.md") {
    return "licenses";
  }
  if (/^dist\/[^/]+\.LICENSE$/.test(name)) {
    return "licenses";
  }
  if (name.startsWith("docs/reference/templates/") || name.startsWith("dist/export-html/")) {
    return "templates";
  }
  if (name === "docs/docs.json" || (name.startsWith("docs/") && /\.mdx?$/.test(name))) {
    return "docs";
  }
  if (name.startsWith("skills/") || name.startsWith("custodian-skills/")) {
    return "skills";
  }
  if (name.startsWith("dist/control-ui/")) {
    return "controlUi";
  }
  if (name.startsWith("dist/assets/") || name.startsWith("dist/canvas-host/a2ui/")) {
    return "runtimeAssets";
  }
  if (/^dist\/bundled\/[^/]+\/HOOK\.md$/.test(name)) {
    return "hookMetadata";
  }
  if (
    /^(?:dist\/extensions|extensions|packages)\/.+\/(?:package|openclaw\.plugin)\.json$/.test(name)
  ) {
    return "pluginMetadata";
  }
  if (
    /^dist\/extensions\/[^/]+\/(?:assets|skills|bundled-skills|templates|web\/dist|dist\/control-ui|chrome-extension)\//.test(
      name,
    )
  ) {
    return "pluginAssets";
  }
  // Declared host child scripts stay embedded and use the standalone child dispatcher.
  if (declaredPluginAssets.has(name) && !/\.[cm]?js$/.test(name)) {
    return "pluginAssets";
  }
  if (/^dist\/extensions\/[^/]+\/.+\.(?:json|md|sql|wasm)$/.test(name)) {
    return "pluginAssets";
  }
  if (/^dist\/[^/]+\.(?:wasm|ttf|otf)$/.test(name)) {
    return "runtimeAssets";
  }
  if (
    name === "package.json" ||
    name === "openclaw-install-owner.json" ||
    /^dist\/(?:build-info\.json|cli-startup-metadata\.json|channel-catalog\.json|runtime-dependency-ownership\.json|\.buildstamp|\.runtime-postbuildstamp)$/.test(
      name,
    )
  ) {
    return "runtimeMetadata";
  }
  return undefined;
}

function walk(root, callback, relative = "") {
  for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${item.name}` : item.name;
    if (item.isDirectory()) {
      walk(root, callback, name);
    } else {
      callback(name, item.isSymbolicLink());
    }
  }
}

/** Validate the resource plan while the complete build snapshot is still available. */
export function planStandaloneRuntime(
  root,
  dependencyResources = [],
  declaredPluginAssets = new Set(),
  metadataDirectories = [],
) {
  const resources = new Map();
  let originalFiles = 0;
  let originalBytes = 0;
  let removedSymlinks = 0;
  walk(root, (name, symlink) => {
    if (symlink) {
      removedSymlinks += 1;
    } else {
      originalFiles += 1;
      originalBytes += fs.statSync(path.join(root, name)).size;
    }
    if (name.split("/").includes("node_modules")) {
      return;
    }
    const category = standaloneResourceCategory(name, declaredPluginAssets);
    if (category) {
      resources.set(name, { source: name, category });
    }
  });
  for (const resource of dependencyResources) {
    const { source, destination, category } = resource;
    for (const name of [source, destination]) {
      if (!name || path.posix.isAbsolute(name) || name.split("/").includes("..")) {
        throw new Error(`Invalid standalone resource path: ${name}`);
      }
    }
    if (resources.has(destination)) {
      throw new Error(`Duplicate standalone resource: ${destination}`);
    }
    resources.set(destination, { source, category });
  }
  /** @type {Record<string, { files: number, bytes: number }>} */
  const categories = {};
  const files = [];
  const directories = new Set();
  let retainedBytes = 0;
  const canonicalRoot = fs.realpathSync(root) + path.sep;
  for (const [destination, { source, category }] of resources) {
    const filename = fs.realpathSync(path.join(root, source));
    const stat = fs.statSync(filename);
    if (!filename.startsWith(canonicalRoot) || !stat.isFile()) {
      throw new Error(`Standalone resource is not a contained regular file: ${source}`);
    }
    files.push({ source: filename, destination });
    const counts = (categories[category] ??= { files: 0, bytes: 0 });
    counts.files += 1;
    counts.bytes += stat.size;
    retainedBytes += stat.size;
  }
  // SDK metadata fallback and plugin discovery still inspect these directory boundaries.
  for (const directory of ["scripts", "dist/extensions/node_modules"]) {
    if (!fs.existsSync(path.join(root, directory))) {
      continue;
    }
    const source = fs.realpathSync(path.join(root, directory));
    if (!source.startsWith(canonicalRoot) || !fs.statSync(source).isDirectory()) {
      throw new Error(`Standalone resolution path is not a contained directory: ${directory}`);
    }
    directories.add(directory);
  }
  // Keep discovery's directory shape without embedded modules or pnpm namespaces.
  for (const directory of metadataDirectories) {
    const parts = directory.split("/");
    if (
      !["dist", "extensions", "packages"].includes(parts[0]) ||
      parts.some((part) => !part || part === "." || part === ".." || part === "node_modules")
    ) {
      throw new Error(`Invalid standalone metadata directory: ${directory}`);
    }
    const source = fs.realpathSync(path.join(root, directory));
    if (!source.startsWith(canonicalRoot) || !fs.statSync(source).isDirectory()) {
      throw new Error(`Standalone metadata path is not a contained directory: ${directory}`);
    }
    directories.add(directory);
  }
  return {
    root,
    files,
    directories,
    pruning: {
      policy: "runtime-resources-v1",
      removedFiles: originalFiles - files.length,
      removedBytes: originalBytes - retainedBytes,
      removedSymlinks,
      categories,
      sidecarPlugins: [],
    },
  };
}

/**
 * Replace the snapshot after compilation using the already validated resource plan.
 * @param {ReturnType<typeof planStandaloneRuntime>} plan
 */
export function pruneStandaloneRuntime(plan) {
  const { root, files, directories, pruning } = plan;
  const minimal = fs.mkdtempSync(path.join(path.dirname(root), ".standalone-resources-"));
  try {
    for (const { source, destination } of files) {
      const output = path.join(minimal, destination);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.copyFileSync(source, output, fs.constants.COPYFILE_FICLONE);
    }
    for (const directory of directories) {
      fs.mkdirSync(path.join(minimal, directory), { recursive: true });
    }
    fs.rmSync(root, { recursive: true });
    fs.renameSync(minimal, root);
  } finally {
    fs.rmSync(minimal, { recursive: true, force: true });
  }
  return pruning;
}
